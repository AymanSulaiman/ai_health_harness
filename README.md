# ai_health_harness

Generates a reproducible synthetic population with Synthea (seed 42, 200 living
patients) as FHIR R4, and loads it into DuckDB: one `raw_fhir` table per resource type
in `data/warehouse.duckdb`.

Needs [uv](https://docs.astral.sh/uv/) and Docker (Synthea runs in a Java container).
Run from the repository root:

```
uv run ai-health-harness generate
uv run python -c "import duckdb; print(duckdb.connect('data/warehouse.duckdb').sql('SELECT count(*) FROM raw_fhir.medication_request'))"
```

Rerunning replaces the `raw_fhir` schema; the same seed gives the same patients.

Tests: `uv run pytest`
