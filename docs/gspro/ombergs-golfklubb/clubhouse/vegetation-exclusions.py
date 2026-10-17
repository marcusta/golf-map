"""Course-local, reversible architecture clearance; dry run unless --apply.

Run with bun run py <this script> [--trees] [--zones] [--apply]. Reapply --zones
after any full zones export. This is an export overlay, not a database change.
"""
from pathlib import Path
from datetime import datetime
import argparse
import json
import shutil
import numpy as np
from PIL import Image, ImageDraw
from rasterio.features import rasterize
from rasterio.transform import from_bounds
from shapely.geometry import Polygon, Point, mapping
from shapely.ops import unary_union

HERE=Path(__file__).resolve().parent
ROOT=HERE.parents[3]
OUT=ROOT/'data/omberg-clubhouse'

def main():
    ap=argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--export',type=Path,default=Path('D:/gspro_courses/omberg-opcd'))
    ap.add_argument('--trees',action='store_true')
    ap.add_argument('--zones',action='store_true')
    ap.add_argument('--force-import',action='store_true',help='Include every current zone mask in the local Unity patch, even if source pixels already match.')
    mode=ap.add_mutually_exclusive_group()
    mode.add_argument('--apply',action='store_true',help='Write backed-up exports; otherwise report only.')
    mode.add_argument('--dry-run',action='store_true',help='Report only (the default).')
    args=ap.parse_args()
    if not args.trees and not args.zones: args.trees=args.zones=True
    config=json.loads((HERE/'vegetation-exclusions.json').read_text())
    survey=json.loads((HERE/'survey.json').read_text())
    footprints=unary_union([Polygon(b['footprint3006']) for b in survey['buildings']]+[Polygon(s['roofEdge3006']) for s in survey['interpretedRoofSections']])
    courtyard=Polygon(config['pavedCourtyard3006'])
    tree_clearance=unary_union([footprints,courtyard])
    clearance=unary_union([footprints.buffer(config['roofMarginM']),courtyard])
    stamp=datetime.now().strftime('%Y%m%d-%H%M%S-%f')
    backups=args.export/'clubhouse-backups'/stamp
    saved=[]
    def backup(path):
        if not path.exists(): return
        backups.mkdir(parents=True,exist_ok=True)
        shutil.copy2(path,backups/path.name)
        saved.append(path.name)
    report=dict(apply=args.apply,export=str(args.export),backupFolder=str(backups),trees={},zones={},caveat=config['reproducibility'])
    if args.trees:
        treepath=args.export/'ombergs-golfklubb-inner-trees.json'
        editpath=args.export/'ombergs-golfklubb-inner-tree-edits.json'
        trees={t['id']:t for t in json.loads(treepath.read_text(encoding='utf-8-sig'))['trees']}
        edits=json.loads(editpath.read_text(encoding='utf-8-sig')) if editpath.exists() else dict(format='golfmap-tree-edits-v1',trees=treepath.name,edits=[])
        if edits['format']!='golfmap-tree-edits-v1': raise ValueError('Unsupported tree edits format')
        existing={e['id']:e for e in edits['edits']}
        added=[]; kept=[]; conflicts=[]
        for ident in config['insideRoofOrPavingTreeIds']:
            if ident in existing:
                if existing[ident]['op']=='delete': kept.append(ident)
                else: conflicts.append(dict(id=ident,op=existing[ident]['op'],action='Preserved existing manual edit; no overwrite'))
                continue
            if ident not in trees: raise ValueError('Expected source tree missing: '+ident)
            t=trees[ident]
            if not tree_clearance.contains(Point(t['x']+477021,t['z']+6456736)):
                raise ValueError('Expected strictly inside source tree moved outside roof/paving: '+ident)
            edit=dict(id=ident,op='delete',ox=t['x'],oz=t['z'])
            edits['edits'].append(edit); added.append(edit)
        report['trees']=dict(editsFile=str(editpath),added=added,alreadyDeleted=kept,preservedConflicts=conflicts,totalEdits=len(edits['edits']))
        if args.apply and added:
            backup(editpath)
            editpath.write_text(json.dumps(edits,indent=2)+'\n',encoding='utf-8')
    if args.zones:
        zonepath=args.export/'ombergs-golfklubb-inner-zones.json'
        zones=json.loads(zonepath.read_text(encoding='utf-8-sig'))
        if zones['format']!='unity-zones-v2': raise ValueError('Unsupported zones format')
        plot=zones['plot']; side=plot['sizeM']; w=plot['originX']; s=plot['originY']
        changed=[]; pixels=0; resolutions=[]; cuts={}
        for mask in zones['masks']:
            path=args.export/mask['file']; rgba=np.array(Image.open(path).convert('RGBA'))
            res=mask['resolution']
            if rgba.shape[:2]!=(res,res): raise ValueError('Mask dimensions differ: '+str(path))
            if res not in cuts:
                transform=from_bounds(w,s,w+side,s+side,res,res)
                cuts[res]=rasterize([(mapping(clearance),1)],out_shape=(res,res),transform=transform,fill=0,dtype='uint8').astype(bool)
            cut=cuts[res]
            touched=cut & np.any(rgba!=0,axis=2)
            if not touched.any(): continue
            pixels+=int(touched.sum()); rgba[cut]=0; changed.append(path.name); resolutions.append(res)
            if args.apply:
                backup(path); Image.fromarray(rgba).save(path)
        # Height mask is deliberately kept: zero density already prevents all
        # its twins from spawning, and changing it cannot affect this clearance.
        bw,bs,be,bn=clearance.bounds
        res=max(resolutions or [m['resolution'] for m in zones['masks']]); px=side/res
        x0=max(0,int(np.floor((bw-w)/px))); x1=min(res,int(np.ceil((be-w)/px)))
        y0=max(0,int(np.floor((s+side-bn)/px))); y1=min(res,int(np.ceil((s+side-bs)/px)))
        patchpath=OUT/'clubhouse-vegetation-patch.json'
        current_names={m['file'] for m in zones['masks']}
        imports=set(changed)
        retained=[]
        previous_region=None
        # A failed Unity import must remain retryable. Source PNGs already
        # cleared on a previous apply are not proof that Unity imported them.
        # Re-importing a matching existing patch is harmless and preserves the
        # copy/cache-clear request until the caller actually imports it.
        if patchpath.exists():
            previous=json.loads(patchpath.read_text(encoding='utf-8-sig'))
            if previous.get('format')=='unity-zones-patch-v1' and previous.get('zonesFile')==zonepath.name and previous.get('terrain')=='inner':
                retained=sorted(set(previous.get('textures',[])) & current_names)
                imports.update(retained)
                if retained: previous_region=previous.get('region')
        if args.force_import: imports.update(current_names)
        if previous_region:
            # Include the earlier cache-clear window if the local outline was
            # edited between retries, so an earlier pending patch is not lost.
            x0=min(x0,max(0,int(np.floor(previous_region['x0']/px))))
            x1=max(x1,min(res,int(np.ceil(previous_region['x1']/px))))
            y0=min(y0,max(0,int(np.floor((side-previous_region['z1'])/px))))
            y1=max(y1,min(res,int(np.ceil((side-previous_region['z0'])/px))))
        patch=dict(format='unity-zones-patch-v1',zonesFile=zonepath.name,terrain='inner',changed=bool(imports),textures=sorted(imports),window=dict(x0=x0,y0=y0,x1=x1,y1=y1,resolution=res),region=dict(x0=x0*px,z0=side-y1*px,x1=x1*px,z1=side-y0*px),zones=[],removed=[])
        report['zones']=dict(patchFile=str(patchpath),changedMasks=changed,importMasks=patch['textures'],retainedImportMasks=retained,forceImport=args.force_import,changedPixelsAcrossMasks=pixels,clearanceAreaM2=round(clearance.area,1),region=patch['region'])
        if args.apply:
            OUT.mkdir(parents=True,exist_ok=True); patchpath.write_text(json.dumps(patch,indent=2)+'\n')
        # Review overlay is local output, made in both modes; external masks
        # are untouched in dry run. Green outlines are the intended clearance.
        ortho=OUT/'ortho-2025.png'
        if ortho.exists():
            im=Image.open(ortho); draw=ImageDraw.Draw(im)
            for poly in clearance.geoms if clearance.geom_type=='MultiPolygon' else [clearance]:
                pts=[((e-477750)/.16,(6457790.13-n)/.16) for e,n in poly.exterior.coords]
                draw.line(pts,fill='#55ff75',width=3)
            im.save(OUT/'vegetation-clearance-review.png')
    report['backedUpFiles']=saved
    OUT.mkdir(parents=True,exist_ok=True)
    (OUT/('vegetation-exclusions-applied.json' if args.apply else 'vegetation-exclusions-dry-run.json')).write_text(json.dumps(report,indent=2)+'\n')
    print(json.dumps(report,indent=2))

if __name__=='__main__': main()
