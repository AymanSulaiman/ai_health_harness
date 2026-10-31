-- One row per run, everything the trace view shows: the note, the answer key, what the
-- agent returned, every score with its detail, tool calls and cost. Queried by run_id.
with scores as (
    select
        run_id,
        list({'scorer': scorer, 'value': value, 'passed': passed, 'detail': detail} order by scorer) as scores
    from {{ ref('stg_trace_scores') }}
    group by run_id
)

select
    e.run_id,
    e.suite_run_id,
    e.test_case_id,
    f.agent_key,
    e.agent_version,
    e.prompt_version,
    e.agent_model,
    e.judge_model,
    e.judge_prompt_version,
    e.created_at,
    f.passed,
    e.error_stage,
    e.error_message,
    e.latency_ms,
    e.input_tokens,
    e.output_tokens,
    e.tool_calls,
    e.raw_output,
    e.parsed_output,
    coalesce(scores.scores, []) as scores,
    c.categories,
    c.note,
    c.ground_truth
from {{ ref('stg_trace_events') }} e
join {{ ref('fct_scored_runs') }} f using (run_id)
join {{ ref('stg_test_cases') }} c on c.case_id = e.test_case_id
left join scores using (run_id)
