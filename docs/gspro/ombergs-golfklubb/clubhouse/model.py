"""Rebuild Omberg's measured clubhouse architecture as standalone Blender assets.

Run with Blender 4.5, --factory-startup --python <this file> -- --out <folder>.
Survey and photographic interpretation are kept beside the generator. The OPCD
course .blend is never opened or changed. Output is a golfmap-props-v1 folder.
"""
import argparse
import json
import math
import sys
from pathlib import Path

import bpy
from mathutils import Matrix, Vector

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[3]
sys.path.insert(0, str(ROOT / "blender/tools"))
sys.path.insert(0, str(HERE))
import props_kit as kit
import build_props as exporter
import main_building

import outbuildings
from common import opening, roof_building, solar, ccw



def local(e, n, origin, yaw):
    a = math.radians(yaw)
    de, dn = e - origin[0], n - origin[1]
    return de * math.sin(a) + dn * math.cos(a), -de * math.cos(a) + dn * math.sin(a)


def solid(name, rgb, smooth=0.2, metal=0):
    kit.MATERIALS[name] = (None, (1, 1), rgb, smooth, metal)


def materials():
    # Photograph-led colours; texture relief is reused from the shared prop kit.
    kit.MATERIALS["omberg_cream"] = ("boards:222,214,187:v:0.145:2:2", (2, 2), None, .16, 0)
    kit.MATERIALS["omberg_cream_lap"] = ("boards:220,211,181:h:0.145:2:0", (2, 2), None, .16, 0)
    kit.MATERIALS["omberg_pale_grey"] = ("boards:207,201,189:v:0.145:2:2", (2, 2), None, .15, 0)
    kit.MATERIALS["omberg_main_grey"] = ("plaster:190,193,187", (2, 2), None, .12, 0)
    kit.MATERIALS["omberg_basement_stone"] = ("stone:119,124,119", (2, 2), None, .10, 0)
    kit.MATERIALS["omberg_terracotta"] = ("pantile:159,75,48", (2, 2), None, .22, 0)
    # Roof relief is carried by the texture/normal map, not centimetre-scale
    # repeated mesh lips: the latter produced lighting bands in Unity 2018.
    kit.MATERIALS["omberg_silver_roof"] = ("seam:166,170,169:0.45:1.8:0", (1.8, 1.8), None, .3, .25)
    kit.MATERIALS["omberg_entry_stone"] = ("entrystone", (3, 3), None, .09, 0)
    kit.TextureBank.tex_entrystone=entry_stone_texture
    kit.MATERIALS["omberg_red"] = ("boards:138,53,43:v:0.16:2:2", (2, 2), None, .14, 0)
    kit.MATERIALS["omberg_deck"] = ("boards:131,116,91:h:0.14:2:0", (2, 2), None, .13, 0)
    solid("omberg_ivory_trim", (233,229,211))
    solid("omberg_dark_brown", (65,58,46))
    solid("omberg_glazing", (69,90,99), .88, .22)
    solid("omberg_rose_wall", (160,103,81))
    solid("omberg_sage", (129,143,124))
    solid("omberg_sign", (40,54,47))
    solid("omberg_lettering", (226,216,189))
    solid("omberg_logo_yellow", (244,196,54))
    solid("omberg_logo_blue", (48,103,176))
    solid("omberg_logo_green", (77,176,105))
    solid("omberg_logo_edge", (34,46,39))
    solid("omberg_sign_white", (234,235,231))
    solid("omberg_entry_green", (59,81,58), .2)
    solid("omberg_courtyard_asphalt", (101,99,96), .08)
    # Shared opening geometry uses these two names.
    kit.MATERIALS["window_dark"] = kit.MATERIALS["omberg_glazing"]
    kit.MATERIALS["glass"] = kit.MATERIALS["omberg_glazing"]



