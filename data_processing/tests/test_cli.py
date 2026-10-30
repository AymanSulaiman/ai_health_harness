import pytest

import ai_health_harness as cli


@pytest.fixture
def calls(monkeypatch):
    calls: list = []
    steps = {
        "first": lambda: calls.append("first"),
        "second": lambda: calls.append("second"),
    }
    monkeypatch.setattr(cli, "STEPS", steps)
    return calls


def run(monkeypatch, *args: str) -> None:
    monkeypatch.setattr(cli.sys, "argv", ["ai-health-harness", *args])
    cli.main()


def test_steps_run_in_pipeline_order():
    assert list(cli.STEPS) == ["generate", "ground-truth", "notes"]


def test_no_arguments_runs_every_step_in_order(monkeypatch, calls):
    run(monkeypatch)
    assert calls == ["first", "second"]


def test_a_step_name_runs_only_that_step(monkeypatch, calls):
    run(monkeypatch, "second")
    assert calls == ["second"]


@pytest.mark.parametrize("args", [["nope"], ["first", "second"]])
def test_anything_else_prints_usage_and_runs_nothing(monkeypatch, calls, args):
    with pytest.raises(SystemExit) as exit_info:
        run(monkeypatch, *args)
    assert "uv run --project data_processing ai-health-harness" in str(exit_info.value.code)
    assert calls == []


def test_a_failing_step_stops_the_pipeline(monkeypatch, calls):
    def boom() -> None:
        raise RuntimeError("download failed")

    monkeypatch.setitem(cli.STEPS, "first", boom)
    with pytest.raises(RuntimeError):
        run(monkeypatch)
    assert calls == []  # the second step never ran
