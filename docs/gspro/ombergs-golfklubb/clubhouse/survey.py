"""Read-only local survey of Omberg's clubhouse; run with bun run py <absolute script>."""
from pathlib import Path
import json
import math
import numpy as np
import rasterio
from rasterio.windows import from_bounds
from PIL import Image, ImageDraw, ImageFont
import laspy
from laspy import CopcReader
from laspy.copc import Bounds
from shapely.geometry import Polygon
from shapely import contains_xy

ROOT = Path(__file__).resolve().parents[4]
SOURCE = ROOT / 'data/sources/317d1f83-3ade-431c-8201-605ac0bd2871'
OUT = ROOT / 'data/omberg-clubhouse'
OUT.mkdir(parents=True, exist_ok=True)
BOUNDS = (477750, 6457610, 477960, 6457790)
PX_ORIGIN=(477750.,6457790.13)
def en(pixels):
    return [[round(PX_ORIGIN[0]+x*.16,2),round(PX_ORIGIN[1]-y*.16,2)] for x,y in pixels]

def robust_plane(points):
    p=points.copy(); origin=p[:,:2].mean(axis=0)
    for i in range(6):
        design=np.column_stack((p[:,:2]-origin,np.ones(len(p))))
        fit=np.linalg.lstsq(design,p[:,2],rcond=None)[0]
        err=p[:,2]-design@fit
        keep=np.abs(err)<max(.15,3*np.median(np.abs(err)))
        if keep.all(): break
        p=p[keep]
    return dict(originEN=origin.tolist(),slopeE=float(fit[0]),slopeN=float(fit[1]),zAtOrigin=float(fit[2]),points=len(p),rmseM=float(np.sqrt(np.mean(err**2))))

