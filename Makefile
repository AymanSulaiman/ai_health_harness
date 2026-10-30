# ponytail: dev target lands with KAN-27
.PHONY: install generate schema transform test typecheck check

install:
	uv sync --project data_processing
	bun install

generate:
	uv run --project data_processing ai-health-harness

schema:
	bun run --cwd shared-types schema

DBT = uv run --project data_processing dbt --no-version-check
DBT_ARGS = --project-dir pipeline --profiles-dir pipeline
transform:
	@ls data/traces/*.jsonl >/dev/null 2>&1 || { echo "no trace files in data/traces: run 'bun run eval' first"; exit 1; }
	$(DBT) source freshness $(DBT_ARGS)
	$(DBT) build $(DBT_ARGS)

test:
	uv run --project data_processing pytest
	bun test

typecheck:
	bun run --cwd agent typecheck
	bun run --cwd harness typecheck
	bun run --cwd shared-types typecheck

check: test typecheck
