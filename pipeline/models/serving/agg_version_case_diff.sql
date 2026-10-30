-- One row per agent version and test case, for versions with a predecessor: did the case
-- pass in this version's latest suite run, and in its predecessor's? Only cases run in
-- both are compared.
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
join {{ ref('agg_version_case_result') }} now on now.agent_key = v.agent_key
join {{ ref('agg_version_case_result') }} before on before.agent_key = v.previous_agent_key and before.test_case_id = now.test_case_id
