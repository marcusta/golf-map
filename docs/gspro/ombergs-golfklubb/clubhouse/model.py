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
    # Clay tile matched to the ortho as RENDERED in Unity: a top-down Unity capture
    # of the clubhouse roof should read like the raw 2025 ortho (about 212,149,135).
    # Unity's sky light lifts the dark channels, so the albedo is redder than that.
    kit.MATERIALS["omberg_terracotta"] = ("pantile:161,93,80", (2, 2), None, .22, 0)
    # Roof relief is carried by the texture/normal map, not centimetre-scale
    # repeated mesh lips: the latter produced lighting bands in Unity 2018.
    kit.MATERIALS["omberg_silver_roof"] = ("seam:142,146,147:0.45:1.8:0", (1.8, 1.8), None, .3, .25)  # foyer; ortho ~130,133,134
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


def entry_details(g, length, width, apron):
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
    # Lidar puts the entry ridge at 4.68 m, so the emblem is scaled to sit under its fascia.
    entrance_logo(g,front+.11,scale=.85,height=.5)
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
    ax,ay,sx,sy,zt=apron
    g.box((ax,ay,zt-.065),(sx,sy,.13),"brick_paving")



def render(sc, path, loc, target, ortho):
    co=exporter.camera(sc,loc,target,ortho=ortho)
    sc.render.filepath=str(path)
    bpy.ops.render.render(write_still=True)
    bpy.data.objects.remove(co,do_unlink=True)




AXIS=math.radians(1.5)  # bearing of the long OSM walls (survey buildings[].axisBearingFromNorthDeg)


def to_st(x, y):
    """Asset-local x,y to the building frame: s across the ridges, t along them."""
    return x*math.cos(AXIS)-y*math.sin(AXIS), x*math.sin(AXIS)+y*math.cos(AXIS)


def from_st(s, t):
    return s*math.cos(AXIS)+t*math.sin(AXIS), -s*math.sin(AXIS)+t*math.cos(AXIS)


def at(s, t, z):
    x,y=from_st(s,t)
    return (x,y,z)


class Gable:
    """One true symmetric gable from two lidar planes, in the building frame.

    The fitted planes' slopeN terms are only the 1.5 degree axis skew: along the
    axis their ridges are level to a few cm, so the ridge is a straight line along
    t at s=sr, height zr, and both slopes share one pitch m (dz/ds)."""

    def __init__(self, pz, west, east, t0, t1):
        slope=lambda k: pz(k,*from_st(1,0))-pz(k,*from_st(0,0))
        sa,sb=slope(west),slope(east)
        self.m=(sa-sb)/2
        ridge=[]
        for i in range(9):
            t=t0+(t1-t0)*i/8
            za,zb=pz(west,*from_st(0,t)),pz(east,*from_st(0,t))
            s=(zb-za)/(sa-sb)
            ridge.append((s,za+sa*s))
        self.sr=sum(r[0] for r in ridge)/len(ridge)
        self.zr=sum(r[1] for r in ridge)/len(ridge)

    def z(self, s):
        return self.zr-self.m*abs(s-self.sr)


def tris(poly):
    """CCW triangles of a planar (s,t) polygon, concave ones included."""
    from mathutils.geometry import tessellate_polygon
    out=[]
    for tri in tessellate_polygon([[Vector((s,t,0)) for s,t in poly]]):
        a,b,c=[poly[i] for i in tri]
        if (b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0])<0:
            b,c=c,b
        out.append((a,b,c))
    return out


def roof_slab(g, poly, zf, fascia, thick=.16, mat="omberg_terracotta", xy=None, under="omberg_ivory_trim", edge="omberg_ivory_trim"):
    """One roof plane over a CCW plan polygon (default frame: building s,t): top,
    soffit `thick` below it, and a fascia/bargeboard on the edges listed in
    `fascia`. Ridge and valley edges get none: the two slabs share them, so the
    surface and the underside close without a gap. zf(point) is the plane."""
    xy=xy or (lambda p: from_st(*p))
    P=lambda p,dz=0: (*xy(p),zf(p)+dz)
    for a,b,c in tris(poly):
        g.poly([P(p) for p in (a,b,c)],mat)
        g.poly([P(p,-thick) for p in (a,c,b)],under)
    for i,(a,b) in enumerate(zip(poly,poly[1:]+poly[:1])):
        if i in fascia:
            g.poly([P(a,-thick),P(b,-thick),P(b),P(a)],edge)


