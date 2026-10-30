-- One row per score: each run's scores unnested.
with unnested as (
    select run_id, unnest(scores) as score
    from {{ source('raw', 'trace_events') }}
)

select
    run_id || ':' || score.scorer as score_id,
    run_id,
    score.scorer as scorer,
    score.value as value,
    score.passed as passed,
    score.detail as detail
from unnested
