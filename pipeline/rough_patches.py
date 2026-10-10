"""Cut one deep rough field into blond / hummock / weedy patches from the orthophoto.

    cd <repo> && pipeline/.venv/Scripts/python.exe pipeline/rough_patches.py <out.geojson> <preview.png> <deep_rough id prefix>
    bun run zones -- add <course> rough_tall --from-geojson <out.geojson> --feather 0.5 --noise 0

Dark, textured ground becomes weedy, pale mottled ground and a ragged rim become hummock, the
rest blond. The polygons are disjoint (hand-drawn zones add up where they overlap). Vreta's
2025 orthophoto path is hard-coded below; see .claude/skills/grass-planting/SKILL.md.
"""
import sys, json, sqlite3, numpy as np, rasterio
sys.path.insert(0, "pipeline")
import gspro
from rasterio.windows import from_bounds
from rasterio import features as rfeat
from rasterio.transform import from_origin
from scipy import ndimage as ndi
from shapely.geometry import shape, mapping
from shapely.ops import unary_union
from PIL import Image

out_json, out_png = sys.argv[1], sys.argv[2]
CELL = 0.5
db = sqlite3.connect("data/app.sqlite")
gj = json.loads(db.execute("select geometry_json from course_features where id like ?", (sys.argv[3] + '%',)).fetchone()[0])
field = gspro._zone_geometry_m(gj).buffer(0)
W, S_, E, N = [round(v) for v in (field.bounds[0]-4, field.bounds[1]-4, field.bounds[2]+4, field.bounds[3]+4)]
nx, ny = int((E-W)/CELL), int((N-S_)/CELL)
tf = from_origin(W, N, CELL, CELL)
with rasterio.open("data/sources/88E5F5B7-B1E6-4EBA-9D47-49B289C59EAE/ortho-orto-l2-2025.tif") as src:
    a = src.read([1,2,3], window=from_bounds(W,S_,E,N, src.transform), out_shape=(3, ny*3, nx*3), resampling=rasterio.enums.Resampling.bilinear).astype(float)
L = (0.2126*a[0]+0.7152*a[1]+0.0722*a[2])                       # ~0.17 m cells
fine_std = np.sqrt(np.maximum(ndi.uniform_filter(L**2, 9) - ndi.uniform_filter(L, 9)**2, 0))   # texture over ~1.5 m
down = lambda x: x.reshape(ny, 3, nx, 3).mean((1, 3))
Lc, Tc = ndi.gaussian_filter(down(L), 3), ndi.gaussian_filter(down(fine_std), 3)               # ~1.5 m sigma
inside = rfeat.rasterize([(mapping(field), 1)], out_shape=(ny, nx), transform=tf).astype(bool)
z = lambda x: (x - x[inside].mean()) / x[inside].std()
dist = ndi.distance_transform_edt(inside) * CELL
rng = np.random.default_rng(int(sys.argv[3][:6], 16))
blob = lambda feat_m: (lambda n: (n - n[inside].min()) / np.ptp(n[inside]))(ndi.gaussian_filter(rng.standard_normal((ny, nx)), feat_m/CELL/2))

weedy_score = -z(Lc) + 0.6*z(Tc)
weedy = inside & (dist > 3.0) & (weedy_score >= np.quantile(weedy_score[inside & (dist > 3.0)], 0.62))
rim_reach = 5.0 * min(1.0, (field.area / 3260) ** 0.5) * np.clip((blob(9) - 0.38) / 0.62, 0, 1) * 2          # 0 on ~40 % of the edge, up to ~10 m in
pale_score = z(Lc) + 0.8*z(Tc)
hummock = inside & ((dist < rim_reach) | (pale_score >= np.quantile(pale_score[inside], 0.90)))
hummock |= inside & (dist > 6) & (blob(7) > 0.80)                      # a few islands inside
clean = lambda m: ndi.binary_opening(ndi.binary_closing(m, iterations=3), iterations=2)
hummock = clean(hummock) & inside
weedy = clean(weedy & ~hummock) & inside & ~hummock

def polys(mask, min_area):
    gs = [shape(g).buffer(0) for g, v in rfeat.shapes(mask.astype(np.uint8), mask=mask, transform=tf) if v == 1]
    gs = [g.buffer(0.6).buffer(-0.6).simplify(0.35) for g in gs]
    return unary_union([g for g in gs if g.area >= min_area]).intersection(field)
h = polys(hummock, 12); w = polys(weedy, 30).difference(h.buffer(0.01)); b = field.difference(unary_union([h, w]).buffer(0.01))
feats = []
for key, g in (("blond", b), ("hummock", h), ("weedy", w)):
    parts = [p for p in getattr(g, "geoms", [g]) if p.geom_type == "Polygon" and p.area >= 4]
    print(key, f"{sum(p.area for p in parts):.0f} m2 ({sum(p.area for p in parts)/field.area:.0%})", len(parts), "polygons")
    for p in parts:
        feats.append({"type": "Feature", "properties": {"variant": key, "areaM2": round(p.area)},
                      "geometry": {"type": "Polygon", "coordinates": [[[round(x, 2), round(y, 2)] for x, y in r.coords] for r in [p.exterior, *p.interiors]]}})
json.dump({"type": "FeatureCollection", "crs": "EPSG:3006", "features": feats}, open(out_json, "w"))
# preview: ortho with the classes tinted
img = np.moveaxis(a, 0, -1).reshape(ny, 3, nx, 3, 3).mean((1, 3))
cls = rfeat.rasterize([(mapping(shape(f["geometry"])), {"blond": 1, "hummock": 2, "weedy": 3}[f["properties"]["variant"]]) for f in feats], out_shape=(ny, nx), transform=tf)
for v, col in ((1, (235, 215, 120)), (2, (120, 70, 40)), (3, (150, 90, 200))):
    img[cls == v] = 0.55*img[cls == v] + 0.45*np.array(col)
Image.fromarray(img.astype(np.uint8)).resize((nx*6, ny*6), Image.NEAREST).save(out_png)
