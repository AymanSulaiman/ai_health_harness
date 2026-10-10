"""Build the ground truth: what a correct summary of each living patient must contain.

Reads the raw_fhir tables in data/warehouse.duckdb and writes data/ground_truth.jsonl,
one record per living patient as of the simulation end date. Every record is validated
against schemas/ground_truth.schema.json, the contract the TypeScript harness reads.

- medications: active MedicationRequests, with dose and timing when Synthea recorded them
- allergies: active AllergyIntolerances, with their reactions
- conditions: active Conditions, minus social and administrative ones (NON_CLINICAL)

    uv run python -m ai_health_harness.ground_truth spot-check [SEED]   # 10 records vs raw FHIR
"""

import datetime as dt
import json
import random
import sys
from collections import defaultdict
from pathlib import Path

import duckdb
import jsonschema

from ai_health_harness import synthea

OUT = Path("data/ground_truth.jsonl")
SCHEMA = Path(__file__).parents[2] / "schemas" / "ground_truth.schema.json"
AS_OF = dt.date.fromisoformat(synthea.SIMULATION_END).isoformat()

# Synthea records social determinants and admin reminders as active Conditions, and
# marks every Condition with the same category, so they can only be told apart by code.
# Reviewed against every active non-disorder condition in the seed-42 population.
# ponytail: a deny-list, so a new social code from another Synthea version or seed would
# count as clinical; review the active non-disorder codes again after either changes.
NON_CLINICAL = {
    "160903007",  # Full-time employment
    "160904001",  # Part-time employment
    "73438004",  # Unemployed
    "741062008",  # Not in labor force
    "1187604002",  # Serving in military service
    "224299000",  # Received higher education
    "473461003",  # Educated to high school level
    "224295006",  # Only received primary school education
    "32911000",  # Homeless
    "105531004",  # Housing unsatisfactory
    "713458007",  # Lack of access to transportation
    "266934004",  # Transport problem
    "423315002",  # Limited social contact
    "422650009",  # Social isolation
    "73595000",  # Stress (Synthea's social-determinants module, not a diagnosis)
    "266948004",  # Has a criminal record
    "446654005",  # Refugee
    "424393004",  # Reports of violence in the environment
    "706893006",  # Victim of intimate partner abuse
    "160968000",  # Risk activity involvement
    "314529007",  # Medication review due
}

MEDICATIONS = """
SELECT split_part(m.subject.reference, '/', 2) AS patient_id,
       m.medicationCodeableConcept.coding[1].display AS name,
       m.medicationCodeableConcept.coding[1].code AS rxnorm,
       m.dosageInstruction[1].asNeededBoolean AS as_needed,
       m.dosageInstruction[1].doseAndRate[1].doseQuantity.value AS dose,
       m.dosageInstruction[1].timing.repeat.frequency AS frequency,
       m.dosageInstruction[1].timing.repeat.period AS period,
       m.dosageInstruction[1].timing.repeat.periodUnit AS period_unit
FROM raw_fhir.medication_request m
WHERE m.status = 'active'
"""
ALLERGIES = """
SELECT split_part(a.patient.reference, '/', 2) AS patient_id,
       a.code.coding[1].display AS substance,
       a.code.coding[1].code AS snomed,
       a.category[1] AS category,
       a.type AS type,
       a.reaction AS reaction
FROM raw_fhir.allergy_intolerance a
WHERE a.clinicalStatus.coding[1].code = 'active'
"""
CONDITIONS = """
SELECT split_part(c.subject.reference, '/', 2) AS patient_id,
       c.code.coding[1].display AS name,
       c.code.coding[1].system AS system,
       c.code.coding[1].code AS code,
       CAST(c.onsetDateTime AS DATE) AS onset
FROM raw_fhir.condition c
WHERE c.clinicalStatus.coding[1].code = 'active'
"""


def rows(
    con: duckdb.DuckDBPyConnection, sql: str, params: list | None = None
) -> list[dict]:
    found = con.execute(sql, params or []).fetchall()
    columns = [c[0] for c in con.description or []]
    return [dict(zip(columns, row)) for row in found]


def medication(row: dict) -> dict:
    timing = None
    if row["frequency"] is not None:
        timing = {
            "frequency": row["frequency"],
            "period": row["period"],
            "period_unit": row["period_unit"],
        }
    return {
        "name": row["name"],
        "rxnorm": row["rxnorm"],
        "as_needed": row["as_needed"],
        "dose": row["dose"],
        "timing": timing,
    }


def allergy(row: dict) -> dict:
    return {
        "substance": row["substance"],
        "snomed": row["snomed"],
        "category": row["category"],
        "type": row["type"],
        "reactions": [
            {
                "manifestation": r["manifestation"][0]["coding"][0]["display"],
                "severity": r["severity"],
            }
            for r in row["reaction"] or []
        ],
    }


