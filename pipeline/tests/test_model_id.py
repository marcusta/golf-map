"""The model id grammar against shared/vegetation/model-ids.fixture.json, the table its TypeScript twin
(shared/vegetation/model-id.ts, model-id.test.ts) and Unity's GolfMapModels.TryParse read too."""
import json
from pathlib import Path

import arborist

FIXTURE = json.loads((Path(__file__).resolve().parents[2] / "shared" / "vegetation" / "model-ids.fixture.json").read_text(encoding="utf-8"))


def test_good_ids_parse_to_renderer_and_label_and_build_back():
    for good in FIXTURE["good"]:
        assert arborist.parse_model_id(good["id"]) == (good["renderer"], good["label"]), good["id"]
        assert arborist.model_id(good["renderer"], good["label"], good.get("variant"), good.get("texture", False)) == good["id"]


def test_bad_ids_are_no_ids():
    for bad in FIXTURE["bad"]:
        assert arborist.parse_model_id(bad) == (None, bad), bad