def measurements(points):
    features=json.loads((SOURCE/'buildings.geojson').read_text())['features']
    rows=[]
    with rasterio.open(SOURCE/'dem.tif') as dem:
        for ft in features:
            r=ft['properties']['rect']
            if not (BOUNDS[0]<r['cx']<BOUNDS[2] and BOUNDS[1]<r['cy']<BOUNDS[3]): continue
            poly=Polygon(ft['geometry']['coordinates'][0])
            ground=points[contains_xy(poly.buffer(3).difference(poly.buffer(.5)),points[:,0],points[:,1])&(points[:,3]==2)]
            roof=points[contains_xy(poly.buffer(-.6),points[:,0],points[:,1])&(points[:,3]==1)]
            row=dict(id=ft['properties']['id'],rect=r,footprint3006=ft['geometry']['coordinates'][0],axisBearingFromNorthDeg=round((90-r['angleDeg'])%180,1),groundMedianAbsM=float(np.median(ground[:,2])) if len(ground) else None,groundRangeP10P90AbsM=np.percentile(ground[:,2],[10,90]).tolist() if len(ground) else None,groundPoints=len(ground),roofAbsoluteQuantilesP05P20P50P95P99=np.percentile(roof[:,2],[5,20,50,95,99]).tolist() if len(roof) else None,roofPoints=len(roof),existingNDSMPercentiles=dict(eaveM=ft['properties']['eaveM'],ridgeM=ft['properties']['ridgeM']))
            if ft['properties']['osm_id'] in [687779185,687779186,687779187,1431566994,687779190]:
                # Porches make the minimum whole-polygon rectangle wider than
                # the principal gable. Use the four main wall corners instead.
                fit_rect=dict(r)
                if ft['properties']['osm_id']==687779185: fit_rect.update(cx=477790.75,cy=6457763.78,widthM=12.63)
                if ft['properties']['osm_id']==687779186: fit_rect.update(cx=477780.10,cy=6457724.03,widthM=13.25)
                theta=np.radians(fit_rect['angleDeg']); u=np.array([np.cos(theta),np.sin(theta)]); v=np.array([-u[1],u[0]])
                local=roof[:,:2]-[fit_rect['cx'],fit_rect['cy']]; along=local@u; across=local@v
                row['principalGableRect']=fit_rect
                row['simpleGableFits']={}
                for side in [-1,1]:
                    valid=(abs(along)<fit_rect['lengthM']*.36)&(across*side>fit_rect['widthM']*.12)&(across*side<fit_rect['widthM']*.36)
                    if sum(valid)>20: row['simpleGableFits'][str(side)]=robust_plane(roof[valid])
                fits=row['simpleGableFits']
                if len(fits)==2:
                    a=fits['-1']; b=fits['1']; center=np.array([fit_rect['cx'],fit_rect['cy']])
                    za=a['zAtOrigin']+np.dot(center-a['originEN'],[a['slopeE'],a['slopeN']]); zb=b['zAtOrigin']+np.dot(center-b['originEN'],[b['slopeE'],b['slopeN']])
                    sa=np.dot(v,[a['slopeE'],a['slopeN']]); sb=np.dot(v,[b['slopeE'],b['slopeN']])
                    if abs(sa-sb)>.1:
                        cross=(zb-za)/(sa-sb); ridge=center+cross*v
                        row['inferredGableAtMidLength']=dict(ridgeEN=ridge.tolist(),ridgeAbsM=float(za+cross*sa),eaveMinusAbsM=float(za-sa*fit_rect['widthM']/2),eavePlusAbsM=float(zb+sb*fit_rect['widthM']/2),caveat='Eaves evaluated at principal OSM wall lines, not traced roof edge; ±0.3-0.6 m for model use.')
            rows.append(row)
    # These additional roof extents are interpretations of the two orthos and
    # the actual lidar returns. They are deliberately distinct from OSM walls.
    sections=[
        dict(id='clubhouse-west-low',roofEdge3006=en([(244,678),(333,680),(333,978),(244,974)]),note='Long red western wing. Roof includes part of west veranda; wall polygon is narrower. Approximate roof-edge tracing ±1 m.'),
        dict(id='clubhouse-east-tall',roofEdge3006=en([(321,795),(420,795),(420,753),(468,753),(478,981),(320,979)]),note='Broad tall red eastern roof, including north-facing courtyard notch; west valley meets the lower roof. Approximate roof-edge tracing ±1 m.'),
        dict(id='white-diagonal-link',roofEdge3006=en([(177,505),(255,457),(330,588),(251,625)]),note='White metal tall connector roof, present in 2023 and 2025, omitted from OSM. Ortho roof lean and roof boundary ambiguity ±1.5 m.'),
        dict(id='white-straight-link',roofEdge3006=en([(251,609),(330,590),(331,693),(252,691)]),note='White connector southern bent leg; overlaps diagonal roof. Trace ±1.5 m.'),
    ]
    for row in sections:
        poly=Polygon(row['roofEdge3006'])
        q=points[contains_xy(poly,points[:,0],points[:,1])&(points[:,3]==1)]
        row['roofAbsQuantilesP05P20P50P95P99']=np.percentile(q[:,2],[5,20,50,95,99]).tolist()
        row['points']=len(q)
    # Fit only coherent patches away from ridge/valley/roof-edge mixed returns.
    patches={'west-wing-west-slope':(477790,477795,6457647,6457674),'west-wing-east-slope':(477797,477801,6457647,6457674),'tall-roof-west-slope':(477804,477815,6457640,6457658),'tall-roof-east-slope':(477820,477825,6457640,6457658)}
    planes={}
    for key,(w,e,s,n) in patches.items():
        q=points[(points[:,3]==1)&(points[:,0]>w)&(points[:,0]<e)&(points[:,1]>s)&(points[:,1]<n)&(points[:,2]>111)]
        planes[key]=robust_plane(q)
    data=dict(crs='EPSG:3006',verticalDatum='RH2000 (source lidar/DEM; metres)',sourceSite=str(SOURCE),sourceOrthoResolutionM=.16,lidarCropPoints=len(points),orthoBounds3006=BOUNDS,uncertainty='OSM corners retain source decimal coordinates, not centimetre survey accuracy. Roof traces are approximate; sparse lidar supports plane heights to about 0.2m but edges to roughly 0.5-1.5m. Existing eaveM/ridgeM are nDSM distribution percentiles, not wall/eave levels.',buildings=rows,interpretedRoofSections=sections,roofPlanes=planes,unityFrame=dict(west=477021,south=6456736,minAbsM=80.76200103759766),images=dict(ortho2025=str(OUT/'ortho-2025-osm.png'),ortho2023=str(OUT/'ortho-2023-osm.png'),lidarHeight=str(OUT/'lidar-height-top.png')))
    (Path(__file__).parent/'survey.json').write_text(json.dumps(data,indent=2)+'\n')
    print(json.dumps(planes,indent=2))
    draw_evidence(points,data)