def outward(g, pts, centre, mat):
    """Convex-solid face wound CCW seen from outside, whichever way it was listed."""
    pts=[Vector(p) for p in pts]
    n=sum(((pts[i]-pts[0]).cross(pts[i+1]-pts[0]) for i in range(1,len(pts)-1)),Vector())
    mid=sum(pts,Vector())/len(pts)
    g.poly([tuple(p) for p in (pts if n.dot(mid-centre)>=0 else pts[::-1])],mat)


def ridge_cap(g, gable, t0, t1, mat="omberg_terracotta"):
    """Trapezoid cap on the ridge, ending flush with the gable fascias."""
    sr,zr,m=gable.sr,gable.zr,gable.m
    prof=[(sr-.24,zr-m*.24-.02),(sr+.24,zr-m*.24-.02),(sr+.08,zr+.10),(sr-.08,zr+.10)]
    c=Vector(at(sr,(t0+t1)/2,zr-.05))
    for i in range(4):
        a,b=prof[i],prof[(i+1)%4]
        if i==0:
            continue  # sits on the roof
        outward(g,[at(a[0],t0,a[1]),at(a[0],t1,a[1]),at(b[0],t1,b[1]),at(b[0],t0,b[1])],c,mat)
    for t in (t0,t1):
        outward(g,[at(s,t,z) for s,z in prof],c,mat)


def gutter(g, a, b, out, mat="omberg_ivory_trim", r=.07):
    """Half-round gutter hung on the fascia of an eave from a=(x,y,z) to b=(x,y,z)
    (z of the roof's top edge); out is the horizontal unit vector away from the wall.
    Returns the (x,y,z) of the bottom of its start, for the downpipe."""
    n=6
    prof=[(.045+r*math.cos(math.pi+math.pi*k/n),-.10+r*math.sin(math.pi+math.pi*k/n)) for k in range(n+1)]
    pos=lambda p,o,dz: (p[0]+out[0]*o,p[1]+out[1]*o,p[2]+dz)
    for k in range(n):
        (oa,za),(ob,zb)=prof[k],prof[k+1]
        q=[pos(a,oa,za),pos(b,oa,za),pos(b,ob,zb),pos(a,ob,zb)]
        g.poly(q,mat)
        g.poly(q[::-1],mat)
    for p in (a,b):
        cap=[pos(p,o,z) for o,z in prof]
        g.poly(cap,mat)
        g.poly(cap[::-1],mat)
    return pos(a,.045,-.10-r)


def downpipe(g, top, wall, ground, mat="omberg_ivory_trim"):
    """Outlet below the gutter at `top`, a jog to the wall point `wall` (x,y), then
    straight down to the ground height."""
    jog=math.dist(top[:2],wall)
    a=top
    b=(top[0],top[1],top[2]-.3)
    c=(wall[0],wall[1],top[2]-.3-jog)
    d=(wall[0],wall[1],ground)
    for p,q in ((a,b),(b,c),(c,d)):
        g.pipe(p,q,.04,mat,seg=6)


def clip_plane(poly, f):
    """Part of a convex polygon where the linear function f(point) >= 0."""
    out=[]
    for a,b in zip(poly,poly[1:]+poly[:1]):
        fa,fb=f(a),f(b)
        if fa>=0:
            out.append(a)
        if (fa>=0)!=(fb>=0):
            t=fa/(fa-fb)
            out.append((a[0]+(b[0]-a[0])*t,a[1]+(b[1]-a[1])*t))
    return out


