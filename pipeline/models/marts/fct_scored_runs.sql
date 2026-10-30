-- One row per agent run on one test case, with every score as a column.
-- Incremental: trace files are append-only, so each build adds runs newer than the newest
-- already here. >= plus unique_key re-merges runs sharing that last timestamp.
{{ config(materialized='incremental', unique_key='run_id', incremental_strategy='delete+insert') }}

with runs as (
    select * from {{ ref('stg_trace_events') }}
    {% if is_incremental() %}
    where created_at >= (select max(created_at) from {{ this }})
    {% endif %}
),

scores as (
    select
        run_id,
        {% for scorer in ['schema_valid', 'medication_recall', 'medication_precision', 'allergy_recall',
                          'dose_match', 'hallucinations', 'judge_faithfulness', 'judge_usefulness', 'judge_omissions'] %}
        max(value) filter (where scorer = '{{ scorer }}') as {{ scorer }},
        {% endfor %}
        bool_and(passed) filter (where scorer not like 'judge_%') as deterministic_passed,
        bool_and(passed) filter (where scorer like 'judge_%') as judge_passed
    from {{ ref('stg_trace_scores') }}
    where run_id in (select run_id from runs)
    group by run_id
)

select
    runs.run_id,
    runs.suite_run_id,
    runs.test_case_id,
    runs.dataset_version,
    runs.agent_version || '|' || runs.prompt_version || '|' || runs.agent_model as agent_key,
    runs.judge_model || '|' || runs.judge_prompt_version as judge_key,
    runs.created_at,
    runs.error_stage,
    -- passed: no error and every score passed, the judge's included when there was one
    runs.error_stage is null and coalesce(scores.deterministic_passed, false) and coalesce(scores.judge_passed, true) as passed,
    coalesce(scores.deterministic_passed, false) as deterministic_passed,
    scores.judge_passed,
    scores.* exclude (run_id, deterministic_passed, judge_passed),
    runs.latency_ms,
    runs.input_tokens,
    runs.output_tokens,
    runs.tool_call_count
from runs
left join scores using (run_id)
