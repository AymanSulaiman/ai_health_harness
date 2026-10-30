-- One row per agent version and test category, against its predecessor: pass rates over all
-- runs of each, and how many cases newly fail or newly pass (from agg_version_case_diff).
with changes as (
    select
        c.agent_key,
        d.category,
        count(*) filter (where c.change = 'newly_failing') as newly_failing,
        count(*) filter (where c.change = 'newly_passing') as newly_passing,
        count(*) as cases_compared
    from {{ ref('agg_version_case_diff') }} c
    join {{ ref('dim_test_case') }} d on d.case_id = c.test_case_id
    group by all
)

select
    changes.agent_key || '|' || changes.category as version_category_key,
    changes.agent_key,
    case_diff_versions.previous_agent_key,
    changes.category,
    before.pass_rate as pass_rate_before,
    now.pass_rate as pass_rate_now,
    now.pass_rate - before.pass_rate as pass_rate_change,
    changes.newly_failing,
    changes.newly_passing,
    changes.cases_compared
from changes
join (select distinct agent_key, previous_agent_key from {{ ref('agg_version_case_diff') }}) case_diff_versions using (agent_key)
join {{ ref('agg_version_category') }} now on now.agent_key = changes.agent_key and now.category = changes.category
join {{ ref('agg_version_category') }} before on before.agent_key = case_diff_versions.previous_agent_key and before.category = changes.category
