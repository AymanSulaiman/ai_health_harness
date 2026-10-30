-- The metrics every serving rollup reports, over the fct_scored_runs rows in scope (alias f).
{% macro run_metrics() %}
    count(distinct f.suite_run_id) as suite_count,
    count(*) as run_count,
    count(distinct f.test_case_id) as case_count,
    avg(f.passed::int) as pass_rate,
    avg(f.deterministic_passed::int) as deterministic_pass_rate,
    avg(f.judge_passed::int) as judge_pass_rate,
    avg((f.error_stage is not null)::int) as error_rate,
    avg((f.hallucinations < 1)::int) as hallucination_rate,
    {% for scorer in ['medication_recall', 'medication_precision', 'allergy_recall', 'dose_match',
                      'hallucinations', 'judge_faithfulness', 'judge_usefulness', 'judge_omissions'] %}
    avg(f.{{ scorer }}) as mean_{{ scorer }},
    {% endfor %}
    quantile_cont(f.latency_ms, 0.5) as p50_latency_ms,
    quantile_cont(f.latency_ms, 0.95) as p95_latency_ms,
    avg(f.input_tokens) as mean_input_tokens,
    avg(f.output_tokens) as mean_output_tokens,
    sum(f.input_tokens + f.output_tokens) as total_tokens
{% endmacro %}
