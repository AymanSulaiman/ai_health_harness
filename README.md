# ai_health_harness

Generates a reproducible synthetic population with Synthea as FHIR R4, and loads it
into DuckDB: one `raw_fhir` table per resource type in `data/warehouse.duckdb`. The
seed, population size and Synthea version are pinned in `data_processing/src/ai_health_harness/synthea.py`.

It then builds the ground truth: one record per living patient in
`data/ground_truth.jsonl`, listing what a correct summary must contain (see below).

Needs [uv](https://docs.astral.sh/uv/) and Docker (Synthea runs in a Java container).
Run from the repository root:

```
uv run --project data_processing ai-health-harness                # every step, in order
uv run --project data_processing ai-health-harness generate       # Synthea -> raw_fhir tables in DuckDB
uv run --project data_processing ai-health-harness ground-truth   # raw_fhir -> data/ground_truth.jsonl
uv run --project data_processing python -c "import duckdb; print(duckdb.connect('data/warehouse.duckdb').sql('SELECT count(*) FROM raw_fhir.medication_request'))"
```

Rerunning replaces the `raw_fhir` schema; the same seed gives the same patients.

Tests: `uv run --project data_processing pytest`

## FHIR resources

[FHIR](https://hl7.org/fhir/R4/) is the HL7 standard for exchanging health records: a
record is a set of typed *resources* that point at each other by reference. Synthea
can export about 25 resource types. This project loads six, the ones that describe a
patient's clinical state, because the summariser is judged on getting that state right:
its medications, allergies and conditions.

| Resource | Table | What it holds | Why it is here |
|---|---|---|---|
| Patient | `raw_fhir.patient` | Demographics, birth and death dates | The unit of a test case; everything else points at it |
| Encounter | `raw_fhir.encounter` | A visit: ambulatory, emergency, inpatient, ... | The context a note is written in; dates the other facts |
| Condition | `raw_fhir.condition` | A diagnosis with a clinical status (`active`, `resolved`) | Ground truth for active conditions |
| MedicationRequest | `raw_fhir.medication_request` | A prescription: drug, status, dose and timing | Ground truth for active medications with dose and frequency |
| AllergyIntolerance | `raw_fhir.allergy_intolerance` | An allergy or intolerance and its reactions | Ground truth for allergies, where a miss is a hard fail |
| Observation | `raw_fhir.observation` | Vitals, lab results, surveys, social history | Supporting detail a note mentions, and a source of distractors |

Left out on purpose:

- **Claim, ExplanationOfBenefit**: billing, which no summary needs.
- **DocumentReference, DiagnosticReport**: Synthea's own note text. The test-case notes
  are rendered from these records instead, so the traps planted in them are known.
- **Medication**: requests carry their drug inline (`medicationCodeableConcept`).
- **Organization, Practitioner, Location**: who and where, not what is wrong with
  the patient.
- **Immunization, Procedure, CarePlan, Device**: real history, but not in the ground
  truth, so including them would only add unscored noise for now.

Each one is a single setting away (`RESOURCES` in `synthea.py`).

Things worth knowing when querying:

- References are strings like `Patient/<id>`, so a join reads
  `ON c.subject.reference = 'Patient/' || p.id`.
- AllergyIntolerance points at its patient with `patient`, not `subject` like the
  other resources.
- Codes sit in lists of codings: `code.coding[1].display` (DuckDB lists start at 1).
- "Active" lives in different places: `clinicalStatus.coding[1].code` on Condition and
  AllergyIntolerance, `status` on MedicationRequest.
- Most prescriptions are `completed`; only a small share are `active`, and some active
  ones have no dose or timing (`dosageInstruction`). Most patients have no allergies.

## Ground truth

`data/ground_truth.jsonl` has one JSON record per living patient, as of the simulation
end date. Its shape is the contract in `schemas/ground_truth.schema.json`; every record
is validated against it when built.

- **medications**: active MedicationRequests with RxNorm code, dose, timing
  (`frequency` per `period` `period_unit`, so 2 per 1 d is twice daily) and whether the
  drug is taken as needed. Synthea leaves dose and timing out of many prescriptions;
  those fields are then `null`, and the drug is still listed.
- **allergies**: active AllergyIntolerances with their reactions.
- **conditions**: active Conditions, except the social and administrative entries
  Synthea also records as conditions (employment, education, housing, "medication
  review due", ...). The excluded codes are listed in `NON_CLINICAL` in
  `ground_truth.py`.

To check records by hand against the FHIR they came from:

```
uv run --project data_processing python -m ai_health_harness.ground_truth spot-check
```

It prints the same 10 patients each time, each record beside every active raw item,
with excluded conditions marked `[excluded]`.