def draw_evidence(points,data):
    fontpath='C:/Windows/Fonts/arial.ttf'
    font=ImageFont.truetype(fontpath,18); small=ImageFont.truetype(fontpath,14); title=ImageFont.truetype(fontpath,25)
    im=Image.open(OUT/'ortho-2025.png'); draw=ImageDraw.Draw(im)
    colors=['#45ffff','#ffdf55','#ff87fc','#73ff73']
    for row,color in zip(data['interpretedRoofSections'],colors):
        coords=[((e-PX_ORIGIN[0])/.16,(PX_ORIGIN[1]-n)/.16) for e,n in row['roofEdge3006']]
        draw.line(coords+[coords[0]],fill=color,width=3)
    labels=[((180,285),'NW red gable: ridge 114.8 m'),((55,45),'N red gable: ridge 114.1 m'),((730,95),'NE red gable: ridge 116.9 m'),((830,560),'E block: ridge 121.0 m'),((20,625),'White link: ridge ~121.0 m'),((20,1000),'Low west wing: ridge 115.2 m'),((440,1025),'Tall east roof: ridge 120.0 m')]
    for pos,txt in labels: draw.text(pos,txt,font=font,fill='white',stroke_width=3,stroke_fill='black')
    draw.text((15,1100),'EPSG:3006 | North up | Absolute roof elevations RH2000 | Roof edges approximate',font=small,fill='white',stroke_width=2,stroke_fill='black')
    im.save(OUT/'survey-annotated-ortho.png')
    im=Image.new('RGB',(1300,800),'white'); d=ImageDraw.Draw(im)
    d.text((38,24),'Omberg clubhouse: measured lidar cross-section',font=title,fill='black')
    d.text((38,59),'Points at N 6457649..6457655; both roofs have ~22 degree pitches. Vertical scale exaggerated.',font=font,fill='black')
    x0=477783; x1=477832; z0=107; z1=122
    def xy(e,z): return (90+(e-x0)/(x1-x0)*1150,700-(z-z0)/(z1-z0)*570)
    for z in range(108,123,2):
        a=xy(x0,z);b=xy(x1,z);d.line([a,b],fill='#dedede');d.text((28,a[1]-8),str(z),font=small,fill='black')
    for e in range(477785,477833,5):
        a=xy(e,z0);d.text((a[0]-28,715),str(e),font=small,fill='black')
    d.text((50,100),'Abs. elevation m',font=small,fill='black');d.text((555,755),'Easting EPSG:3006 (m)',font=font,fill='black')
    q=points[(points[:,1]>6457649)&(points[:,1]<6457655)&(points[:,0]>x0)&(points[:,0]<x1)]
    for e,n,z,c in q:
        x,y=xy(e,z);d.ellipse((x-1.6,y-1.6,x+1.6,y+1.6),fill='#427aa1' if c==1 else '#777777')
    for keys,interval in [(['west-wing-west-slope','west-wing-east-slope'],(477789,477796.3,477801.3)),(['tall-roof-west-slope','tall-roof-east-slope'],(477801.3,477817.5,477826.5))]:
        a,b=map(lambda k:data['roofPlanes'][k],keys)
        def z(p,e): return p['zAtOrigin']+p['slopeE']*(e-p['originEN'][0])+p['slopeN']*(6457652-p['originEN'][1])
        es=[interval[0],interval[1],interval[2]]; zs=[z(a,es[0]),z(a,es[1]),z(b,es[2])]
        d.line([xy(e,v) for e,v in zip(es,zs)],fill='#dc3737',width=4)
        d.text((xy(es[1],zs[1])[0]-90,xy(es[1],zs[1])[1]-30),f'Ridge {zs[1]:.1f} m',font=font,fill='#a52222')
    d.line([xy(x0,109.157),xy(x1,109.157)],fill='#168435',width=2)
    d.text((800,635),'Unity main pad ~109.16 m',font=font,fill='#168435')
    im.save(OUT/'survey-height-section.png')