def foyer(g, low, s_wall, over):
    """The entrance foyer: a stone gable volume in front of the wing's east wall,
    its ridge running back over the wing's eave until the roof dies into the
    wing's slope (two valleys with step flashing).

    Placement is from the lidar and the 2025 ortho, in a frame at the OSM front-edge
    centre F0 (q out along bearing 59 deg, v across). Class-1 points fit a ridge at
    v 0.5, 4.68 m, pitch 20.8 deg (9 cm RMS), eaves at v -2.7 and 3.7, roof front
    edge q 1.15; the ortho shows the same white roof, 5.4 m wide and running 9 m
    back to the wing's slope. Walls are the roof less its 0.46 m eave and 0.32 m
    gable overhang, as on the survey photographs.
    Returns the t range the foyer covers along the wing's east eave line."""
    F0=(-1.42,15.43)
    a=math.radians(31)
    d,pv=(math.cos(a),math.sin(a)),(-math.sin(a),math.cos(a))
    fp=lambda q,v: (F0[0]+q*d[0]+v*pv[0],F0[1]+q*d[1]+v*pv[1])
    VC,HW,ZR,M=.5,2.75,4.68,.38
    OV,GOV=.46,.32
    QW=.83                    # stone front face
    QR=QW+GOV                 # roof front edge
    vo=HW+OV
    ze=lambda v: ZR-M*abs(v-VC)
    zw=lambda x,y: low.zr-low.m*(to_st(x,y)[0]-low.sr)       # the wing's east slope under the foyer
    zm=lambda q,v: zw(*fp(q,v))
    def q_where(v,fn):     # q where fn(q) == 0 along the line at v (fn is linear in q)
        f0,f1=fn(0),fn(1)
        return -f0/(f1-f0)
    zg=.05                    # the courtyard paving is 3 cm above the DEM here; the apron sits on it
    g.push(Matrix.Translation((*fp(QW-1.925,VC),0)) @ Matrix.Rotation(a,4,"Z"))
    # apron: q 0..3.1, v +-3.5 (the area courtyard.py leaves out of the paving)
    entry_details(g,3.85,5.5,(1.55-(QW-1.925),-VC,3.1,7.0,zg))
    g.pop()
    centre=Vector((*fp(QW-2,VC),2))
    z0=-.3
    for v in (VC+HW,VC-HW):
        qb=q_where(v,lambda q: to_st(*fp(q,v))[0]-s_wall)          # side line meets the wing wall
        ez=ze(v)
        outward(g,[(*fp(QW,v),z0),(*fp(qb,v),z0),(*fp(qb,v),ez),(*fp(QW,v),ez)],centre,"omberg_entry_stone")
        zb=zm(qb,v)
        if zb<ez:      # cheek of stone on the wing's slope, up to the soffit
            q1=q_where(v,lambda q: zm(qb-q,v)-ez)
            outward(g,[(*fp(qb,v),zb),(*fp(qb,v),ez),(*fp(qb-q1,v),ez)],centre,"omberg_entry_stone")
    outward(g,[(*fp(QW,VC-HW),z0),(*fp(QW,VC+HW),z0),(*fp(QW,VC+HW),ze(VC+HW)),(*fp(QW,VC),ZR),(*fp(QW,VC-HW),ze(VC-HW))],centre,"omberg_entry_stone")
    # Roof: each slope cut where it meets the wing's slope (a straight line in
    # plan, both being planes), fascia on the front rake and the eaves only.
    qa,qz=QR,-14
    up=(-math.cos(AXIS),math.sin(AXIS))          # toward the wing's ridge
    for v_out in (VC+vo,VC-vo):
        poly=[(qa,VC),(qa,v_out),(qz,v_out),(qz,VC)]
        if v_out<VC:
            poly=poly[::-1]
        poly=clip_plane(poly,lambda p: ze(p[1])-zm(*p))
        fascia={i for i,(p,r) in enumerate(zip(poly,poly[1:]+poly[:1]))
                if (abs(p[0]-qa)<1e-6 and abs(r[0]-qa)<1e-6) or (abs(p[1]-v_out)<1e-6 and abs(r[1]-v_out)<1e-6)}
        roof_slab(g,poly,lambda p: ze(p[1]),fascia,mat="omberg_silver_roof",xy=lambda p: fp(*p))
        for p,r in zip(poly,poly[1:]+poly[:1]):
            if abs(ze(p[1])-zm(*p))<1e-6 and abs(ze(r[1])-zm(*r))<1e-6:
                # zinc sheet on the wing's slope, laid over the valley line
                A,B=fp(*p),fp(*r)
                P=[(*A,zw(*A)+.035),(*B,zw(*B)+.035)]
                for X in (B,A):
                    X2=(X[0]+up[0]*.3,X[1]+up[1]*.3)
                    P.append((*X2,zw(*X2)+.035))
                outward(g,P,Vector((*A,zw(*A)-1)),"galvanised")
    # Gutters on the eaves, a downpipe on each front corner, ridge cap
    for sgn in (1,-1):
        v_e=VC+sgn*vo
        qc=-q_where(v_e,lambda q: ze(v_e)-zm(-q,v_e))
        top=gutter(g,(*fp(QR-.05,v_e),ze(v_e)),(*fp(qc+.05,v_e),ze(v_e)),(sgn*pv[0],sgn*pv[1]))
        downpipe(g,top,fp(QW+.12,VC+sgn*(HW+.07)),zg)
    qc=-q_where(VC,lambda q: ZR-zm(-q,VC))
    g.beam((*fp(QR,VC),ZR+.03),(*fp(qc,VC),ZR+.03),.2,.1,"omberg_silver_roof")
    # where the foyer's roof crosses the wing's east eave line
    ts=[]
    for v in (VC-vo,VC+vo):
        q=q_where(v,lambda q: to_st(*fp(q,v))[0]-(s_wall+over))
        ts.append(to_st(*fp(q,v))[1])
    return min(ts),max(ts)