def framed_face(g, a, b, z0, z1, bays, frame="omberg_ivory_trim", bars=1):
    """Continuous glazed wall with actual mullions and recessed dark glass."""
    a,b = Vector(a),Vector(b)
    u=(b-a).normalized()
    length=(b-a).length
    outward=Vector((u.y,-u.x,0))
    for i in range(bays):
        p=a+(b-a)*(i/bays)
        q=a+(b-a)*((i+1)/bays)
        g.poly([tuple(p+Vector((0,0,z0))),tuple(q+Vector((0,0,z0))),
                tuple(q+Vector((0,0,z1))),tuple(p+Vector((0,0,z1)))],"omberg_glazing")
    for i in range(bays+1):
        p=a+(b-a)*(i/bays)+outward*.035
        g.beam(tuple(p+Vector((0,0,z0))),tuple(p+Vector((0,0,z1))),.075,.075,frame)
    for z in [z0,z1]+[z0+(z1-z0)*i/(bars+1) for i in range(1,bars+1)]:
        g.beam(tuple(a+Vector((0,0,z))),tuple(b+Vector((0,0,z))),.075,.075,frame)


def sign(g, text, pos, width, height, rot=0, size=.32):
    """Baked sign lettering, with no dependency on fonts in the Unity project."""
    g.push(Matrix.Translation(pos) @ Matrix.Rotation(math.radians(rot),4,"Z"))
    curve=bpy.data.curves.new("sign-lettering","FONT")
    curve.body=text
    curve.align_x="CENTER"
    curve.align_y="CENTER"
    curve.size=size
    curve.extrude=.002
    ob=bpy.data.objects.new("sign-lettering",curve)
    bpy.context.scene.collection.objects.link(ob)
    ob.rotation_euler=(math.pi/2,0,0)
    bpy.context.view_layer.objects.active=ob
    ob.select_set(True)
    bpy.ops.object.convert(target="MESH")
    ob=bpy.context.object
    xs=[v.co.x for v in ob.data.vertices]
    scale=width/(max(xs)-min(xs)) if xs else 1
    for p in ob.data.polygons:
        pts=[]
        for i in p.vertices:
            v=ob.matrix_world@ob.data.vertices[i].co
            pts.append((v.x*scale,v.y-.022,v.z*scale))
        g.poly(pts,"omberg_sign_white")
    bpy.data.objects.remove(ob,do_unlink=True)
    g.pop()


def entrance_logo(g, front, scale=1, height=0, along=0):
    """Native mesh emblem traced from the supplied frontal entrance photograph.
    Local 2D coordinates are horizontal across the gable and height above it.
    """
    g.push(Matrix(((0,0,1,front),(1,0,0,along),(0,1,0,height),(0,0,0,1))))
    sun=[(-.43,4.23),(.43,4.23)]+[(.43*math.cos(t),4.23+.43*math.sin(t))
        for t in [math.pi*i/20 for i in range(1,21)]]
    wave=[(-1.0,4.12),(-.70,4.16),(-.32,4.29),(.07,4.33),(.42,4.29),(.78,4.15),(1.01,4.00),
          (.65,4.14),(.28,4.19),(-.07,4.18),(-.42,4.09),(-.82,3.96)]
    hill=[(-1.0,3.92),(-.64,4.02),(-.26,4.11),(.13,4.14),(.48,4.09),(.84,3.97),(1.12,3.79),
          (.74,3.73),(.37,3.60),(.02,3.51),(-.33,3.52),(-.61,3.61),(-.85,3.76)]
    for layer,(polygon,mat) in enumerate([(sun,"omberg_logo_yellow"),(wave,"omberg_logo_blue"),(hill,"omberg_logo_green")]):
        polygon=[(u*scale,v*scale) for u,v in polygon]
        centre=(sum(p[0] for p in polygon)/len(polygon),sum(p[1] for p in polygon)/len(polygon))
        border=[(centre[0]+(u-centre[0])*1.035,centre[1]+(v-centre[1])*1.035) for u,v in polygon]
        depth=layer*.025
        g.extrude(ccw(border),.012+depth,.035+depth,"omberg_logo_edge")
        g.extrude(ccw(polygon),.036+depth,.072+depth,mat)
    g.pop()


