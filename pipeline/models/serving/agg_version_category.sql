-- One row per agent version and test category. A run counts once in each category its case carries.
select
    f.agent_key,
    v.previous_agent_key,
    d.category,
    d.is_trap,
    {{ run_metrics() }}
from {{ ref('fct_scored_runs') }} f
join {{ ref('dim_test_case') }} d on d.case_id = f.test_case_id
join {{ ref('dim_agent_version') }} v using (agent_key)
group by all