def shell(g, poly, top, breaks=(), wall="omberg_red", floor=0):
    """Wall polygon whose top follows the roof surface. `top(p,q)` is the roof
    height at wall point p, picking the roof by probe point q (nudged inside the
    building and along the edge, so a corner takes the roof of its own wall).
    Breaks are the s of every ridge and valley: tops are exact at the creases,
    and a straight wall needs no other vertices."""
    poly=ccw(poly)
    for a,b in zip(poly,poly[1:]+poly[:1]):
        length=math.dist(a,b)
        ux,uy=(b[0]-a[0])/length,(b[1]-a[1])/length
        sa,sb=to_st(*a)[0],to_st(*b)[0]
        ts={0.0,1.0}
        for v in breaks:
            if abs(sb-sa)>1e-6 and 0<(v-sa)/(sb-sa)<1:
                ts.add((v-sa)/(sb-sa))
        ts=sorted(ts)
        for t0,t1 in zip(ts[:-1],ts[1:]):
            p=(a[0]+(b[0]-a[0])*t0,a[1]+(b[1]-a[1])*t0)
            q=(a[0]+(b[0]-a[0])*t1,a[1]+(b[1]-a[1])*t1)
            k=min(.2,(t1-t0)*length*.45)
            inx,iny=-uy*.2,ux*.2
            zp=max(floor+.23,top(p,(p[0]+inx+ux*k,p[1]+iny+uy*k))-.1)
            zq=max(floor+.23,top(q,(q[0]+inx-ux*k,q[1]+iny-uy*k))-.1)
            g.poly([(p[0],p[1],floor+.22),(q[0],q[1],floor+.22),(q[0],q[1],zq),(p[0],p[1],zp)],wall)
        g.poly([(a[0],a[1],-1),(b[0],b[1],-1),(b[0],b[1],floor+.23),(a[0],a[1],floor+.23)],"concrete")


