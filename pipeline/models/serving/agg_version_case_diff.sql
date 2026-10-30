-- One row per agent version and test case: did the case pass in this version's latest suite
-- run, and in its predecessor's? The predecessor is the version that first ran just before
-- this one. Comparing latest suite runs keeps reruns of a version from counting twice. Only
-- cases run in both suites are compared.
with latest_suite as (
    select agent_key, arg_max(suite_run_id, created_at) as suite_run_id
    from {{ ref('fct_scored_runs') }}
    group by agent_key
),

case_results as (
    select f.agent_key, f.test_case_id, bool_and(f.passed) as passed
    from {{ ref('fct_scored_runs') }} f
    join latest_suite using (agent_key, suite_run_id)
    group by all
)

select
    v.agent_key || '|' || now.test_case_id as version_case_key,
    v.agent_key,
    v.previous_agent_key,
    now.test_case_id,
    before.passed as passed_before,
    now.passed as passed_now,
    case
        when before.passed and not now.passed then 'newly_failing'
        when not before.passed and now.passed then 'newly_passing'
        when now.passed then 'still_passing'
        else 'still_failing'
    end as change
from {{ ref('dim_agent_version') }} v
join case_results now on now.agent_key = v.agent_key
join case_results before on before.agent_key = v.previous_agent_key and before.test_case_id = now.test_case_id
