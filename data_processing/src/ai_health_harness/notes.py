"""Render a free-text clinical note per test case, with traps planted in some.

Reads data/ground_truth.jsonl and the raw_fhir tables, picks CASES patients with a
fixed seed and writes datasets/notes_<VERSION>.jsonl: one test case per line with its
note, ground truth and category tags. The file is committed and frozen: a change to
how cases are picked or rendered must bump VERSION, or writing refuses.

Traps, each planted in a share of the cases it can apply to:
- discontinued_med: a drug the patient stopped (a completed prescription) is named
- buried_allergy: no Allergies section; the allergies sit mid-paragraph in social history
- dose_change: the med list shows a drug's old dose, and only the plan gives the new one
- abbreviations: BID, PRN, HTN, NKDA ... instead of words
Cases with no trap and at most 3 medications are also tagged simple; 5 or more
medications, polypharmacy.
"""

import datetime as dt
import json
import random
import re
import sys
from collections import defaultdict
from pathlib import Path

import duckdb

from ai_health_harness import ground_truth, synthea

VERSION = "v1"
OUT = Path(f"datasets/notes_{VERSION}.jsonl")
CASES = 100
WITH_ALLERGIES = 40  # about 1 patient in 5 has one; oversampled so buried_allergy gets enough cases
TRAP_RATE = {
    "discontinued_med": 0.3,
    "buried_allergy": 0.5,
    "dose_change": 0.5,
    "abbreviations": 0.3,
}

PATIENTS = """
SELECT CAST(id AS VARCHAR) AS patient_id, gender, CAST(birthDate AS DATE) AS born
FROM raw_fhir.patient
"""
# Completed prescriptions, newest first, for drugs the patient is not taking now.
STOPPED = """
SELECT split_part(m.subject.reference, '/', 2) AS patient_id,
       m.medicationCodeableConcept.coding[1].display AS name,
       m.medicationCodeableConcept.coding[1].code AS rxnorm,
       max(m.authoredOn) AS last
FROM raw_fhir.medication_request m
WHERE m.status = 'completed'
GROUP BY ALL
ORDER BY patient_id, last DESC, name
"""

DAILY = {1: ("once daily", "QD"), 2: ("twice daily", "BID"), 3: ("three times daily", "TID"), 4: ("four times daily", "QID")}
UNITS = {"h": "hour", "d": "day", "wk": "week", "mo": "month"}
FORMS = [("Tablet", "tablet"), ("Capsule", "capsule"), ("Inhal", "puff"), ("Spray", "spray"), ("Patch", "patch")]
# ponytail: covers the common conditions in the seed-42 population; others stay spelled out
SHORT = {
    "Essential hypertension": "HTN",
    "Hyperlipidemia": "HLD",
    "Ischemic heart disease": "IHD",
    "Prediabetes": "pre-DM",
    "Diabetes mellitus type 2": "T2DM",
    "Body mass index 30+ - obesity": "obesity (BMI 30+)",
    "Chronic low back pain": "chronic LBP",
    "Chronic kidney disease stage 1": "CKD 1",
    "Chronic kidney disease stage 2": "CKD 2",
    "Chronic kidney disease stage 3": "CKD 3",
    "Gastroesophageal reflux disease": "GERD",
    "Atrial fibrillation": "AFib",
    "Chronic obstructive bronchitis": "COPD",
    "Osteoarthritis of knee": "OA knee",
}
SOCIAL = [
    "Lives with family and works part time.",
    "Lives alone; retired.",
    "Married, two children, walks most days.",
    "Lives with a partner and works from home.",
]


def plain(display: str) -> str:
    """SNOMED's trailing semantic tag dropped, as a clinician would write it."""
    return re.sub(r"\s*\([^)]*\)$", "", display)


def form(name: str, n: float) -> str:
    word = next((w for key, w in FORMS if key in name), "dose")
    return word if n == 1 else word + "s"


def timing(med: dict, abbrev: bool) -> str:
    if med["as_needed"]:
        return "PRN" if abbrev else "as needed"
    t = med["timing"]
    if t is None:
        return ""
    f, p, unit = t["frequency"], t["period"], t["period_unit"]
    if p == 1 and unit == "d" and f in DAILY:
        return DAILY[f][abbrev]
    if f == 1 and unit == "h" and abbrev:
        return f"q{p:g}h"
    every = f"every {p:g} {UNITS.get(unit, unit)}s"
    return every if f == 1 else f"{f} times {every}"


def med_line(med: dict, abbrev: bool, dose: float | None = None) -> str:
    dose = med["dose"] if dose is None else dose
    parts = [med["name"]]
    if dose is not None:
        parts.append(f"{dose:g} {form(med['name'], dose)}")
    if when := timing(med, abbrev):
        parts.append(when)
    return "- " + ", ".join(parts)


def allergy_text(allergy: dict) -> str:
    reactions = ", ".join(plain(r["manifestation"]).lower() for r in allergy["reactions"])
    name = plain(allergy["substance"]).lower()
    return f"{name} ({reactions})" if reactions else name


