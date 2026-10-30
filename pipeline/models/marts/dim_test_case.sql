-- One row per test case and category: a case with two traps appears twice, so grouping
-- runs by category is a plain join. A case with no tags (no trap, 4 medications) gets one
-- row with category 'untagged', so every case appears.
with cases as (
    select * from {{ ref('stg_test_cases') }}
)

select
    case_id || '|' || category as test_case_category_key,
    case_id,
    dataset_version,
    category,
    category in ('discontinued_med', 'buried_allergy', 'dose_change', 'abbreviations') as is_trap,
    categories as all_categories,
    medication_count,
    allergy_count,
    condition_count
from cases, unnest(case when len(categories) = 0 then ['untagged'] else categories end) as t(category)
