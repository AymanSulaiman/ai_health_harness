# ponytail: eval/transform/dev targets land with KAN-19/KAN-23/KAN-27
.PHONY: install generate test typecheck check

install:
	uv sync --project data_processing
	bun install

generate:
	uv run --project data_processing ai-health-harness

test:
	uv run --project data_processing pytest

typecheck:
	bun run --cwd harness typecheck

check: test typecheck