ROOF_REPORT={}


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
    matte={"omberg_terracotta","omberg_terracotta_aged","omberg_tile_dark","omberg_red","omberg_main_grey","omberg_entry_stone","omberg_basement_stone",
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
    # Connector roof untinted: the ortho shows pale metal (about 141,147,148 sRGB).
    texture_tints={"omberg_main_roof":[1,1,1],"omberg_basement_stone":[.65,.69,.67]}
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
        roofModel=ROOF_REPORT,
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

    # Main clubhouse: two gable roofs side by side, regularised from the four
    # fitted laser planes. All roof geometry lives in the building frame (s across
    # the ridges, t along them, 1.5 degrees off north like the long OSM walls).
    origin=(477808.07,6457659.24)
    ground=109.09
    g=new()
    planes=survey["roofPlanes"]
    def pz(key,x,y):
        p=planes[key]
        return p["zAtOrigin"]+p["slopeE"]*(x+origin[0]-p["originEN"][0])+p["slopeN"]*(y+origin[1]-p["originEN"][1])-ground
    wallpoints=byid["687779192"]["footprint3006"][:-1]
    # OSM vertices 1 and 2 are the foyer's front corners; foyer() builds the foyer
    # with its own stone walls, and the wing's red east wall runs straight behind it.
    wallpoints=[p for i,p in enumerate(wallpoints) if i not in [1,2]]
    wallpoly=[(e-origin[0],n-origin[1]) for e,n in wallpoints]
    # Wall lines in the building frame (mean of each OSM edge's two ends).
    ws=[to_st(*p) for p in wallpoly]
    line=lambda i,j,k: (ws[i][k]+ws[j][k])/2
    T_COURT,S_NOTCH,T_NOTCH=line(2,3,1),line(3,4,0),line(4,5,1)   # courtyard wall, notch wall, notch end
    S_TALLW=line(9,10,0)                                           # tall west wall
    OVER=.5          # one overhang on every eave and gable of the tall block, and on the wing's courtyard eave
    # East wall and south wall of the tall block: the OSM lines (s 16.2, t -23.53) put
    # the roof 2.2 m / 1.9 m past the wall, but the lidar roof edge is at s 18.45 (outermost
    # returns, E 825.9-827.3) and t -24.7, while the courtyard-side edges agree with OSM to
    # 0.4 m. A 2 m cantilevered eave with no posts in the lidar is not credible, so the walls
    # are taken to be OVER inside the lidar roof edge. (The OSM outline was traced from a
    # leaning ortho.) Everything below follows from these two lines.
    S_EAST=18.45-OVER
    T_SOUTH=-24.7+OVER
    # The courtyard notch is smaller than the OSM trace says. Lidar roof (class 1, on the tall
    # planes) covers s 5.5..18.5 and runs north to t 12.0 (ground returns begin at s 5.35 and
    # t 12.1), against OSM walls at s 9.04 / t 10.9; the courtyard-side gable stays on OSM.
    S_NOTCH=5.5+OVER
    T_NOTCH=12.0-OVER
    S_WINGE=(ws[1][0]+ws[2][0])/2                                  # east wall of the low wing, north of the courtyard
    # The wing meets the white connector, whose south wall is the plane
    # main_building.SOUTH_WALL_N (N 6457679.16 before the connector moved). The lidar roof of the wing stops there too. The wing's walls
    # and roof end on that plane (1 cm inside it), so nothing shows between them
    # and nothing pokes through. The end edges follow N, not the roof axis.
    Y_END=getattr(main_building,"SOUTH_WALL_N",6457679.16)+.01-origin[1]
    t_end=lambda s: (Y_END+s*math.sin(AXIS))/math.cos(AXIS)
    # One square outline for the tall block: the OSM south wall steps 1.6 m at
    # the east end, which made two gable planes under one roof. Straighten it.
    new_wall=list(wallpoly)
    new_wall[3]=from_st(S_NOTCH,T_COURT)
    new_wall[4]=from_st(S_NOTCH,T_NOTCH)
    new_wall[5]=from_st(S_EAST,T_NOTCH)
    new_wall[6]=from_st(S_EAST,T_SOUTH)
    new_wall[8]=from_st(ws[8][0],T_SOUTH)
    new_wall[9]=from_st(ws[9][0],T_SOUTH)
    for i in (12,13):      # north corners of the wing
        new_wall[i]=from_st(ws[i][0],t_end(ws[i][0]))
    del new_wall[7]
    wallpoly=new_wall
    low=Gable(pz,"west-wing-west-slope","west-wing-east-slope",-24,19)
    tall=Gable(pz,"tall-roof-west-slope","tall-roof-east-slope",-23,T_COURT)
    # Valley: where the low east slope meets the tall west slope. The lidar
    # section shows both slopes ending 0.3 m apart at z 113.1-113.4, i.e. a V
    # (planes cross at z 113.2) with the low roof running into the tall one.
    SV=(low.zr+low.m*low.sr-tall.zr+tall.m*tall.sr)/(low.m+tall.m)
    ZV=low.z(SV)
    T_S=T_SOUTH-OVER # south ends: lidar roof edge -24.2 (low wing) / -24.7 (tall)
    S_LW=sum(to_st(e-origin[0],n-origin[1])[0] for e,n in [sections["clubhouse-west-low"]["roofEdge3006"][i] for i in (0,3)])/2
    S_LE=S_WINGE+OVER                # low east eave, north of the tall roof
    S_TE=S_EAST+OVER                 # tall east eave
    S_TN=S_NOTCH-OVER                # west edge of the tall roof's northern block
    T_TC=T_COURT+OVER                # tall courtyard gable end
    T_TN=T_NOTCH+OVER                # tall north end (notch block)
    Z=lambda s: low.z(s)
    ZT=lambda s: tall.z(s)
    def wall_top(p,q):
        s,_=to_st(*p)
        sq,tq=to_st(*q)
        inside_tall=sq>=SV and (tq<=T_COURT+.02 or (sq>=S_NOTCH and tq<=T_NOTCH+.1))
        return (ZT if inside_tall else Z)(s)
    ROOF_REPORT.update(axisDeg=math.degrees(AXIS),overhang=OVER,
        low=dict(ridgeS=low.sr,ridgeZabs=low.zr+ground,pitchDeg=math.degrees(math.atan(low.m)),westEaveS=S_LW,eastEaveS=S_LE),
        tall=dict(ridgeS=tall.sr,ridgeZabs=tall.zr+ground,pitchDeg=math.degrees(math.atan(tall.m)),eastEaveS=S_TE),
        valley=dict(s=SV,zAbs=ZV+ground),southEndT=T_S,wallLines=dict(east=S_EAST,south=T_SOUTH,courtyard=T_COURT,notch=S_NOTCH,notchEnd=T_NOTCH,wingEast=S_WINGE))
    shell(g,wallpoly,wall_top,breaks=[low.sr,tall.sr,SV])
    # Roof planes as plan polygons (s,t), CCW; `fascia` lists the edges that get a
    # fascia/bargeboard (not the shared ridge and valley edges).
    Zp=lambda p: Z(p[0])
    ZTp=lambda p: ZT(p[0])
    te=t_end
    roof_slab(g,[(S_LW,T_S),(low.sr,T_S),(low.sr,te(low.sr)),(S_LW,te(S_LW))],Zp,{0,2,3})
    roof_slab(g,[(low.sr,T_S),(SV,T_S),(SV,T_COURT),(S_LE,T_COURT),(S_LE,te(S_LE)),(low.sr,te(low.sr))],Zp,{0,3,4})
    roof_slab(g,[(SV,T_S),(tall.sr,T_S),(tall.sr,T_TN),(S_TN,T_TN),(S_TN,T_TC),(SV,T_TC)],ZTp,{0,2,3,4})
    roof_slab(g,[(tall.sr,T_S),(S_TE,T_S),(S_TE,T_TN),(tall.sr,T_TN)],ZTp,{0,1,2})
    ridge_cap(g,low,T_S,te(low.sr))
    ridge_cap(g,tall,T_S,T_TN)
    # Gutters on the exposed eaves, downpipes on the east wall and the wing's
    # courtyard wall. The V valley drains through its own flashing.
    sd=lambda s,t,z: (*from_st(s,t),z)
    ex,ey=from_st(1,0)
    gutter(g,sd(S_LW,T_S+.05,Z(S_LW)),sd(S_LW,te(S_LW)-.05,Z(S_LW)),(-ex,-ey))
    top=gutter(g,sd(S_TE,T_S+.05,ZT(S_TE)),sd(S_TE,T_TN-.05,ZT(S_TE)),(ex,ey))
    for t in (T_SOUTH+1.0,T_NOTCH-.5):
        downpipe(g,(*from_st(S_TE+.045,t),top[2]),from_st(S_EAST+.07,t),.05)
    t_lo,t_hi=foyer(g,low,S_WINGE,OVER)
    for ta,tb in [(T_COURT+.05,t_lo-.15),(t_hi+.15,te(S_LE)-.05)]:
        gutter(g,sd(S_LE,ta,Z(S_LE)),sd(S_LE,tb,Z(S_LE)),(ex,ey))
    for t in (T_COURT+1.0,te(S_LE)-.8):
        downpipe(g,(*from_st(S_LE+.045,t),Z(S_LE)-.10-.07),from_st(S_WINGE+.07,t),.05)
    # Valley flashing: one raised zinc sheet laid on both slopes along the crease,
    # with a low skirt on each outer edge so no sliver of roof shows under it.
    hw,lift,ta,tb=.3,.035,T_S+.35,T_COURT
    left,right,mid=(SV-hw,Z),(SV+hw,ZT),(SV,Z)
    inside=Vector(at(SV,(ta+tb)/2,ZV-1))
    for (s0,f0),(s1,f1) in ((left,mid),(mid,right)):
        outward(g,[at(s0,ta,f0(s0)+lift),at(s1,ta,f1(s1)+lift),at(s1,tb,f1(s1)+lift),at(s0,tb,f0(s0)+lift)],inside,"galvanised")
    for s,f,sgn in ((left[0],Z,-1),(right[0],ZT,1)):
        outward(g,[at(s,ta,f(s)),at(s,tb,f(s)),at(s,tb,f(s)+lift),at(s,ta,f(s)+lift)],Vector(at(s-sgn,(ta+tb)/2,ZV)),"galvanised")
    # The low roof abuts the tall volume's courtyard wall. That wall stops at the
    # wing's east wall, so a wedge of it closes the gap between the low slope and
    # the tall slope's soffit, with step flashing up the wall.
    s0=SV+.1/(low.m+tall.m)
    south=lambda s,z: Vector(at(s,T_COURT-1,z))
    outward(g,[at(s0,T_COURT,Z(s0)),at(S_WINGE,T_COURT,Z(S_WINGE)),at(S_WINGE,T_COURT,ZT(S_WINGE)-.1)],south(S_WINGE,Z(S_WINGE)),"omberg_red")
    outward(g,[at(s0,T_COURT,Z(s0)),at(S_LE,T_COURT,Z(S_LE)),at(S_LE,T_COURT+.3,Z(S_LE)+.03),at(s0,T_COURT+.3,Z(s0)+.03)],Vector(at(s0,T_COURT,Z(s0)-1)),"galvanised")
    outward(g,[at(s0,T_COURT+.015,Z(s0)+.03),at(S_LE,T_COURT+.015,Z(S_LE)+.03),at(S_LE,T_COURT+.015,Z(S_LE)+.17),at(s0,T_COURT+.015,Z(s0)+.17)],south(s0,Z(s0)),"galvanised")
    # Terrace end: the low roof runs 8 m past the wing's south wall over the
    # sheltered terrace. Close its gable with a glazed ground floor and a red
    # board gable above, on the tall block's south wall line.
    sa,sb=S_LW,S_TALLW
    xg=477787.9-origin[0]                    # the terrace's west glazing line: the south glazing starts there
    xa,ya=xg,(T_SOUTH-xg*math.sin(AXIS))/math.cos(AXIS)
    xb,yb=from_st(sb,T_SOUTH)
    framed_face(g,(xa,ya,0),(xb,yb,0),.25,2.65,7,"omberg_dark_brown",bars=1)
    topw=lambda s: (ZT if s>=SV else Z)(s)-.1
    north=Vector(at(0,T_SOUTH+5,5))
    outward(g,[at(sa,T_SOUTH,2.65),at(SV,T_SOUTH,2.65),at(SV,T_SOUTH,topw(SV)),at(low.sr,T_SOUTH,topw(low.sr)),at(sa,T_SOUTH,topw(sa))],north,"omberg_red")
    outward(g,[at(SV,T_SOUTH,2.65),at(sb,T_SOUTH,2.65),at(sb,T_SOUTH,topw(sb)),at(SV,T_SOUTH,topw(SV))],north,"omberg_red")
    # Sheltered western dining terrace, clearly visible in both ortho vintages.
    deckx=477785.5-origin[0]
    deckx1=477791.7-origin[0]
    # The deck ends at the south wall line (the ortho agrees: N 6457635.7), not at the traced 6457633.4.
    y0,y1=(T_SOUTH-(deckx-.5)*math.sin(AXIS))/math.cos(AXIS),6457679-origin[1]
    g.box(((deckx+deckx1)/2,(y0+y1)/2,.08),(deckx1-deckx,y1-y0,.28),"omberg_deck")
    framed_face(g,(477787.9-origin[0],y1,0),(477787.9-origin[0],y0,0),.25,2.65,23,"omberg_dark_brown",bars=1)
    for y in [y0+i*(y1-y0)/12 for i in range(13)]:
        g.box((477787.9-origin[0],y,1.47),(.11,.11,2.5),"omberg_dark_brown")
    # West terrace awning: lidar sees a roof 2.6-2.8 m above ground, falling outwards, on the
    # outer side of the glazing (E 477785.9-786.8, N 6457648.7-678). The course-side photo shows
    # striped awnings, so it is a light striped canopy on the glazing line, no posts.
    ax0,ax1=xg-.0,xg-1.75
    ay0,ay1=6457648.5-origin[1],6457678.2-origin[1]
    nstripe=20
    for i in range(nstripe):
        ya,yb=ay0+(ay1-ay0)*i/nstripe,ay0+(ay1-ay0)*(i+1)/nstripe
        m="omberg_sage" if i%2 else "omberg_ivory_trim"
        g.poly([(ax0,ya,2.85),(ax1,ya,2.55),(ax1,yb,2.55),(ax0,yb,2.85)][::-1],m)
        g.poly([(ax0,ya,2.82),(ax1,ya,2.52),(ax1,yb,2.52),(ax0,yb,2.82)],"omberg_dark_brown")
        g.poly([(ax1,ya,2.55),(ax1,ya,2.38),(ax1,yb,2.38),(ax1,yb,2.55)][::-1],m)
    # Main east elevation, upper accommodation floor and lower restaurant bays.
    fp=[(-16,-24),(16,24)]
    for n in [6457640,6457644.5,6457649,6457653.5,6457658,6457663.5,6457667.5]:
        for sill in [.95,3.95]:
            # the east wall line s=S_EAST: x = S/cos + y*tan (axis skew)
            facade_x=S_EAST/math.cos(AXIS)+(n-origin[1])*math.tan(AXIS)+.045
            kit.opening(g,opening("+x",n-origin[1],w=1.5,h=1.5,sill=sill,plane=facade_x),fp,None,"omberg_ivory_trim")
    for e in [477805,477809,477813,477817,477821]:
        for sill in [.95,4.0]:
            # the south wall line t=T_SOUTH: y = (t - x sin)/cos
            facade_y=(T_SOUTH-(e-origin[0])*math.sin(AXIS))/math.cos(AXIS)
            kit.opening(g,opening("-y",e-origin[0],w=1.45,h=1.45,sill=sill,plane=facade_y-.045),fp,None,"omberg_ivory_trim")
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
