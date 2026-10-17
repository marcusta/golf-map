"""The vegetation generators' rules, read from pipeline/vegetation-rules/<source>.json.

Each generator script (grass_zones.py = tall-grass, woodland_floor_zones.py =
woodland-floor, rock_shore_zones.py = rock-shore, creek_bank_zones.py =
creek-bank) keeps the numbers and lists that decide where and how its
vegetation grows in that file, each with its unit and a line on what it does,
and binds them to its module constants at import:

    R = vegetation_rules.load("tall-grass")
    DEFAULT_MAX_DISTANCE_M = R["max-distance"]

The same files feed the web app's rules view (server VegetationRulesService),
so what is shown there is what the scripts plant with.

A course changes a rule in docs/gspro/<course>/vegetation-rules.json under the
generator's source. A rule the script has a flag for (`"flag": true`) reaches
it as that flag, as before; every other rule reaches it as
`--rule-overrides '{"<source>": {"<rule>": <value>}, ...}'` (every
generator's, so a rule another script imports - CLEARANCES, Rules - has the
course's value there too). The loader reads that flag from sys.argv at import,
since the constants are bound then; main() only declares it
(`add_overrides_flag`) so argparse accepts it.

JSON lists come back as tuples (the constants were tuples), lists of objects
as tuples of dicts. Values are taken as written: 4.0 stays a float, 4 an int.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

RULES_DIR = Path(__file__).resolve().parent / "vegetation-rules"
FORMAT = "golfmap-vegetation-rule-defaults-v1"
OVERRIDES_FLAG = "--rule-overrides"


def _frozen(v):
    if isinstance(v, list):
        return tuple(_frozen(x) for x in v)
    if isinstance(v, dict):
        return {k: _frozen(x) for k, x in v.items()}
    return v


def read(source: str) -> dict:
    """The rules document of a generator, as written."""
    path = RULES_DIR / f"{source}.json"
    doc = json.loads(path.read_text(encoding="utf-8"))
    if doc.get("format") != FORMAT or doc.get("source") != source:
        raise SystemExit(f"error: {path} is not a {FORMAT} file for '{source}'")
    return doc


def rules_of(doc: dict) -> list[dict]:
    """Every rule entry of a document, in order: {key, value, ...}."""
    return [r for g in doc.get("groups", []) for r in g.get("rules", [])]


def overrides_from_argv(argv: list[str] | None = None) -> dict:
    """The `--rule-overrides <json>` of the command line, {} without one."""
    argv = sys.argv if argv is None else argv
    for i, a in enumerate(argv):
        if a == OVERRIDES_FLAG and i + 1 < len(argv):
            return json.loads(argv[i + 1])
        if a.startswith(OVERRIDES_FLAG + "="):
            return json.loads(a[len(OVERRIDES_FLAG) + 1:])
    return {}


def load(source: str, overrides: dict | None = None) -> dict:
    """{rule key: value} of a generator: its file, with the course's overrides for it on top
    (`overrides`, default: the command line's --rule-overrides). An unknown key is an error."""
    values = {r["key"]: _frozen(r["value"]) for r in rules_of(read(source))}
    own = (overrides_from_argv() if overrides is None else overrides).get(source, {})
    for key, value in own.items():
        if key not in values:
            raise SystemExit(f"error: --rule-overrides: '{source}' has no rule '{key}' (pipeline/vegetation-rules/{source}.json)")
        values[key] = _frozen(value)
    return values


def add_overrides_flag(parser) -> None:
    """Declare --rule-overrides on a script's parser (load() has read it already)."""
    parser.add_argument(OVERRIDES_FLAG, metavar="JSON",
                        help="the course's rules without a flag of their own, by generator source "
                             "(read at import: pipeline/vegetation_rules.py)")
