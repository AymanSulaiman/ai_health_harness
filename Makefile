# ponytail: eval/transform/dev targets land with KAN-19/KAN-23/KAN-27
.PHONY: install generate schema test typecheck check

install:
	uv sync --project data_processing
	bun install

generate:
	uv run --project data_processing ai-health-harness

schema:
	bun run --cwd shared-types schema

test:
	uv run --project data_processing pytest
	bun test

typecheck:
	bun run --cwd harness typecheck
	bun run --cwd shared-types typecheck

check: test typecheck
