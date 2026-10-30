-- One row per agent version: the agent code, its prompt and the model it ran on.
-- A change to any of the three is a new version.
select
    agent_version || '|' || prompt_version || '|' || agent_model as agent_key,
    agent_version,
    prompt_version,
    agent_model,
    min(created_at) as first_run_at,
    max(created_at) as last_run_at,
    count(*) as run_count
from {{ ref('stg_trace_events') }}
group by all
