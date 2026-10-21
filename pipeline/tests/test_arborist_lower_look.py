"""arborist.py lower: a zone item's Arborist model's own look wins over the course-wide plantSettings."""
import arborist

PLANT_SETTINGS = [{"match": ["*"], "tint": "#6f7c63", "even": True, "smoothness": 0, "renderDistance": 1.0}]


def item() -> dict:
    props = [{"PropertyName": name, "ColorValue": "RGBA(0.900, 0.900, 0.900, 1.000)"} for name in ("TintColor1", "TintColor2")]
    props.append({"PropertyName": "Smoothness", "FloatValue": 1})
    return {"Name": "Woodland edge - hazel", "ShaderControllerSettings": {"ControlerPropertyList": props}, "MinScale": 1, "MaxScale": 1}


def colours(it: dict) -> dict:
    return {p["PropertyName"]: p.get("ColorValue", p.get("FloatValue")) for p in it["ShaderControllerSettings"]["ControlerPropertyList"]}


def test_the_models_healthy_and_dry_win_over_a_plant_settings_tint():
    it = item()
    model = {"id": "arborist:MountainEnv_bush_hazel_01", "look": {"healthy": "#336633", "dry": "#999933"}}
    arborist.apply_look(it, arborist.lower_look_rules(PLANT_SETTINGS, model), also="MountainEnv_bush_hazel_01")
    assert colours(it)["TintColor1"] == arborist._hex_colour("#336633")
    assert colours(it)["TintColor2"] == arborist._hex_colour("#999933")   # not folded by plantSettings' even
    assert colours(it)["Smoothness"] == 0                                    # plantSettings' other keys still apply
    assert it["RenderDistanceFactor"] == 1.0


def test_a_model_without_colours_keeps_the_plant_settings_tint():
    it = item()
    model = {"id": "arborist:MountainEnv_bush_hazel_01", "look": {"saturation": 0.8}}
    rules = arborist.lower_look_rules(PLANT_SETTINGS, model)
    assert rules[0] == PLANT_SETTINGS[0]
    arborist.apply_look(it, rules, also="MountainEnv_bush_hazel_01")
    assert colours(it)["TintColor1"] == colours(it)["TintColor2"] == arborist._hex_colour("#6f7c63")


def test_a_models_own_tint_wins_too():
    it = item()
    model = {"id": "arborist:MountainEnv_bush_hazel_01", "look": {"tint": "#225522"}}
    arborist.apply_look(it, arborist.lower_look_rules(PLANT_SETTINGS, model), also="MountainEnv_bush_hazel_01")
    assert colours(it)["TintColor1"] == colours(it)["TintColor2"] == arborist._hex_colour("#225522")
