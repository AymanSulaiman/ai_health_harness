"""Integration test of the trace-event contract across the language boundary.

The TypeScript side (shared-types) writes example events through its zod schema; this
side validates them against the generated schemas/trace_event.schema.json and loads
them into DuckDB, as the pipeline will. Needs bun on the PATH
(make install sets it up).
"""

import json
import subprocess
from pathlib import Path

import duckdb
import jsonschema
import pytest

ROOT = Path(__file__).parents[2]
SCHEMA = json.loads((ROOT / "schemas" / "trace_event.schema.json").read_text())


@pytest.fixture(scope="module")
def jsonl(tmp_path_factory) -> Path:
    out = subprocess.run(
        ["bun", "shared-types/src/examples.ts"], cwd=ROOT, capture_output=True, text=True, check=True
    ).stdout
    path = tmp_path_factory.mktemp("traces") / "events.jsonl"
    path.write_text(out)
    return path


@pytest.fixture(scope="module")
def events(jsonl: Path) -> list[dict]:
    return [json.loads(line) for line in jsonl.read_text().splitlines()]


def test_every_event_typescript_writes_is_valid_for_python(events):
    assert len(events) == 4
    validator = jsonschema.Draft202012Validator(SCHEMA, format_checker=jsonschema.FormatChecker())
    for event in events:
        validator.validate(event)


def test_python_rejects_what_zod_rejects(events):
    validator = jsonschema.Draft202012Validator(SCHEMA, format_checker=jsonschema.FormatChecker())
    good = events[0]
    bad = [
        good | {"extra": 1},
        {k: v for k, v in good.items() if k != "parsed_output"},
        good | {"latency_ms": -1},
        good | {"latency_ms": 1.5},
        good | {"created_at": "yesterday"},
        good | {"error": {"stage": "network", "message": "x"}},
        good | {"scores": [{"scorer": "a", "value": 2, "passed": True, "detail": None}]},
    ]
    for event in bad:
        assert not validator.is_valid(event), event


def test_duckdb_reads_the_events(jsonl):
    with duckdb.connect() as con:
        con.execute(f"CREATE TABLE raw_trace AS SELECT * FROM read_json('{jsonl}', format = 'newline_delimited')")
        assert con.sql("SELECT count(*) FROM raw_trace").fetchone() == (4,)

        scores = con.sql(
            "SELECT run_id, s.scorer, s.value, s.passed"
            " FROM raw_trace, unnest(scores) AS t(s) ORDER BY run_id, s.scorer"
        ).fetchall()
        assert scores == [
            ("run-1", "allergy_recall", 1.0, True),
            ("run-1", "medication_recall", 1.0, True),
            ("run-2", "allergy_recall", 0.5, False),
            ("run-2", "judge", 0.75, True),
        ]

        errors = con.sql(
            "SELECT run_id, error.stage FROM raw_trace WHERE error IS NOT NULL ORDER BY run_id"
        ).fetchall()
        assert errors == [("run-3", "model"), ("run-4", "parse")]

        assert con.sql("SELECT count(*) FROM raw_trace, unnest(tool_calls)").fetchone() == (2,)
        text = con.sql("SELECT raw_output FROM raw_trace WHERE run_id = 'run-2'").fetchone()
        assert text is not None and "ünïcode" in text[0] and "\n" in text[0]