def entry_stone_texture(bank):
    """Irregular charcoal stone and pale thin joints, matching the user photo.
    Tileable jittered Voronoi cells avoid the shared kit's rectangular courses.
    """
    import numpy as np
    S=bank.size
    yy,xx=np.mgrid[0:S,0:S]/S
    rng=np.random.default_rng(433)
    centres=np.array([(x/5+rng.uniform(-.075,.075),y/5+rng.uniform(-.075,.075))
                      for y in range(5) for x in range(5)])
    best=np.full((S,S),100.)
    second=np.full((S,S),100.)
    ids=np.zeros((S,S),dtype=int)
    for i,(x,y) in enumerate(centres):
        dx=(xx-x+.5)%1-.5
        dy=(yy-y+.5)%1-.5
        d=dx*dx+dy*dy
        change=d<best
        second=np.where(change,best,np.minimum(second,d))
        ids=np.where(change,i,ids)
        best=np.minimum(best,d)
    # The boundary is where nearest and second-nearest squared distances meet.
    joint=(second-best)<.00065
    grain=kit._fbm((S,S),434,scales=(128,32,8,2))
    tones=rng.uniform(.83,1.16,len(centres))[ids]*(.87+.22*grain)
    col=np.array([63,67,65])/255.
    rgb=col[None,None,:]*tones[:,:,None]
    rgb=np.where(joint[:,:,None],np.array([123,129,124])/255.,rgb)
    h=np.where(joint,.1,.75+.15*grain)
    return rgb,h,1.8


def entry_details(g, length, width):
    front=length/2+.015
    # Four bays: narrower fixed sidelights and the two central sliding leaves.
    edges=[-1.95,-1.10,0,1.10,1.95]
    z0,z1=.15,2.82
    for j,(a,b) in enumerate(zip(edges[:-1],edges[1:])):
        x=front+(.035 if j in [1,2] else .012)
        g.poly([(x,a,z0),(x,b,z0),(x,b,z1),(x,a,z1)],"omberg_glazing")
    for y in edges:
        g.box((front+.065,y,(z0+z1)/2),(.115,.095,z1-z0+.1),"omberg_entry_green")
    for z in [z0,z1]:
        g.box((front+.065,0,z),(.13,4.02,.13),"omberg_entry_green")
    g.box((front+.14,0,z1+.12),(.10,.40,.055),"black_steel")
    for y in [-.11,.11]:
        g.box((front+.16,y,1.22),(.06,.035,.26),"black_steel")
    sign(g,"Ombergs Golf Resort",(front+.10,0,3.20),3.24,.42,rot=90,size=.35)
    entrance_logo(g,front+.11)
    # Paired wall lanterns, with glazed bodies and pyramidal caps.
    for y in [-2.38,2.38]:
        g.beam((front,y,2.25),(front+.36,y,2.25),.08,.08,"black_steel")
        g.box((front+.39,y,2.48),(.26,.26,.38),"black_steel",
              mats={"+x":"omberg_glazing","+y":"omberg_glazing","-y":"omberg_glazing"})
        for yy in [y-.14,y+.14]:
            g.box((front+.53,yy,2.48),(.035,.035,.42),"black_steel")
        corners=[(front+.20,y-.20,2.69),(front+.59,y-.20,2.69),
                 (front+.59,y+.20,2.69),(front+.20,y+.20,2.69)]
        for a,b in zip(corners,corners[1:]+corners[:1]):
            g.poly([a,b,(front+.395,y,2.85)],"black_steel")
        g.sphere((front+.395,y,2.89),.05,"black_steel",seg=8,rings=4)
    g.box((front+1.55,0,.02),(3.1,7.0,.13),"brick_paving")



def render(sc, path, loc, target, ortho):
    co=exporter.camera(sc,loc,target,ortho=ortho)
    sc.render.filepath=str(path)
    bpy.ops.render.render(write_still=True)
    bpy.data.objects.remove(co,do_unlink=True)




def clip(poly, axis, value, keep_low):
    out=[]
    for a,b in zip(poly,poly[1:]+poly[:1]):
        ia=(a[axis]<=value) if keep_low else (a[axis]>=value)
        ib=(b[axis]<=value) if keep_low else (b[axis]>=value)
        if ia:
            out.append(a)
        if ia!=ib:
            t=(value-a[axis])/(b[axis]-a[axis])
            out.append(tuple(a[k]+t*(b[k]-a[k]) for k in range(2)))
    return out


