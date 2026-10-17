"""Build only the photo-traced courtyard paving, draped over the exported DEM.

Run from the repo with bun run py <absolute path to this script>. Writes only
the course-local courtyard.json and a local review image, never external assets.
"""
from pathlib import Path
import argparse
import hashlib
import json
import math
import numpy as np
import rasterio
from scipy.ndimage import map_coordinates
from shapely import constrained_delaunay_triangles
from shapely.geometry import Polygon, box, mapping
from shapely.ops import unary_union
from PIL import Image, ImageDraw

HERE=Path(__file__).resolve().parent
ROOT=HERE.parents[3]

def polygons(g):
    if g.geom_type=='Polygon':
        if g.area>1e-8: yield g
    elif hasattr(g,'geoms'):
        for child in g.geoms: yield from polygons(child)

def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

def main():
    ap=argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--dem',type=Path,default=Path('D:/gspro_courses/omberg-opcd/ombergs-golfklubb-inner-dem-1510m.tif'))
    ap.add_argument('--out',type=Path,default=HERE/'courtyard.json')
    ap.add_argument('--spacing',type=float,default=1.0)
    args=ap.parse_args()
    if not .25<=args.spacing<=2: raise ValueError('Grid spacing must be0.25..2 m')
    config_path=HERE/'vegetation-exclusions.json'; survey_path=HERE/'survey.json'
    config=json.loads(config_path.read_text()); survey=json.loads(survey_path.read_text())
    traced=Polygon(config['pavedCourtyard3006'])
    roofs=unary_union([Polygon(b['footprint3006']) for b in survey['buildings']]+[Polygon(s['roofEdge3006']) for s in survey['interpretedRoofSections']])
    # Exact current model.py entry_details apron: front=L/2+.015, then
    # a3.1x7m brick box from that front plane outward, at foyer rotation31deg.
    center=(477805.,6457673.67); angle=math.radians(31)
    front=3.85/2+.015
    def en(x,y):
        return (center[0]+x*math.cos(angle)-y*math.sin(angle),center[1]+x*math.sin(angle)+y*math.cos(angle))
    apron=Polygon([en(front,-3.5),en(front+3.1,-3.5),en(front+3.1,3.5),en(front,3.5)])
    foyer=Polygon([en(-3.85/2,-2.75),en(3.85/2,-2.75),en(3.85/2,2.75),en(-3.85/2,2.75)])
    excluded=unary_union([roofs,foyer,apron])
    paving=traced.difference(excluded)
    if not paving.is_valid or paving.is_empty: raise ValueError('No valid courtyard paving remains')
    coords=[]; lookup={}; tris=[]; shapes=[]
    def index(pt):
        key=(round(pt[0],6),round(pt[1],6))
        if key not in lookup:
            lookup[key]=len(coords);coords.append(key)
        return lookup[key]
    w,s,e,n=paving.bounds; spacing=args.spacing
    for x in np.arange(math.floor(w/spacing)*spacing,e,spacing):
        for y in np.arange(math.floor(s/spacing)*spacing,n,spacing):
            cell=paving.intersection(box(x,y,x+spacing,y+spacing))
            for p in polygons(cell):
                for t in constrained_delaunay_triangles(p).geoms:
                    if t.area<1e-9: continue
                    xy=list(t.exterior.coords)[:3]
                    cross=(xy[1][0]-xy[0][0])*(xy[2][1]-xy[0][1])-(xy[1][1]-xy[0][1])*(xy[2][0]-xy[0][0])
                    if cross<0: xy.reverse()
                    tri=[index(a) for a in xy]
                    if len(set(tri))<3: continue
                    tris.append(tri);shapes.append(Polygon([coords[i] for i in tri]))
    origin=(477808.,6457659.)
    with rasterio.open(args.dem) as dem:
        if dem.crs.to_epsg()!=3006: raise ValueError('DEM must useEPSG:3006')
        band=dem.read(1); inverse=~dem.transform
        def sample(points):
            pts=np.asarray(points); cc,rr=inverse*(pts[:,0],pts[:,1])
            return map_coordinates(band,np.array([rr-.5,cc-.5]),order=1,mode='nearest').astype(float)
        base=float(sample([origin])[0]); levels=sample(coords)
        lift=.035
        verts=[[a,b,round(float(z)+lift,6)] for (a,b),z in zip(coords,levels)]
        dem_info=dict(path=str(args.dem),sha256=digest(args.dem),resolutionM=list(dem.res),crs=str(dem.crs),sampling='Bilinear at DEM pixel centres; exported edited inner terrain')
    coverage=unary_union(shapes)
    missed=paving.difference(coverage).area; outside=coverage.difference(paving).area
    overlap=sum(p.area for p in shapes)-coverage.area
    excluded_overlap=coverage.intersection(excluded).area
    if max(missed,outside,overlap,excluded_overlap)>1e-4: raise ValueError(f'Coverage failed:{missed},{outside},{overlap},{excluded_overlap}')
    result=dict(format='omberg-courtyard-mesh-v1',crs='EPSG:3006',verticalDatum='RH2000',units='metres',
        origin=dict(e=origin[0],n=origin[1],groundAbsM=base),
        placement=dict(yawDeg=90,ground='centre',knownUnityGroundAbsM=109.1571235,suggestedDz=round(base-109.1571235,7),unityFrame=dict(west=477021,south=6456736,minAbsM=80.76200103759766)),
        vertices3006=verts,triangles=tris,
        material=dict(type='fine-asphalt',suggestedName='omberg_courtyard_asphalt',colorSRGB=[101,99,96],smoothness=.08,metallic=0,textureTileM=2.0),
        geometry=dict(gridSpacingM=spacing,liftM=lift,pavingAreaM2=round(paving.area,4),outline3006=mapping(paving),sourcePavedPolygon3006=config['pavedCourtyard3006'],excludedBrickApron3006=list(apron.exterior.coords),excludedFoyer3006=list(foyer.exterior.coords)),
        provenance=dict(dem=dem_info,survey=dict(path=str(survey_path),sha256=digest(survey_path)),pavedTrace=dict(path=str(config_path),sha256=digest(config_path)),entryApron='Exact current model.py entry_details box3.1x7m; foyer center477805/6457673.67, depth3.85,width5.5,yaw59deg bearing, Blenderrot31deg',surfaceEvidence='2025 north-up0.16m ortho: continuous grey/red courtyard paving. User entry photographs show mostly asphalt with a small brick apron; apron is excluded here.'),
        validation=dict(vertices=len(verts),triangles=len(tris),heightRangeAbsM=[round(float(min(levels))+lift,4),round(float(max(levels))+lift,4)],uncoveredAreaM2=missed,outsideTraceAreaM2=outside,overlapAreaM2=overlap,roofOrApronOverlapAreaM2=excluded_overlap),
        limitations=['Photo outline approximately0.5–1m uncertain.','Drapes the exported edited DEM, not a new Unity collider probe per vertex; inspect against the course meshes before final placement.','No terrain, database, playing surfaces or surrounding lawn is changed.','Regenerate after DEM or entry-apron geometry changes.','The roof and brick-apron exclusions are planar; the existing brick apron supplies its own visible top surface.'])
    args.out.write_text(json.dumps(result,indent=2)+'\n')
    image_path=ROOT/'data/omberg-clubhouse/ortho-2025.png'
    if image_path.exists():
        im=Image.open(image_path);draw=ImageDraw.Draw(im)
        for p in polygons(paving):
            for ring in [p.exterior]+list(p.interiors):
                draw.line([((a-477750)/.16,(6457790.13-b)/.16) for a,b in ring.coords],fill='#ff45ed',width=3)
        im.save(ROOT/'data/omberg-clubhouse/courtyard-paving-review.png')
    print(json.dumps(dict(output=str(args.out),origin=result['origin'],placement=result['placement'],validation=result['validation']),indent=2))

if __name__=='__main__':main()