def condition(row: dict) -> dict:
    onset = row["onset"]
    return {
        "name": row["name"],
        "system": row["system"],
        "code": row["code"],
        "onset": onset.isoformat() if onset else None,
    }


def build(db: Path = synthea.WAREHOUSE) -> list[dict]:
    """One validated record per living patient, sorted by patient id."""
    with duckdb.connect(db, read_only=True) as con:
        living = [
            r["id"]
            for r in rows(
                con,
                "SELECT CAST(id AS VARCHAR) AS id FROM raw_fhir.patient"
                " WHERE deceasedDateTime IS NULL ORDER BY id",
            )
        ]
        sections = {
            "medications": (rows(con, MEDICATIONS), medication, "name"),
            "allergies": (rows(con, ALLERGIES), allergy, "substance"),
            "conditions": (
                [r for r in rows(con, CONDITIONS) if r["code"] not in NON_CLINICAL],
                condition,
                "name",
            ),
        }
    records = {
        pid: {"patient_id": pid, "as_of": AS_OF} | {s: [] for s in sections}
        for pid in living
    }
    for name, (found, shape, sort_key) in sections.items():
        by_patient = defaultdict(list)
        for row in found:
            by_patient[row["patient_id"]].append(shape(row))
        for pid, record in records.items():
            record[name] = sorted(by_patient[pid], key=lambda item: item[sort_key])
    validator = jsonschema.Draft202012Validator(json.loads(SCHEMA.read_text()))
    for record in records.values():
        validator.validate(
            record
        )  # raises on the first record that breaks the contract
    return list(records.values())


def write(records: list[dict], out: Path = OUT) -> None:
    out.parent.mkdir(parents=True, exist_ok=True)
    with out.open("w") as f:
        f.writelines(json.dumps(record) + "\n" for record in records)


def run(db: Path = synthea.WAREHOUSE, out: Path = OUT) -> list[dict]:
    records = build(db)
    write(records, out)
    counts = {
        s: sum(len(r[s]) for r in records)
        for s in ("medications", "allergies", "conditions")
    }
    print(f"{len(records)} ground-truth records -> {out} ({counts})")
    return records


def pick(records: list[dict], n: int, seed: int, with_allergies: int) -> list[dict]:
    """n records drawn at random, at least `with_allergies` of them with an allergy.

    About one living patient in five has an allergy, so a plain random 10 often holds
    one or none, and a missed allergy is the costliest error a summary can make.
    The same seed always gives the same records.
    """
    rng = random.Random(seed)
    allergic = [r for r in records if r["allergies"]]
    picked = rng.sample(allergic, min(with_allergies, len(allergic)))
    taken = {r["patient_id"] for r in picked}
    rest = [r for r in records if r["patient_id"] not in taken]
    picked += rng.sample(rest, n - len(picked))  # these may have allergies too
    return sorted(picked, key=lambda r: r["patient_id"])


def spot_check(
    n: int = 100,
    seed: int = synthea.SEED,
    with_allergies: int = 3,
    db: Path = synthea.WAREHOUSE,
    out: Path = OUT,
) -> None:
    """Print n records next to the raw FHIR they came from, for checking by hand.

    The raw side lists every active item, including the excluded non-clinical
    conditions, so leaving one out by mistake shows up as a difference. Pass your
    own seed to know the selection was not arranged in advance.
    """
    records = [json.loads(line) for line in out.read_text().splitlines()]
    picked = pick(records, n, seed, with_allergies)
    print(
        f"seed {seed}: {len(picked)} of {len(records)} patients,"
        f" at least {with_allergies} with an allergy\n"
    )
    with duckdb.connect(db, read_only=True) as con:
        for record in picked:
            pid = record["patient_id"]
            print(f"=== {pid}")
            print(json.dumps(record, indent=2))
            for title, sql in (
                ("medications", MEDICATIONS),
                ("allergies", ALLERGIES),
                ("conditions", CONDITIONS),
            ):
                print(f"--- raw active {title}")
                for row in rows(
                    con, f"SELECT * FROM ({sql}) WHERE patient_id = ?", [pid]
                ):
                    row.pop("patient_id")
                    excluded = title == "conditions" and row["code"] in NON_CLINICAL
                    print(("  [excluded] " if excluded else "  ") + str(row))
            print()


if __name__ == "__main__":
    args = sys.argv[1:]
    if args[:1] != ["spot-check"] or len(args) > 2:
        sys.exit(__doc__)
    try:
        seed = int(args[1]) if len(args) == 2 else synthea.SEED
    except ValueError:
        sys.exit(f"seed must be a whole number, got {args[1]!r}")
    spot_check(seed=seed)
