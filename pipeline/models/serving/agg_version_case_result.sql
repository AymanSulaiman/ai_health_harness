-- One row per agent version and test case: the case's result in the version's latest suite
-- run, with the run to open in the trace view and what failed. Comparing latest suite runs
-- keeps reruns of a version from counting a case twice.
with latest_suite as (
    select agent_key, arg_max(suite_run_id, created_at) as suite_run_id
    from {{ ref('fct_scored_runs') }}
    group by agent_key
),

runs as (
    select f.*
    from {{ ref('fct_scored_runs') }} f
    join latest_suite using (agent_key, suite_run_id)
),

categories as (
    select distinct case_id as test_case_id, all_categories as categories
    from {{ ref('dim_test_case') }}
),

failed as (
    select run_id, string_agg(scorer, ', ' order by scorer) as failed_scorers
    from {{ ref('stg_trace_scores') }}
    where not passed
    group by run_id
)

select
    runs.agent_key || '|' || runs.test_case_id as version_case_key,
    runs.agent_key,
    runs.test_case_id,
    categories.categories,
    runs.suite_run_id,
    runs.run_id,
    runs.passed,
    runs.error_stage,
    failed.failed_scorers
from runs
left join failed using (run_id)
left join categories using (test_case_id)
-- a resumed suite has one run per case; should one ever have two, keep the latest
qualify row_number() over (partition by runs.agent_key, runs.test_case_id order by runs.created_at desc) = 1