def crop():
    for vintage in ['2023', '2025']:
        path = SOURCE / f'ortho-orto-l2-{vintage}.tif'
        with rasterio.open(path) as src:
            win = from_bounds(*BOUNDS, transform=src.transform).round_offsets().round_lengths()
            a = src.read([1,2,3], window=win)
            im = Image.fromarray(np.moveaxis(a,0,-1))
            im.save(OUT / f'ortho-{vintage}.png')
            draw=ImageDraw.Draw(im)
            transform=src.window_transform(win)
            for ft in json.loads((SOURCE/'buildings.geojson').read_text())['features']:
                r=ft['properties']['rect']
                if not (BOUNDS[0]<r['cx']<BOUNDS[2] and BOUNDS[1]<r['cy']<BOUNDS[3]): continue
                pts=[(~transform)*(e,n) for e,n in ft['geometry']['coordinates'][0]]
                draw.line(pts,fill='yellow',width=2)
                x,y=(~transform)*(r['cx'],r['cy'])
                draw.text((x,y),ft['properties']['id'].split('/')[-1],fill='red',stroke_width=1,stroke_fill='white')
            draw.text((15,15),f'Ortho {vintage} | EPSG:3006 | North up | yellow = OSM outline',fill='white',stroke_width=2,stroke_fill='black')
            im.save(OUT / f'ortho-{vintage}-osm.png')
            print(vintage,src.res,im.size,src.crs)

if __name__ == '__main__':
    crop()
    lidar_cache=OUT/'lidar-crop.npz'
    if not lidar_cache.exists():
        batches=[]
        for path in (SOURCE/'lidar').glob('*.laz'):
            with CopcReader.open(path) as src:
                if src.header.maxs[0]<BOUNDS[0] or src.header.mins[0]>BOUNDS[2] or src.header.maxs[1]<BOUNDS[1] or src.header.mins[1]>BOUNDS[3]: continue
                points=src.query(bounds=Bounds(np.array([BOUNDS[0],BOUNDS[1],-100]),np.array([BOUNDS[2],BOUNDS[3],1000])))
                batch=np.column_stack((points.x,points.y,points.z,points.classification))
                batches.append(batch)
                print('lidar',path.name,len(batch),flush=True)
        points=np.concatenate(batches)
        np.savez_compressed(lidar_cache,points=points)
    points=np.load(lidar_cache)['points']
    print('points',len(points),'classes',np.unique(points[:,3],return_counts=True))
    measurements(points)
    # Sparse point DSM is kept separate from the ground model; interpolating it
    # would make unsupported roof edges look more exact than the laser permits.
    res=.4
    nx=int((BOUNDS[2]-BOUNDS[0])/res); ny=int((BOUNDS[3]-BOUNDS[1])/res)
    dsm=np.full((ny,nx),-1000.,dtype=float)
    ix=np.clip(((points[:,0]-BOUNDS[0])/res).astype(int),0,nx-1)
    iy=np.clip(((BOUNDS[3]-points[:,1])/res).astype(int),0,ny-1)
    np.maximum.at(dsm,(iy,ix),points[:,2])
    with rasterio.open(SOURCE/'dem.tif') as src:
        xx,yy=np.meshgrid(BOUNDS[0]+(np.arange(nx)+.5)*res,BOUNDS[3]-(np.arange(ny)+.5)*res)
        rr,cc=rasterio.transform.rowcol(src.transform,xx,yy)
        dem=src.read(1)[rr,cc].reshape(ny,nx)
    h=np.clip(dsm-dem,0,18)
    rgb=np.zeros((ny,nx,3),dtype=np.uint8)
    rgb[:,:,0]=np.clip(h/12*255,0,255)
    rgb[:,:,1]=np.clip(255-abs(h-6)*30,0,255)
    rgb[:,:,2]=np.clip(255-h/12*255,0,255)
    rgb[dsm<0]=[30,30,30]
    im=Image.fromarray(rgb).resize((nx*3,ny*3))
    draw=ImageDraw.Draw(im)
    for ft in json.loads((SOURCE/'buildings.geojson').read_text())['features']:
        r=ft['properties']['rect']
        if not (BOUNDS[0]<r['cx']<BOUNDS[2] and BOUNDS[1]<r['cy']<BOUNDS[3]): continue
        pts=[((e-BOUNDS[0])/res*3,(BOUNDS[3]-n)/res*3) for e,n in ft['geometry']['coordinates'][0]]
        draw.line(pts,fill='white',width=2)
        draw.text(((r['cx']-BOUNDS[0])/res*3,(BOUNDS[3]-r['cy'])/res*3),ft['properties']['id'].split('/')[-1],fill='white')
    im.save(OUT/'lidar-height-top.png')
