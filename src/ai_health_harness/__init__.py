"""The whole pipeline behind one command. Run it from the repository root.

uv run ai-health-harness              every step, in order
uv run ai-health-harness generate     generate seeded Synthea patients into DuckDB
"""

import sys
import time


def generate() -> None:
    from ai_health_harness import synthea

    synthea.run()


STEPS = {"generate": generate}


def main() -> None:
    args = sys.argv[1:]
    if len(args) > 1 or (args and args[0] not in STEPS):
        sys.exit(__doc__)
    for name in args or STEPS:
        started = time.monotonic()
        print(f"== {name}", flush=True)
        STEPS[name]()  # an exception stops the pipeline with a non-zero exit
        print(f"== {name} done in {time.monotonic() - started:.0f}s", flush=True)
