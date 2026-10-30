-- One row per test case, with what the case tests and how much its record holds.
select
    case_id,
    dataset_version,
    patient_id::varchar as patient_id,
    categories,
    len(ground_truth.medications) as medication_count,
    len(ground_truth.allergies) as allergy_count,
    len(ground_truth.conditions) as condition_count,
    note,
    to_json(ground_truth) as ground_truth
from {{ source('raw', 'test_cases') }}
