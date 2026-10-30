import datetime as dt
import itertools
import random

import pytest

from ai_health_harness import notes

PATIENT: dict = {"patient_id": "p1", "gender": "female", "born": dt.date(1970, 6, 1)}
LISINOPRIL = {
    "name": "lisinopril 10 MG Oral Tablet",
    "rxnorm": "314076",
    "as_needed": False,
    "dose": 1.0,
    "timing": {"frequency": 2, "period": 1.0, "period_unit": "d"},
}
ALBUTEROL = {"name": "albuterol Inhaler", "rxnorm": "745679", "as_needed": True, "dose": None, "timing": None}
RECORD: dict = {
    "patient_id": "p1",
    "as_of": "2026-01-01",
    "medications": [ALBUTEROL, LISINOPRIL],
    "allergies": [
        {
            "substance": "Shellfish (substance)",
            "snomed": "227037002",
            "category": "food",
            "type": "allergy",
            "reactions": [{"manifestation": "Anaphylaxis (disorder)", "severity": "severe"}],
        },
        {"substance": "Mold (organism)", "snomed": "84489001", "category": None, "type": None, "reactions": []},
    ],
    "conditions": [
        {"name": "Essential hypertension (disorder)", "system": "snomed", "code": "59621000", "onset": None},
        {"name": "Anemia (disorder)", "system": "snomed", "code": "271737000", "onset": None},
    ],
}
STOPPED = [{"patient_id": "p1", "name": "Naproxen 220 MG Oral Tablet", "rxnorm": "849574"}]
ALL_TRAPS = list(notes.TRAP_RATE)


def render(*traps: str) -> str:
    return notes.render(RECORD, PATIENT, STOPPED, list(traps), random.Random(0))


@pytest.mark.parametrize("n", range(len(ALL_TRAPS) + 1))
def test_every_ground_truth_item_is_in_the_note_whatever_the_traps(n):
    for traps in itertools.combinations(ALL_TRAPS, n):
        note = render(*traps).lower()
        for med in RECORD["medications"]:
            assert med["name"].lower() in note
        assert "shellfish (anaphylaxis)" in note and "mold" in note
        assert "anemia" in note
        assert ("htn" if "abbreviations" in traps else "essential hypertension") in note


def test_a_plain_note_spells_things_out():
    note = render()
    assert "lisinopril 10 MG Oral Tablet, 1 tablet, twice daily" in note
    assert "albuterol Inhaler, as needed" in note
    assert "Allergies: shellfish (anaphylaxis); mold" in note
    assert "Naproxen" not in note
    assert "55-year-old woman" in note


def test_abbreviations_use_shorthand():
    note = render("abbreviations")
    assert "1 tablet, BID" in note and "albuterol Inhaler, PRN" in note
    assert "PMH: HTN; Anemia" in note


def test_discontinued_med_is_named_as_stopped():
    assert "previously taking Naproxen 220 MG Oral Tablet, which has since been stopped" in render("discontinued_med")


def test_buried_allergy_has_no_allergies_section():
    note = render("buried_allergy")
    assert "Allergies:" not in note
    social = next(line for line in note.splitlines() if line.startswith("Social history:"))
    assert "reacting to shellfish (anaphylaxis) and mold in the past" in social


def test_dose_change_lists_the_old_dose_and_plans_the_new_one():
    note = render("dose_change")
    assert "lisinopril 10 MG Oral Tablet, 2 tablets, twice daily" in note
    assert "Decrease lisinopril 10 MG Oral Tablet to 1 tablet twice daily" in note


def test_no_allergies_reads_nkda_or_no_known_allergies():
    bare = RECORD | {"allergies": []}
    assert "Allergies: no known allergies" in notes.render(bare, PATIENT, [], [], random.Random(0))
    assert "Allergies: NKDA" in notes.render(bare, PATIENT, [], ["abbreviations"], random.Random(0))


def test_traps_only_go_where_they_can_apply():
    bare = {"patient_id": "p2", "as_of": "2026-01-01", "medications": [ALBUTEROL], "allergies": [], "conditions": []}
    assert notes.eligible(bare, []) == {"abbreviations"}
    assert notes.eligible(RECORD, STOPPED) == set(ALL_TRAPS)


def test_categories():
    assert notes.categories(RECORD, []) == ["simple"]
    assert notes.categories(RECORD, ["dose_change"]) == ["dose_change"]
    many = RECORD | {"medications": [ALBUTEROL] * 5}
    assert notes.categories(many, ["abbreviations"]) == ["abbreviations", "polypharmacy"]


def test_build_is_reproducible(monkeypatch):
    monkeypatch.setattr(notes, "CASES", 3)
    monkeypatch.setattr(notes, "WITH_ALLERGIES", 1)
    records = [RECORD | {"patient_id": f"p{i}"} for i in range(5)]
    patients = {r["patient_id"]: PATIENT for r in records}
    stopped = {"p1": STOPPED}
    first = notes.build(records, patients, stopped)
    assert first == notes.build(records, patients, stopped)
    assert [c["case_id"] for c in first] == ["v1-001", "v1-002", "v1-003"]
    assert all(c["ground_truth"]["patient_id"] == c["patient_id"] for c in first)


def test_a_frozen_dataset_is_never_overwritten_with_different_cases(tmp_path):
    out = tmp_path / "notes_v1.jsonl"
    notes.write([{"case_id": "a"}], out)
    notes.write([{"case_id": "a"}], out)  # same cases: fine
    with pytest.raises(SystemExit, match="bump VERSION"):
        notes.write([{"case_id": "b"}], out)
    assert out.read_text() == '{"case_id": "a"}\n'
