import json
from pathlib import Path

import jsonschema
import pytest

from ai_health_harness import ground_truth, synthea

ALIVE = "00000000-0000-0000-0000-00000000000a"
DEAD = "00000000-0000-0000-0000-00000000000d"
BARE = "00000000-0000-0000-0000-00000000000b"  # alive, nothing on record


def coded(display: str, code: str, system: str = "http://snomed.info/sct") -> dict:
    return {"coding": [{"system": system, "code": code, "display": display}]}


def status(code: str) -> dict:
    return {"coding": [{"code": code}]}


def med(id: str, patient: str, drug: str, rx_status: str, **dosage) -> dict:
    resource = {
        "id": id,
        "subject": {"reference": f"Patient/{patient}"},
        "status": rx_status,
        "medicationCodeableConcept": coded(drug, f"rx-{id}"),
    }
    if dosage:
        resource["dosageInstruction"] = [dosage]
    return resource


def condition(id: str, patient: str, name: str, code: str, active: bool) -> dict:
    return {
        "id": id,
        "subject": {"reference": f"Patient/{patient}"},
        "clinicalStatus": status("active" if active else "resolved"),
        "code": coded(name, code),
        "onsetDateTime": "2010-05-01T10:00:00+00:00",
    }


FHIR = {
    "Patient.ndjson": [
        {"id": ALIVE},
        {"id": BARE},
        {"id": DEAD, "deceasedDateTime": "2020-01-01T00:00:00+00:00"},
    ],
    "MedicationRequest.ndjson": [
        med(
            "m1",
            ALIVE,
            "Simvastatin 10 MG Oral Tablet",
            "active",
            asNeededBoolean=False,
            timing={"repeat": {"frequency": 2, "period": 1.0, "periodUnit": "d"}},
            doseAndRate=[{"doseQuantity": {"value": 1.0}}],
        ),
        med("m2", ALIVE, "Albuterol Inhaler", "active", asNeededBoolean=True),
        med("m3", ALIVE, "Acetaminophen 325 MG", "active"),  # no dosage at all
        med("m4", ALIVE, "Amoxicillin 250 MG", "completed"),  # stopped: not in truth
        med("m5", DEAD, "Warfarin 5 MG", "active"),  # deceased: no record
    ],
    "AllergyIntolerance.ndjson": [
        {
            "id": "a1",
            "patient": {"reference": f"Patient/{ALIVE}"},  # `patient`, not `subject`
            "clinicalStatus": status("active"),
            "type": "allergy",
            "category": ["food"],
            "code": coded("Peanut (substance)", "762952008"),
            "reaction": [
                {
                    "manifestation": [coded("Hives", "247472004")],
                    "severity": "moderate",
                },
                {"manifestation": [coded("Wheezing", "56018004")]},
            ],
        }
    ],
    "Condition.ndjson": [
        condition("c1", ALIVE, "Hypertension", "59621000", active=True),
        condition("c2", ALIVE, "Prediabetes (finding)", "714628002", active=True),
        condition(
            "c3", ALIVE, "Full-time employment (finding)", "160903007", active=True
        ),
        condition("c4", ALIVE, "Viral sinusitis (disorder)", "444814009", active=False),
    ],
}


@pytest.fixture
def warehouse(tmp_path) -> Path:
    fhir = tmp_path / "fhir"
    fhir.mkdir()
    for name, resources in FHIR.items():
        (fhir / name).write_text("".join(json.dumps(r) + "\n" for r in resources))
    db = tmp_path / "warehouse.duckdb"
    synthea.load_fhir(fhir, db)
    return db


def test_one_record_per_living_patient(warehouse):
    records = ground_truth.build(warehouse)
    assert [r["patient_id"] for r in records] == [ALIVE, BARE]
    assert records[1] == {
        "patient_id": BARE,
        "as_of": "2026-01-01",
        "medications": [],
        "allergies": [],
        "conditions": [],
    }


