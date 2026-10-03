"""Generate a reproducible synthetic population with Synthea and load it into DuckDB.

Synthea (a pinned release, run in a Java container so no local Java is needed) writes
FHIR R4 bulk-data ndjson, one file per resource type, into a temporary folder. The same
seed and settings give byte-identical output. Each resource type becomes one table in
the raw_fhir schema of data/warehouse.duckdb.
"""

import hashlib
import os
import re
import subprocess
import tempfile
from pathlib import Path

import duckdb
import httpx

# the project's one DuckDB file; this step owns only its raw_fhir schema
WAREHOUSE = Path("data/warehouse.duckdb")
JAR_DIR = Path("data/cache")
SYNTHEA_VERSION = "v4.0.0"
SYNTHEA_JAR_URL = (
    "https://github.com/synthetichealth/synthea/releases/download/"
    f"{SYNTHEA_VERSION}/synthea-with-dependencies.jar"
)
SYNTHEA_SHA256 = "ed43c20ad40ba5c3bc724503a5af032715fe3c491620b766148e7c2361e6ecc1"
JAVA_IMAGE = (
    "eclipse-temurin:21-jre"
    "@sha256:cff19e6215689161eb6162c11b86b0c60ddf802164f2eaf48d570f8fb79a36c5"
)
SEED = 42
# living patients; Synthea also exports the ones who died along the way
POPULATION = 2000
SIMULATION_END = "20260101"  # fixed, or ages and open encounters follow the wall clock
# KAN-11's resources. Synthea always adds Patient and Encounter.
RESOURCES = "Condition,MedicationRequest,AllergyIntolerance,Observation"


def fetch_jar(jar_dir: Path = JAR_DIR) -> Path:
    """Download the pinned Synthea jar once; refuse it unless the checksum matches."""
    jar = jar_dir / f"synthea-{SYNTHEA_VERSION}.jar"
    if jar.exists():
        return jar
    jar_dir.mkdir(parents=True, exist_ok=True)
    part = jar.with_suffix(".part")
    with httpx.stream("GET", SYNTHEA_JAR_URL, follow_redirects=True, timeout=120) as r:
        r.raise_for_status()
        with part.open("wb") as f:
            for chunk in r.iter_bytes():
                f.write(chunk)
    with part.open("rb") as f:
        digest = hashlib.file_digest(f, "sha256").hexdigest()
    if digest != SYNTHEA_SHA256:
        part.unlink()
        raise ValueError(f"{SYNTHEA_JAR_URL}: sha256 {digest} != {SYNTHEA_SHA256}")
    part.rename(jar)
    return jar


def generate(out: Path, seed: int = SEED, population: int = POPULATION) -> Path:
    """Run Synthea into out/ (an empty folder); returns the folder of fhir/*.ndjson."""
    jar = fetch_jar()
    subprocess.run(
        [
            "docker", "run", "--rm",
            "--user", f"{os.getuid()}:{os.getgid()}",  # output owned by you, not root
            "-v", f"{jar.parent.resolve()}:/synthea:ro",
            "-v", f"{out.resolve()}:/out",
            "-w", "/out",
            JAVA_IMAGE,
            "java", "-jar", f"/synthea/{jar.name}",
            "-s", str(seed),
            "-cs", str(seed),  # clinician seed
            "-p", str(population),
            "-r", SIMULATION_END,
            "-e", SIMULATION_END,
            # threads make row order and some location references vary between runs
            "--generate.thread_pool_size=1",
            "--exporter.baseDirectory=/out",
            "--exporter.fhir.bulk_data=true",  # ndjson per resource type, not per patient
            f"--exporter.fhir.included_resources={RESOURCES}",
            "--exporter.hospital.fhir.export=false",
            "--exporter.practitioner.fhir.export=false",
            "--exporter.metadata.export=false",  # its file name is the wall-clock time
        ],
        check=True,
    )  # fmt: skip
    return out / "fhir"


def load_fhir(fhir_dir: Path, db: Path = WAREHOUSE) -> list[str]:
    """Replace the raw_fhir schema with one table per resource type, as Synthea wrote it.

    Tables are snake_case (MedicationRequest -> raw_fhir.medication_request). DuckDB
    infers the nested columns from every row, so `subject.reference` or
    `code.coding[1].display` query directly. Other schemas in the file are left alone.
    """
    tables = []
    db.parent.mkdir(parents=True, exist_ok=True)
    with duckdb.connect(db) as con:
        con.execute("DROP SCHEMA IF EXISTS raw_fhir CASCADE")
        con.execute("CREATE SCHEMA raw_fhir")
        for src in sorted(fhir_dir.glob("*.ndjson")):
            table = re.sub(r"(?<!^)(?=[A-Z])", "_", src.stem).lower()
            if not table.replace("_", "").isalpha():
                raise ValueError(f"{src.name}: not a resource type name")
            con.execute(
                f"CREATE TABLE raw_fhir.{table} AS SELECT * FROM read_json("
                "?, format = 'newline_delimited', sample_size = -1)",
                [str(src)],
            )
            tables.append(f"raw_fhir.{table}")
    return tables


def run(
    seed: int = SEED, population: int = POPULATION, db: Path = WAREHOUSE
) -> list[str]:
    # Synthea's own files are only needed until they are loaded; the same seed
    # regenerates them byte for byte
    with tempfile.TemporaryDirectory() as tmp:
        tables = load_fhir(generate(Path(tmp), seed, population), db)
    for table in tables:
        print(table)
    print(f"{len(tables)} raw_fhir tables -> {db}")
    return tables
