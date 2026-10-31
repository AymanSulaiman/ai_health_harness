"""Every distinct drug Synthea prescribes, for agent v2's lookup_medication tool.

Writes data/med_reference.json: [{"name": ..., "rxnorm": ...}], sorted by name.
"""

import json
from pathlib import Path

import duckdb

from ai_health_harness.synthea import WAREHOUSE

OUT = Path("data/med_reference.json")

QUERY = """
select distinct
    medicationCodeableConcept.coding[1].display as name,
    medicationCodeableConcept.coding[1].code as rxnorm
from raw_fhir.medication_request
order by name
"""


def run() -> None:
    with duckdb.connect(str(WAREHOUSE), read_only=True) as con:
        rows = [{"name": name, "rxnorm": rxnorm} for name, rxnorm in con.sql(QUERY).fetchall()]
    OUT.write_text(json.dumps(rows, indent=1) + "\n")
    print(f"{len(rows)} drugs -> {OUT}")
