"""Farm dwellings: the main house (OSM 1431566968) and the smaller east house (OSM 1431566962).

Placeholder: one plain gable box per OSM rectangle, so model.py runs end to end.
"""
import props_kit as kit

MATTE = set()
ASSETS = {"1431566968": "omberg_farm_main_house", "1431566962": "omberg_farm_east_house"}


def register_materials():
    pass


def build(add, new, ev):
    for osm_id, aid in ASSETS.items():
        f = ev.osm[osm_id]
        r = f["properties"]["rect"]
        g = new()
        kit.building(g, dict(length=r["lengthM"], width=r["widthM"], wall="falu_red_vertical", trim="white_trim",
                             roof=dict(type="gable", eave=3.0, ridge=6.0, mat="roof_metal_charcoal")))
        ground = 100.0
        add(aid, g, r["cx"], r["cy"], (90 - r["angleDeg"]) % 180, ground)
