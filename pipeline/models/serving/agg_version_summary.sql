-- One row per agent version: how it did over all its runs.
select
    v.agent_key,
    v.previous_agent_key,
    v.agent_version,
    v.prompt_version,
    v.agent_model,
    v.first_run_at,
    v.last_run_at,
    {{ run_metrics() }}
from {{ ref('fct_scored_runs') }} f
join {{ ref('dim_agent_version') }} v using (agent_key)
group by all
