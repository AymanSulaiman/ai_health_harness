-- One row per agent run, typed and flattened. Scores are in stg_trace_scores.
select
    run_id,
    suite_run_id,
    test_case_id,
    dataset_version,
    agent_version,
    agent_model,
    prompt_version,
    judge_model,
    judge_prompt_version,
    input_tokens,
    output_tokens,
    latency_ms,
    len(tool_calls) as tool_call_count,
    to_json(tool_calls) as tool_calls,
    error.stage as error_stage,
    error.message as error_message,
    raw_output,
    parsed_output,
    created_at
from {{ source('raw', 'trace_events') }}