def shell(g, poly, zfunc, wall="omberg_red", floor=0):
    """Wall polygon whose top follows the actual roof height at each vertex."""
    poly=ccw(poly)
    for a,b in zip(poly,poly[1:]+poly[:1]):
        # Add enough wall-top vertices to follow a ridge between roof corners.
        n=max(1,int(math.dist(a,b)/.4))
        top=[(a[0]+(b[0]-a[0])*t/n,a[1]+(b[1]-a[1])*t/n) for t in range(n+1)]
        # Separate quads remain valid across a roof ownership/height change.
        # One long, concave wall ngon could triangulate across a courtyard void.
        for p,q in zip(top[:-1],top[1:]):
            zp,zq=max(floor+.23,zfunc(*p)-.1),max(floor+.23,zfunc(*q)-.1)
            g.poly([(p[0],p[1],floor+.22),(q[0],q[1],floor+.22),
                    (q[0],q[1],zq),(p[0],p[1],zp)],wall)
        g.poly([(a[0],a[1],-1),(b[0],b[1],-1),(b[0],b[1],floor+.23),(a[0],a[1],floor+.23)],"concrete")


def fitted_roof(g, poly, zfunc, ridge_e, mat="omberg_terracotta"):
    """Two fitted gable planes clipped against the surveyed concave roof outline."""
    poly=ccw(poly)
    for low in [True,False]:
        q=clip(poly,0,ridge_e,low)
        if len(q)<3:
            continue
        # Explicit identical triangulation keeps the underside below the top
        # even where the measured ridge drifts slightly along a long roof.
        # Blender may choose different diagonals for two reversed warped ngons.
        from mathutils.geometry import tessellate_polygon
        top=[Vector((x,y,zfunc(x,y))) for x,y in q]
        for tri in tessellate_polygon([top]):
            pts=[top[v] if isinstance(v,int) else v for v in tri]
            g.poly([tuple(v) for v in pts],mat)
            g.poly([(v.x,v.y,v.z-.14) for v in reversed(pts)],"omberg_ivory_trim")
    for a,b in zip(poly,poly[1:]+poly[:1]):
        # Roof boundary pieces need an explicit ridge split on cross-gables.
        pts=[a]
        if (a[0]-ridge_e)*(b[0]-ridge_e)<0:
            t=(ridge_e-a[0])/(b[0]-a[0])
            pts.append((ridge_e,a[1]+(b[1]-a[1])*t))
        pts.append(b)
        for p,q in zip(pts[:-1],pts[1:]):
            g.poly([(p[0],p[1],zfunc(*p)-.14),(q[0],q[1],zfunc(*q)-.14),
                    (q[0],q[1],zfunc(*q)),(p[0],p[1],zfunc(*p))],"omberg_ivory_trim")
    # Raised metal or tile ridge cap follows the long axis; keep inside outline.
    ys=[p[1] for p in poly]
    g.beam((ridge_e,min(ys)+.18,zfunc(ridge_e,min(ys)+.18)+.04),
           (ridge_e,max(ys)-.18,zfunc(ridge_e,max(ys)-.18)+.04),.18,.10,mat)


