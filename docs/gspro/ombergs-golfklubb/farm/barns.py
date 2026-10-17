"""Farm barns: the big west barn (OSM 1431566961) and the two long east barns (OSM 1431566959, 1431566960).

Placeholder: one plain gable box per OSM rectangle, so model.py runs end to end.
"""
import props_kit as kit

MATTE = set()
ASSETS = {"1431566961": "omberg_farm_big_barn", "1431566959": "omberg_farm_north_barn", "1431566960": "omberg_farm_south_barn"}


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
