-- One row per judge version: the judge model and its prompt. Runs scored without a judge have none.
select
    judge_model || '|' || judge_prompt_version as judge_key,
    judge_model,
    judge_prompt_version,
    min(created_at) as first_run_at,
    max(created_at) as last_run_at,
    count(*) as run_count
from {{ ref('stg_trace_events') }}
where judge_model is not null
group by all
