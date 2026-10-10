import contextlib
import hashlib
import itertools
import json
from pathlib import Path

import duckdb
import pytest

from ai_health_harness import synthea

# --- jar ---------------------------------------------------------------------


def fake_download(monkeypatch, content: bytes) -> None:
    @contextlib.contextmanager
    def stream(*args, **kwargs):
        class Response:
            def raise_for_status(self) -> None:
                pass

            def iter_bytes(self):
                yield content

        yield Response()

    monkeypatch.setattr(synthea.httpx, "stream", stream)


def test_jar_is_downloaded_once_when_the_checksum_matches(monkeypatch, tmp_path):
    content = b"jar bytes"
    monkeypatch.setattr(synthea, "SYNTHEA_SHA256", hashlib.sha256(content).hexdigest())
    fake_download(monkeypatch, content)
    jar = synthea.fetch_jar(tmp_path)
    assert jar.read_bytes() == content
    fake_download(monkeypatch, b"would fail the checksum")
    assert synthea.fetch_jar(tmp_path) == jar  # cached, not downloaded again


def test_jar_with_the_wrong_checksum_is_rejected_and_not_kept(monkeypatch, tmp_path):
    fake_download(monkeypatch, b"tampered")
    with pytest.raises(ValueError, match="sha256"):
        synthea.fetch_jar(tmp_path)
    assert list(tmp_path.iterdir()) == []


# --- generation --------------------------------------------------------------


def test_generate_runs_pinned_synthea_with_the_seed(monkeypatch, tmp_path):
    jar = tmp_path / "cache" / "synthea-v4.0.0.jar"
    monkeypatch.setattr(synthea, "fetch_jar", lambda: jar)
    commands = []
    monkeypatch.setattr(
        synthea.subprocess, "run", lambda cmd, check: commands.append(cmd)
    )

    fhir = synthea.generate(tmp_path / "out", seed=7, population=50)

    assert fhir == tmp_path / "out" / "fhir"
    (cmd,) = commands
    assert cmd[:2] == ["docker", "run"] and synthea.JAVA_IMAGE in cmd
    flags = dict(itertools.pairwise(cmd))
    assert flags["-s"] == "7" and flags["-cs"] == "7" and flags["-p"] == "50"
    assert flags["-r"] == flags["-e"] == synthea.SIMULATION_END
    assert "--generate.thread_pool_size=1" in cmd
    assert "--exporter.fhir.bulk_data=true" in cmd
    assert f"--exporter.fhir.included_resources={synthea.RESOURCES}" in cmd


# --- duckdb ------------------------------------------------------------------


def write_fhir(fhir_dir: Path, files: dict[str, list[dict]]) -> None:
    fhir_dir.mkdir(parents=True, exist_ok=True)
    for name, rows in files.items():
        (fhir_dir / name).write_text("".join(json.dumps(r) + "\n" for r in rows))


def test_fhir_loads_into_one_raw_table_per_resource_type(tmp_path):
    fhir = tmp_path / "fhir"
    write_fhir(
        fhir,
        {
            "Patient.ndjson": [{"id": "p1", "name": [{"family": "Doe"}]}],
            "MedicationRequest.ndjson": [
                {
                    "id": "m1",
                    "subject": {"reference": "Patient/p1"},
                    "status": "active",
                },
                {"id": "m2", "subject": {"reference": "Patient/p1"}},  # absent -> null
            ],
        },
    )
    (fhir / "parameters.json").write_text("{}")  # bulk-data manifest: skipped
    db = tmp_path / "warehouse.duckdb"

    tables = synthea.load_fhir(fhir, db)

    assert tables == ["raw_fhir.medication_request", "raw_fhir.patient"]
    with duckdb.connect(db) as con:
        rows = con.sql(
            "SELECT p.name[1].family, m.id, m.status FROM raw_fhir.medication_request m"
            " JOIN raw_fhir.patient p ON m.subject.reference = 'Patient/' || p.id"
            " ORDER BY m.id"
        ).fetchall()
    assert rows == [("Doe", "m1", "active"), ("Doe", "m2", None)]


def test_reloading_replaces_raw_fhir_and_keeps_other_schemas(tmp_path):
    fhir = tmp_path / "fhir"
    db = tmp_path / "warehouse.duckdb"
    write_fhir(
        fhir, {"Patient.ndjson": [{"id": "p1"}], "Condition.ndjson": [{"id": "c"}]}
    )
    synthea.load_fhir(fhir, db)
    with duckdb.connect(db) as con:
        con.execute("CREATE SCHEMA traces; CREATE TABLE traces.runs AS SELECT 1 AS id")

    (fhir / "Condition.ndjson").unlink()  # this run has no conditions
    write_fhir(fhir, {"Patient.ndjson": [{"id": "p2"}, {"id": "p3"}]})
    synthea.load_fhir(fhir, db)

    with duckdb.connect(db) as con:
        assert con.sql("SELECT id FROM raw_fhir.patient ORDER BY id").fetchall() == [
            ("p2",),
            ("p3",),
        ]
        names = con.sql(
            "SELECT table_schema || '.' || table_name FROM information_schema.tables"
            " ORDER BY 1"
        ).fetchall()
        assert names == [("raw_fhir.patient",), ("traces.runs",)]


def test_run_generates_into_a_temporary_folder_and_loads_it(monkeypatch, tmp_path):
    seen = []

    def fake_generate(out: Path, seed: int, population: int) -> Path:
        seen.append(out)
        write_fhir(out / "fhir", {"Patient.ndjson": [{"id": "p1"}]})
        return out / "fhir"

    monkeypatch.setattr(synthea, "generate", fake_generate)
    db = tmp_path / "warehouse.duckdb"

    assert synthea.run(db=db) == ["raw_fhir.patient"]
    assert not seen[0].exists()  # Synthea's files are cleaned up after loading
    with duckdb.connect(db) as con:
        assert con.sql("SELECT count(*) FROM raw_fhir.patient").fetchone() == (1,)