def main():
    p=argparse.ArgumentParser()
    p.add_argument("--out",default=str(ROOT/"data/omberg-clubhouse/build"))
    p.add_argument("--no-render",action="store_true")
    a=p.parse_args(sys.argv[sys.argv.index("--")+1:] if "--" in sys.argv else [])
    out=Path(a.out).resolve()
    for d in ["Models","Textures","Previews"]:
        (out/d).mkdir(parents=True,exist_ok=True)
    sc=exporter.reset_scene()
    materials()
    main_building.register_materials()
    outbuildings.register_materials()
    assets,instances=build_architecture()
    for g in assets.values():
        renamed=[]
        for face,mat,uv in g.faces:
            name=mat if mat.startswith("omberg_") else "omberg_"+mat
            if name not in kit.MATERIALS:
                kit.MATERIALS[name]=kit.MATERIALS[mat]
            renamed.append((face,name,uv))
        g.faces=renamed
    used={mat for g in assets.values() for _,mat,_ in g.faces}
    table=kit.material_table(kit.TextureBank(str(out/"Textures"),1024),used)
    matte={"omberg_terracotta","omberg_red","omberg_main_grey","omberg_entry_stone","omberg_basement_stone",
           "omberg_main_frame","omberg_main_reveal","omberg_main_sill","omberg_main_void","omberg_main_panel_joint",
           "omberg_courtyard_asphalt","omberg_main_roof"}
    for name in matte:
        if name in table:
            table[name]["specular"]=[0,0,0]
            table[name]["smoothness"]=0
    for name,level in {"omberg_main_glass":.04,"omberg_main_gutter":.02}.items():
        if name in table:
            table[name]["specular"]=[level,level,level]
    lib=bpy.data.collections.new("Authored architecture")
    sc.collection.children.link(lib)
    objects={}
    # The kit's flat palette is sRGB for Blender, which linearizes it itself.
    # Unity SetColor consumes linear values. Convert only this course's new
    # solid materials on an exported copy; retain existing kit compatibility.
    export_table={name:dict(d) for name,d in table.items()}
    linear_solids=[]
    for name,d in export_table.items():
        if (name.startswith("omberg_main_") or name=="omberg_courtyard_asphalt") and not d.get("albedo"):
            d["color"]=[round(((v+.055)/1.055)**2.4 if v>.04045 else v/12.92,7) for v in d["color"]]
            linear_solids.append(name)
    # Course-lighting calibration verified in the actual Unity scene. These
    # linear tint multipliers affect only export; texture files remain sRGB.
    texture_tints={"omberg_main_roof":[.65,.69,.69],"omberg_basement_stone":[.65,.69,.67]}
    for name,color in texture_tints.items():
        export_table[name]["color"]=color
    manifest={"format":"golfmap-props-v1","source":"clubhouse/model.py",
              "materials":export_table,"assets":{},"instances":instances}
    for name,g in assets.items():
        ob=kit.to_object(g,name,table,str(out/"Textures"),lib)
        # Architectural planes and tile lips use independent face normals.
        # This makes the intended hard edges explicit in the Unity 2018 FBX
        # rather than depending on Blender's sharp-edge smoothing convention.
        for face in ob.data.polygons:
            face.use_smooth=name=="omberg_courtyard_paving"
        if name=="omberg_courtyard_paving":
            # The kit's angle-based sharp edges survive smooth-face flags.
            # Paving is one continuous terrain surface, with shared normals
            # across every triangle and no architectural hard-edge splits.
            for edge in ob.data.edges:
                edge.use_edge_sharp=False
        for material in ob.data.materials:
            if material.name in matte:
                bsdf=material.node_tree.nodes.get("Principled BSDF")
                if bsdf and "Specular IOR Level" in bsdf.inputs:
                    bsdf.inputs["Specular IOR Level"].default_value=0
        ob.data.update()
        objects[name]=ob
        exporter.export_fbx(ob,str(out/"Models"/(name+".fbx")))
        manifest["assets"][name]=dict(fbx="Models/"+name+".fbx",category="structure" if name=="omberg_courtyard_paving" else "building",collider="mesh",
             bounds=exporter.bounds(ob),tris=sum(len(p.vertices)-2 for p in ob.data.polygons),
             materials=[m.name for m in ob.data.materials])
        print(name,manifest["assets"][name]["tris"],"triangles",flush=True)
    (out/"props.json").write_text(json.dumps(manifest,indent=2),encoding="utf-8")
    report=dict(format="omberg-architecture-build-v1",source="clubhouse/model.py",
        survey="clubhouse/survey.json",references="clubhouse/references.md",
        authoredBlend="omberg-clubhouse-authored.blend",texturesPacked=True,flatArchitecturalNormals=True,
        courtyardNormals="Smooth faces and shared vertex normals; all inherited sharp-edge flags cleared.",
        assets=len(manifest["assets"]),instances=len(instances),materials=len(table),
        triangles=sum(v["tris"] for v in manifest["assets"].values()),
        perAsset=manifest["assets"],
        facadeEvidence="User-supplied course-side and entrance photographs, 2026-10-16; main grey building has three storeys plus exposed basement.",
        roofDetail="Planar tile roofs; main building has textured/normal standing seams at 0.45 m spacing, a clipped continuous roof junction, fascia, gutters and downpipes. Fine physical seam strips omitted to prevent Unity aliasing.",
        mainBuildingDetail="Union shell with actual window openings, 0.22 m reveals, inset green frames, mullions, dark glazing/interior backs. Course top bays S,S,W,W | S,W,S; unseen elevations inferred.",
        matteMaterials=sorted(matte),
        linearColorMaterials=sorted(linear_solids),
        unityTextureTints=texture_tints,
        limitations=["Roofs use sparse lidar plane fits and ortho traces, about 0.5–1.5 m plan uncertainty.",
            "Individual facade openings are interpreted from photographs rather than surveyed architectural drawings.",
            "Exterior reconstruction only; opaque reflected glazing, no interiors.",
            "Southeast hall transverse stair gable and window counts are photo interpretations.",
            "No car park surfaces, vehicles, trees, practice green or padel court reconstructed."])
    (out/"build-report.json").write_text(json.dumps(report,indent=2),encoding="utf-8")
    # Save the full, georeferenced arrangement in a local EN frame for review.
    origin=(477825,6457700)
    for i in instances:
        ob=objects[i["asset"]]
        ob.location=(i["e"]-origin[0],i["n"]-origin[1],i.get("layoutZ",0))
        ob.rotation_euler.z=math.radians(90-i["yawDeg"])
    exporter.setup_render(sc,1600,1200)
    sc.render.image_settings.file_format="PNG"
    sc["golfmap_origin_epsg3006"]=[origin[0],origin[1],109.09]
    sc["golfmap_sources"]="clubhouse/survey.json; clubhouse/references.md"
    view_rotation=(Vector((15,-5,1))-Vector((-95,-108,70))).to_track_quat("-Z","Y")
    for screen in bpy.data.screens:
        for area in screen.areas:
            if area.type=="VIEW_3D":
                space=area.spaces.active
                space.region_3d.view_location=(15,-5,3)
                space.region_3d.view_distance=180
                space.region_3d.view_rotation=view_rotation
                space.clip_end=2000
    bpy.ops.file.pack_all()
    bpy.ops.wm.save_as_mainfile(filepath=str(out/"omberg-clubhouse-authored.blend"))
    if not a.no_render:
        ground=review_ground(origin)
        gt=kit.material_table(kit.TextureBank(str(out/"Textures"),512),{"turf_mat"})
        kit.to_object(ground,"Review ground (excluded from FBX)",gt,str(out/"Textures"),sc.collection)
        for view,loc,target,scale in [
                ("southwest",(-95,-108,70),(15,-5,1),260),
                ("northeast",(105,100,80),(15,-5,1),260),
                ("top",(15,-5,200),(15,-5,0),270),
                ("courtyard",(20,-15,35),(-20,-40,4),100),
                ("southeast-detail",(135,-65,25),(96,-18,7),80),
                ("main-building-course-side",(-88,-62,10),(-34,-3,4),82),
                ("main-facade-detail",(-58,-36,3),(-34,-3,5),None),
                ("entrance-detail",(-7,-17,3.3),(-18.35,-25.335,2.3),12)]:
            render(sc,out/"Previews"/(view+".png"),loc,target,scale)
    print("OUTPUT",out,flush=True)