def test_active_medications_keep_dose_and_timing_when_recorded(warehouse):
    (alive, _) = ground_truth.build(warehouse)
    assert alive["medications"] == [
        {
            "name": "Acetaminophen 325 MG",
            "rxnorm": "rx-m3",
            "as_needed": None,
            "dose": None,
            "timing": None,
        },
        {
            "name": "Albuterol Inhaler",
            "rxnorm": "rx-m2",
            "as_needed": True,
            "dose": None,
            "timing": None,
        },
        {
            "name": "Simvastatin 10 MG Oral Tablet",
            "rxnorm": "rx-m1",
            "as_needed": False,
            "dose": 1.0,
            "timing": {"frequency": 2, "period": 1.0, "period_unit": "d"},
        },
    ]


def test_allergies_carry_their_reactions(warehouse):
    (alive, _) = ground_truth.build(warehouse)
    assert alive["allergies"] == [
        {
            "substance": "Peanut (substance)",
            "snomed": "762952008",
            "category": "food",
            "type": "allergy",
            "reactions": [
                {"manifestation": "Hives", "severity": "moderate"},
                {"manifestation": "Wheezing", "severity": None},
            ],
        }
    ]


def test_conditions_are_active_and_clinical_only(warehouse):
    (alive, _) = ground_truth.build(warehouse)
    assert alive["conditions"] == [
        {
            "name": "Hypertension",
            "system": "http://snomed.info/sct",
            "code": "59621000",
            "onset": "2010-05-01",
        },
        {
            "name": "Prediabetes (finding)",  # a finding, but a clinical one: kept
            "system": "http://snomed.info/sct",
            "code": "714628002",
            "onset": "2010-05-01",
        },
    ]


def test_records_round_trip_through_jsonl(warehouse, tmp_path):
    out = tmp_path / "ground_truth.jsonl"
    records = ground_truth.run(warehouse, out)
    assert [json.loads(line) for line in out.read_text().splitlines()] == records


def test_a_record_that_breaks_the_schema_is_rejected(warehouse, monkeypatch):
    monkeypatch.setattr(ground_truth, "AS_OF", 20260101)  # not a string
    with pytest.raises(jsonschema.ValidationError):
        ground_truth.build(warehouse)


def test_spot_check_shows_excluded_conditions_beside_the_record(
    warehouse, tmp_path, capsys
):
    out = tmp_path / "ground_truth.jsonl"
    ground_truth.run(warehouse, out)
    capsys.readouterr()
    ground_truth.spot_check(n=2, seed=7, db=warehouse, out=out)
    printed = capsys.readouterr().out
    assert printed.startswith("seed 7: 2 of 2 patients, at least 3 with an allergy")
    assert f"=== {ALIVE}" in printed and f"=== {BARE}" in printed
    assert "[excluded] {'name': 'Full-time employment (finding)'" in printed


def fake_records(n: int, allergic: set[int]) -> list[dict]:
    return [
        {
            "patient_id": f"p{i:04}",
            "allergies": [{"substance": "x"}] if i in allergic else [],
        }
        for i in range(n)
    ]


def test_spot_check_sample_always_includes_allergy_patients():
    records = fake_records(2000, allergic={7, 400, 1200, 1999})  # rare on purpose
    for seed in range(200):
        picked = ground_truth.pick(records, 10, seed, with_allergies=3)
        assert len(picked) == 10
        assert len({r["patient_id"] for r in picked}) == 10  # no duplicates
        assert sum(bool(r["allergies"]) for r in picked) >= 3


def test_spot_check_sample_is_fixed_by_the_seed_and_changes_with_it():
    records = fake_records(2000, allergic=set(range(0, 2000, 5)))
    ids = lambda seed: [
        r["patient_id"] for r in ground_truth.pick(records, 10, seed, 3)
    ]
    assert ids(42) == ids(42)
    assert ids(42) != ids(43)


def test_spot_check_takes_every_allergy_patient_when_there_are_too_few():
    records = fake_records(50, allergic={3})
    picked = ground_truth.pick(records, 10, seed=1, with_allergies=3)
    assert len(picked) == 10 and "p0003" in {r["patient_id"] for r in picked}