def render(record: dict, patient: dict, stopped: list[dict], traps: list[str], rng: random.Random) -> str:
    """The note for one patient. Every ground-truth item is named in it."""
    abbrev = "abbreviations" in traps
    age = (dt.date.fromisoformat(record["as_of"]) - patient["born"]).days // 365
    person = {"male": "man", "female": "woman"}.get(patient["gender"], "patient")
    pronoun = {"male": "He", "female": "She"}.get(patient["gender"], "They")

    hpi = f"{age}-year-old {person} seen for a routine follow-up visit."
    if "discontinued_med" in traps:
        hpi += f" Was previously taking {stopped[0]['name']}, which has since been stopped."

    conditions = [plain(c["name"]) for c in record["conditions"]]
    if abbrev:
        conditions = [SHORT.get(c, c) for c in conditions]
    history = "; ".join(conditions) or "none significant"

    changed = None
    if "dose_change" in traps:
        changed = rng.choice([m for m in record["medications"] if m["dose"] is not None and m["timing"]])
    meds = [med_line(m, abbrev, m["dose"] * 2 if m is changed else None) for m in record["medications"]]

    allergies = "; ".join(allergy_text(a) for a in record["allergies"])
    social = rng.choice(SOCIAL)
    if "buried_allergy" in traps:
        named = [allergy_text(a) for a in record["allergies"]]
        prose = ", ".join(named[:-1]) + " and " + named[-1] if len(named) > 1 else named[0]
        social += f" {pronoun} mentions reacting to {prose} in the past, and tries to avoid them. Denies tobacco use."
    else:
        social += " Denies tobacco use."

    plan = "Continue current medications."
    if changed:
        new = f"{changed['dose']:g} {form(changed['name'], changed['dose'])}"
        plan = f"Decrease {changed['name']} to {new} {timing(changed, abbrev)}. Continue other medications."

    label = {True: ("PMH", "Meds", "SH"), False: ("Past medical history", "Medications", "Social history")}[abbrev]
    lines = [
        f"OUTPATIENT NOTE  {record['as_of']}",
        "",
        f"HPI: {hpi}",
        "",
        f"{label[0]}: {history}",
        "",
        f"{label[1]}:",
        *(meds or ["- none"]),
        "",
    ]
    if "buried_allergy" not in traps:
        lines += [f"Allergies: {allergies or ('NKDA' if abbrev else 'no known allergies')}", ""]
    lines += [f"{label[2]}: {social}", "", f"Plan: {plan} Follow up in 3 months."]
    return "\n".join(lines) + "\n"


def eligible(record: dict, stopped: list[dict]) -> set[str]:
    can = {"abbreviations"}
    if stopped:
        can.add("discontinued_med")
    if record["allergies"]:
        can.add("buried_allergy")
    if any(m["dose"] is not None and m["timing"] for m in record["medications"]):
        can.add("dose_change")
    return can


def categories(record: dict, traps: list[str]) -> list[str]:
    tags = list(traps)
    n = len(record["medications"])
    if n >= 5:
        tags.append("polypharmacy")
    if not traps and n <= 3:
        tags.append("simple")
    return sorted(tags)


def build(records: list[dict], patients: dict[str, dict], stopped: dict[str, list[dict]], seed: int = synthea.SEED) -> list[dict]:
    rng = random.Random(seed)
    # Patients with nothing to summarise make dull cases, so they are left out.
    candidates = [r for r in records if r["medications"] or r["allergies"]]
    picked = ground_truth.pick(candidates, CASES, seed, WITH_ALLERGIES)
    cases = []
    for i, record in enumerate(picked, 1):
        pid = record["patient_id"]
        active = {m["rxnorm"] for m in record["medications"]}
        history = [s for s in stopped.get(pid, []) if s["rxnorm"] not in active]
        can = eligible(record, history)
        traps = [t for t, rate in TRAP_RATE.items() if t in can and rng.random() < rate]
        cases.append(
            {
                "case_id": f"{VERSION}-{i:03d}",
                "dataset_version": VERSION,
                "patient_id": pid,
                "categories": categories(record, traps),
                "note": render(record, patients[pid], history, traps, rng),
                "ground_truth": record,
            }
        )
    return cases


def load(db: Path, truth: Path) -> tuple[list[dict], dict, dict]:
    records = [json.loads(line) for line in truth.read_text().splitlines()]
    with duckdb.connect(db, read_only=True) as con:
        patients = {p["patient_id"]: p for p in ground_truth.rows(con, PATIENTS)}
        stopped = defaultdict(list)
        for row in ground_truth.rows(con, STOPPED):
            stopped[row["patient_id"]].append(row)
    return records, patients, stopped


def write(cases: list[dict], out: Path = OUT) -> None:
    text = "".join(json.dumps(case) + "\n" for case in cases)
    if out.exists() and out.read_text() != text:
        sys.exit(f"{out} is frozen and these cases differ from it; bump VERSION in notes.py")
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(text)


def run(db: Path = synthea.WAREHOUSE, truth: Path = ground_truth.OUT, out: Path = OUT) -> list[dict]:
    cases = build(*load(db, truth))
    write(cases, out)
    counts = defaultdict(int)
    for case in cases:
        for tag in case["categories"]:
            counts[tag] += 1
    print(f"{len(cases)} test cases -> {out} ({dict(sorted(counts.items()))})")
    return cases