def build_architecture():
    survey=json.loads((HERE/"survey.json").read_text(encoding="utf-8"))
    byid={r["id"].split("/")[-1]:r for r in survey["buildings"]}
    sections={r["id"]:r for r in survey["interpretedRoofSections"]}
    assets={}
    instances=[]
    def add(aid,g,e,n,yaw,ground_abs):
        assets[aid]=g
        instances.append(dict(asset=aid,e=e,n=n,yawDeg=yaw,ground="centre",dz=0,
                              layoutZ=round(ground_abs-109.09,3)))
    def new():
        return kit.Geo()

    # Main clubhouse: the two unequal red roofs are from four independently
    # fitted laser planes. A generic symmetric gable loses its recognisable shape.
    origin=(477808.07,6457659.24)
    ground=109.09
    g=new()
    planes=survey["roofPlanes"]
    def pz(key,x,y):
        p=planes[key]
        return p["zAtOrigin"]+p["slopeE"]*(x+origin[0]-p["originEN"][0])+p["slopeN"]*(y+origin[1]-p["originEN"][1])-ground
    def lowz(x,y):
        return min(pz("west-wing-west-slope",x,y),pz("west-wing-east-slope",x,y))
    def highz(x,y):
        return min(pz("tall-roof-west-slope",x,y),pz("tall-roof-east-slope",x,y))
    def poly(section):
        return [(e-origin[0],n-origin[1]) for e,n in sections[section]["roofEdge3006"]]
    wallpoints=byid["687779192"]["footprint3006"][:-1]
    # The foyer projection is authored below with its own stone shell. Leaving
    # its original OSM front edge here creates an overlapping red facade.
    wallpoints=[p for i,p in enumerate(wallpoints) if i not in [1,2]]
    wallpoly=[(e-origin[0],n-origin[1]) for e,n in wallpoints]
    def wall_top(x,y):
        east=x+origin[0]
        north=y+origin[1]
        tall=(north<=6457664.1 and east>=477801.2) or (north<=6457670.2 and east>=477817.1)
        return max(lowz(x,y),highz(x,y)) if tall else lowz(x,y)
    shell(g,wallpoly,wall_top)
    lowpoly=poly("clubhouse-west-low")
    # The two fitted roofs meet at E477801.3 along the southern body.
    # Keep the low eastern eave north of the high roof's courtyard wall only.
    lowpoly=ccw([(477789.04-origin[0],6457681.65-origin[1]),
                 (477803.28-origin[0],6457681.33-origin[1]),
                 (477803.28-origin[0],6457663.0-origin[1]),
                 (477801.3-origin[0],6457663.0-origin[1]),
                 (477801.3-origin[0],6457633.49-origin[1]),
                 (477789.04-origin[0],6457634.29-origin[1])])
    fitted_roof(g,lowpoly,lowz,477796.3-origin[0])
    highpoly=poly("clubhouse-east-tall")
    # Ortho roof lean had placed the northern edge south of its ground wall.
    # Cover the surveyed courtyard wall plus a modest eave overhang.
    highpoly=[(x,max(y,6457664.1-origin[1])) if i in [0,1] else (x,y) for i,(x,y) in enumerate(highpoly)]
    fitted_roof(g,highpoly,highz,477817.5-origin[0])
    # Sheltered western dining terrace, clearly visible in both ortho vintages.
    deckx=477785.5-origin[0]
    deckx1=477791.7-origin[0]
    y0,y1=6457633.4-origin[1],6457679-origin[1]
    g.box(((deckx+deckx1)/2,(y0+y1)/2,.08),(deckx1-deckx,y1-y0,.28),"omberg_deck")
    framed_face(g,(477787.9-origin[0],y1,0),(477787.9-origin[0],y0,0),.25,2.65,23,"omberg_dark_brown",bars=1)
    for y in [y0+i*(y1-y0)/12 for i in range(13)]:
        g.box((477787.9-origin[0],y,1.47),(.11,.11,2.5),"omberg_dark_brown")
    # Main east elevation, upper accommodation floor and lower restaurant bays.
    fp=[(-16,-24),(16,24)]
    for n in [6457640,6457644.5,6457649,6457653.5,6457658,6457663.5,6457667.5]:
        for sill in [.95,3.95]:
            facade_e=477823.68+(n-6457636.87)*(.88/32.84)+.045
            kit.opening(g,opening("+x",n-origin[1],w=1.5,h=1.5,sill=sill,plane=facade_e-origin[0]),fp,None,"omberg_ivory_trim")
    for e in [477805,477809,477813,477817,477821]:
        for sill in [.95,4.0]:
            facade_n=(6457635.86+(e-477802.08)*(-.38/14.36)) if e<477816.5 else (6457637.06+(e-477816.48)*(-.19/7.2))
            kit.opening(g,opening("-y",e-origin[0],w=1.45,h=1.45,sill=sill,plane=facade_n-origin[1]-.045),fp,None,"omberg_ivory_trim")
    # Surveyed NE courtyard-facing entry. Its 5.5 m front edge runs SE;
    # the outward-facing gable normal is bearing59deg, not the former mirror.
    g.push(Matrix.Translation((477805.0-origin[0],6457673.67-origin[1],0)) @ Matrix.Rotation(math.radians(31),4,"Z"))
    # Photo front: broad shallow gable and a clear stone shoulder above the
    # portal. Preserve ridge, lift the eave for a 26-degree roof pitch.
    roof_building(g,3.85,5.5,3.75,5.1,roof="omberg_silver_roof",wall="omberg_entry_stone",
                  openings=[],cladding={},cornerBoards=False)
    entry_details(g,3.85,5.5)
    g.pop()
    # West terrace tables and chairs, kept deliberately light in triangle count.
    for n in [6457638,6457643,6457648,6457653,6457658,6457673]:
        cx,cy=477786.1-origin[0],n-origin[1]
        g.box((cx,cy,.78),(1.15,1.15,.07),"omberg_ivory_trim")
        g.cylinder((cx,cy,.22),.055,.52,"black_steel",seg=6)
        for sy in [-.84,.84]:
            g.box((cx,cy+sy,.48),(.48,.45,.055),"omberg_dark_brown")
            g.box((cx,cy+sy+(.2 if sy>0 else -.2),.75),(.48,.05,.5),"omberg_dark_brown")
    add("omberg_clubhouse",g,*origin,90,ground)

    # The omitted kinked connector is tall, white sheet metal, present in 2023
    # and 2025. It is authored independently so its elevations can be adjusted.
    co=(477792.5,6457698.0)
    base=107.2
    g=main_building.build(sections,co,base)
    add("omberg_white_connector",g,*co,90,base)
    # Exact centre collider probe from the running Unity course, 2026-10-16.
    instances[-1]["dz"]=round(base-106.6887493,6)

    outbuildings.build(byid,add,new)
    courtyard_path=HERE/"courtyard.json"
    if courtyard_path.exists():
        courtyard=json.loads(courtyard_path.read_text(encoding="utf-8"))
        org=courtyard["origin"]
        paving=new()
        vertices=[(e-org["e"],n-org["n"],z-org["groundAbsM"]) for e,n,z in courtyard["vertices3006"]]
        for tri in courtyard["triangles"]:
            paving.poly([vertices[i] for i in tri],"omberg_courtyard_asphalt")
        add("omberg_courtyard_paving",paving,org["e"],org["n"],90,org["groundAbsM"])
        instances[-1]["dz"]=courtyard["placement"]["suggestedDz"]
    return assets,instances


def review_ground(origin):
    """Review-only surface interpolated from the local classified ground laser
    returns, so different building elevations are visible without a flat plane
    cutting off lower-storey facades. This ground is never exported to FBX."""
    import numpy as np
    pts=np.load(ROOT/"data/omberg-clubhouse/lidar-crop.npz")["points"]
    pts=pts[pts[:,3]==2,:3]
    g=kit.Geo()
    step=4
    xs=np.arange(-100,141,step)
    ys=np.arange(-108,109,step)
    verts=[]
    for y in ys:
        xx=np.array(xs)+origin[0]
        nn=y+origin[1]
        d=(pts[:,0,None]-xx[None,:])**2+(pts[:,1,None]-nn)**2
        idx=np.argpartition(d,4,axis=0)[:4]
        dist=np.take_along_axis(d,idx,axis=0)
        w=1/np.maximum(dist,.05)
        z=(pts[idx,2]*w).sum(0)/w.sum(0)-109.09-.10
        verts.extend([(float(x),float(y),float(zz)) for x,zz in zip(xs,z)])
    g.verts=[Vector(v) for v in verts]
    nx=len(xs)
    for j in range(len(ys)-1):
        for i in range(nx-1):
            k=j*nx+i
            g.faces.append(([k,k+1,k+nx+1,k+nx],"turf_mat",None))
    return g


if __name__=="__main__":
    main()
