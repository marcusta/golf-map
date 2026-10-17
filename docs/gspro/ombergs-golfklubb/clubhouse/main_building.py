"""Photo-led main building with a continuous kinked shell and recessed glazing.

Geometry is asset-local EN, z relative to the placement base. Measured roof
centres and heights come from survey.json; facade bay types come from the user's
course-side photograph. Unseen elevations use restrained inferred windows.
"""
import math

from mathutils import Matrix, Vector
import props_kit as kit


def register_materials():
    kit.MATERIALS.update({
        "omberg_main_grey": (None,(1,1),(155,160,163),0,0),
        "omberg_basement_stone": ("mainstone",(2.5,2.5),None,0,0),
        "omberg_main_frame": (None,(1,1),(65,85,69),.12,0),
        "omberg_main_reveal": (None,(1,1),(136,144,139),0,0),
        "omberg_main_sill": (None,(1,1),(91,103,94),0,0),
        "omberg_main_glass": (None,(1,1),(90,112,120),.42,0),
        "omberg_main_void": (None,(1,1),(7,11,13),0,0),
        "omberg_main_roof": ("mainmetal",(1.8,1.8),None,0,0),
        "omberg_main_gutter": (None,(1,1),(89,100,98),.16,0),
        "omberg_main_panel_joint": (None,(1,1),(146,153,149),0,0),
    })
    kit.TextureBank.tex_mainstone=stone_texture
    kit.TextureBank.tex_mainmetal=metal_texture


def stone_texture(bank):
    import numpy as np
    S=bank.size
    yy,xx=np.mgrid[0:S,0:S]/S
    rng=np.random.default_rng(719)
    centres=[(x/6+rng.uniform(-.05,.05),y/5+rng.uniform(-.065,.065)) for y in range(5) for x in range(6)]
    first=np.full((S,S),100.)
    second=first.copy()
    ids=np.zeros((S,S),int)
    for i,(x,y) in enumerate(centres):
        dx=(xx-x+.5)%1-.5
        dy=(yy-y+.5)%1-.5
        d=dx*dx+dy*dy
        change=d<first
        second=np.where(change,first,np.minimum(second,d))
        ids=np.where(change,i,ids)
        first=np.minimum(first,d)
    joint=(second-first)<.00034
    grain=kit._fbm((S,S),720,scales=(64,16,4))
    shade=rng.uniform(.96,1.04,len(centres))[ids]+.025*(grain-.5)
    rgb=np.array([86,94,91])[None,None,:]/255*shade[:,:,None]
    rgb=np.where(joint[:,:,None],np.array([77,85,81])/255,rgb)
    # Shallow rough stone, without high-contrast checker blocks or broad dirt.
    height=np.where(joint,.43,.52)+.025*(grain-.5)
    return rgb,height,.35


def metal_texture(bank):
    import numpy as np
    S=bank.size
    x=np.arange(S)[None,:]/S*4
    edge=(x%1)<.025
    broad=kit._fbm((S,S),821,scales=(128,32))
    tone=.985+.025*(broad-.5)
    tone=np.where(edge,tone*.94,tone)
    rgb=np.array([146,151,150])[None,None,:]/255*tone[:,:,None]
    height=np.broadcast_to(np.where(edge,.60,.50),(S,S)).copy()
    return rgb,height,.6


def clip_scalar(poly, value):
    """Keep the half-plane where a linear scalar function is nonnegative."""
    out=[]
    for a,b in zip(poly,poly[1:]+poly[:1]):
        va,vb=value(a),value(b)
        ia,ib=va>=-1e-8,vb>=-1e-8
        if ia:
            out.append(a)
        if ia!=ib:
            t=va/(va-vb)
            out.append((a[0]+(b[0]-a[0])*t,a[1]+(b[1]-a[1])*t))
    return out


# Roof. The two wings share ONE ridge height and ONE eave height (lidar P99 of
# both sections is 120.95-121.01 m, so the ridge is measured, not invented).
# Where the 24.3 m diagonal wing ends on the straight wing, the end of the
# diagonal is not a gable but a shared interface line: the ridges meet in one
# bent ridge, the inside of the bend (course side) is a valley and the outside
# a hip. For that line to be the exact plane-plane intersection (no step, no
# sliver, no gable wall above the other roof) the straight wing needs
# W_straight = W_diagonal*cos(bend) and pitch_straight = pitch_diagonal/cos(bend);
# the lidar width of the straight roof (12.75 m) agrees with that (12.57 m).
RIDGE,EAVE=121.0,118.4
OVER=.4        # roof overhang past the wall: gables and the diagonal's eaves
THICK=.16      # roof slab thickness = fascia height; wall tops stop at the soffit
GUTTER_R,PIPE_R=.06,.045

# Plan position, fitted to the class-1 lidar points (lidar-crop.npz) rather than the ortho
# traces, which lean tall roofs by up to 1.5 m. EPSG:3006. Ridge lines: robust fits of
# z = R - pitch*|lateral offset| to the points above 116 m on each wing (R 120.96-121.03,
# pitch 0.32-0.34 diagonal, 0.404 straight, whose ratio is 1/cos(bend) as the roof needs).
DIAG_RIDGE,DIAG_YAW=(477797.03,6457695.33),148.4    # a ridge point; bearing = the west lodge's axis
STRAIGHT_RIDGE,STRAIGHT_YAW=(477797.0,6457688.0),1.5  # a ridge point; bearing = the clubhouse wing's axis
HALF_W=7.5          # diagonal roof half width at the eaves (lidar: ridge -7.44 / +8.0 across)
NW_LEN=23.2         # ridge length from the bend to the diagonal's north-west verge (last return 23.2)
SOUTH_VERGE_N=6457681.3   # northing of the straight wing's south verge on its ridge (last 120 m return 681.2)
# The connector's final south wall plane, for the clubhouse wing to end against: it passes through
# (SOUTH_WALL_E, SOUTH_WALL_N) and runs along bearing 91.5 deg (northing falls 0.026 m per metre east).
SOUTH_WALL_N=SOUTH_VERGE_N+OVER*math.cos(math.radians(STRAIGHT_YAW))
SOUTH_WALL_E=STRAIGHT_RIDGE[0]+(SOUTH_WALL_N-STRAIGHT_RIDGE[1])*math.tan(math.radians(STRAIGHT_YAW))
# Low flat-roofed porch on the diagonal's north-east wall (lidar: flat returns at 109.47 m, E 797.5-800.4,
# N 706.9-712.6). Along the ridge from the bend, across from the ridge, top height.
PORCH_X,PORCH_Y,PORCH_TOP=(-14.3,-8.3),(7.1,10.3),109.47
# Stair bay on top of the porch: a small gable with a level ridge that runs out over the east eave
# (lidar: ridge 120.45 m at 11.2 m before the bend, pitch 0.55 both ways, verge 1.4 m past the wall).
BAY_XC,BAY_HALF,BAY_RIDGE,BAY_PITCH,BAY_END=-11.2,2.9,120.45,.55,8.9


def subtract_convex(poly,cutter):
    """Disjoint convex pieces of poly outside a convex cutter."""
    remaining=poly
    result=[]
    for a,b in zip(cutter,cutter[1:]+cutter[:1]):
        def side(p):
            return (b[0]-a[0])*(p[1]-a[1])-(b[1]-a[1])*(p[0]-a[0])
        outside=clip_scalar(remaining,lambda p:-side(p))
        if len(outside)>=3:
            result.append(outside)
        remaining=clip_scalar(remaining,side)
        if len(remaining)<3:
            break
    return result


def clean(poly):
    out=[]
    for p in poly:
        if not out or math.dist(p,out[-1])>1e-6:
            out.append(p)
    if len(out)>1 and math.dist(out[0],out[-1])<=1e-6:
        out.pop()
    return out


class Volume:
    """Gable prism: ridge along local x, roof falling to EAVE at +-W/2.

    x1 is the roof end on the interface side; `keep` (scalar, >=0 inside)
    trims a wing that runs past the interface. Walls are inset by OVER at the
    free gable end and by oy on the eaves, and run right up to the interface."""
    def __init__(self,centre,length,width,yaw,base,course_side,x1,oy,keep=None):
        self.c=centre
        self.L,self.W=length,width
        self.angle=math.radians(90-yaw)
        self.cos,self.sin=math.cos(self.angle),math.sin(self.angle)
        self.base=base
        self.course_side=course_side
        self.oy=oy
        self.x0,self.x1=-length/2,x1
        self.roof=self.rectangle(self.x0,x1,width/2,keep)
        self.wall=self.rectangle(self.x0+OVER,x1,width/2-oy,keep)

    def world(self,x,y):
        return (self.c[0]+self.cos*x-self.sin*y,self.c[1]+self.sin*x+self.cos*y)

    def local(self,p):
        dx,dy=p[0]-self.c[0],p[1]-self.c[1]
        return (dx*self.cos+dy*self.sin,-dx*self.sin+dy*self.cos)

    def rectangle(self,xa,xb,y,keep):
        poly=[self.world(x,yy) for x,yy in [(xa,-y),(xb,-y),(xb,y),(xa,y)]]
        return clean(clip_scalar(poly,keep)) if keep else poly

    def height(self,p):
        return RIDGE-self.base-(RIDGE-EAVE)*abs(self.local(p)[1])/(self.W/2)   # relative to base

    def label(self,a,b,x0,yh):
        """0/2: eave at -y/+y, 3: free gable end. None: ridge or interface."""
        (ax,ay),(bx,by)=self.local(a),self.local(b)
        near=lambda u,v:abs(u-v)<1e-4
        if near(ay,-yh) and near(by,-yh): return 0
        if near(ay,yh) and near(by,yh): return 2
        if near(ax,x0) and near(bx,x0): return 3
        return None

    def edges(self,roof):
        poly=self.roof if roof else self.wall
        x0=self.x0 if roof else self.x0+OVER
        yh=self.W/2 if roof else self.W/2-self.oy
        for a,b in zip(poly,poly[1:]+poly[:1]):
            lab=self.label(a,b,x0,yh)
            if lab is not None:
                yield lab,a,b

    def roof_faces(self):
        for sign in [-1,1]:
            poly=clean(clip_scalar(self.roof,lambda p:sign*self.local(p)[1]))
            if len(poly)>=3:
                yield poly


def unit(v):
    n=math.hypot(*v)
    return (v[0]/n,v[1]/n)


def outward(a,b):
    """Outward normal of an edge of a counter-clockwise polygon."""
    return unit((b[1]-a[1],-(b[0]-a[0])))


class Neighbour:
    """A roof the connector abuts, as a heightfield over its footprint. Constants are
    ray-cast from the built omberg_clubhouse / omberg_west_lodge meshes (2026-10-17):
    the tile wing (true gable, ridge 115.12, pitch 0.42, ridge on the 1.5 deg axis)
    ends against SOUTH_WALL_N; the west lodge's south-east end reaches 1.5 m past the
    connector's north-west gable. Re-measure if either roof moves. Absolute EN and z."""
    def __init__(self,centre,axis,half_len,half_wid,ridge,pitch):
        self.c,self.ax=centre,axis
        self.hl,self.hw,self.ridge,self.pitch=half_len,half_wid,ridge,pitch

    def top(self,e,n):
        dx,dy=e-self.c[0],n-self.c[1]
        s=dx*self.ax[0]+dy*self.ax[1]
        l=-dx*self.ax[1]+dy*self.ax[0]
        if abs(s)<=self.hl and abs(l)<=self.hw:
            return self.ridge-self.pitch*abs(l)
        return None


_wa=(math.sin(math.radians(STRAIGHT_YAW)),math.cos(math.radians(STRAIGHT_YAW)))
NEIGHBOURS=[Neighbour((SOUTH_WALL_E-_wa[0]*12,SOUTH_WALL_N-_wa[1]*12),_wa,12.,7.3,115.12,.42),
            Neighbour((477780.1,6457724.03),(.5240,-.8517),12.6,7.3,114.8,.4217)]


def neighbour_top(e,n):
    tops=[t for t in (nb.top(e,n) for nb in NEIGHBOURS) if t is not None]
    return max(tops) if tops else None


def cap(g,pts,roof_z,mat,half=.16,rise=.075,sink=.02,ext=(0,0),taper=False):
    """Ridge/hip cap along a 3D polyline: a low prism whose lower edges sit on the
    roof surface (roof_z) either side, mitred at bends so it stays one piece."""
    pts=[Vector(p) for p in pts]
    if ext[0]: pts[0]=pts[0]+(pts[0]-pts[1]).normalized()*ext[0]
    if ext[1]: pts[-1]=pts[-1]+(pts[-1]-pts[-2]).normalized()*ext[1]
    rings=[]
    for i,p in enumerate(pts):
        segs=[]
        if i>0: segs.append(unit((p.x-pts[i-1].x,p.y-pts[i-1].y)))
        if i<len(pts)-1: segs.append(unit((pts[i+1].x-p.x,pts[i+1].y-p.y)))
        t=unit((sum(s[0] for s in segs),sum(s[1] for s in segs)))
        m=(-t[1],t[0])
        w=half/max(.5,abs(m[0]*-segs[0][1]+m[1]*segs[0][0]))   # mitre widening
        l=(p.x+m[0]*w,p.y+m[1]*w)
        r=(p.x-m[0]*w,p.y-m[1]*w)
        rz=.01 if taper and i==len(pts)-1 else rise    # a cap that ends at an eave runs out flat, not as a block
        rings.append(((l[0],l[1],roof_z(l)-sink),(p.x,p.y,p.z+rz),(r[0],r[1],roof_z(r)-sink)))
    for r0,r1 in zip(rings,rings[1:]):
        g.poly([r0[0],r0[1],r1[1],r1[0]],mat)
        g.poly([r0[1],r0[2],r1[2],r1[1]],mat)
    g.poly([rings[0][0],rings[0][2],rings[0][1]],mat)
    g.poly([rings[-1][0],rings[-1][1],rings[-1][2]],mat)


def downpipe(g,wall,out,gutter,base,origin):
    """Elbow under the soffit from the gutter outlet to the wall, then straight down.
    Over a neighbour's roof it ends in a short spout just above that roof instead."""
    top=(gutter[0],gutter[1],EAVE-.16-base)
    knee=(wall[0]+out[0]*.07,wall[1]+out[1]*.07)
    g.pipe(top,(knee[0],knee[1],EAVE-.62-base),PIPE_R,"omberg_main_gutter",seg=8)
    roof=neighbour_top(knee[0]+origin[0],knee[1]+origin[1])
    if roof is None:
        g.pipe((knee[0],knee[1],EAVE-.62-base),(knee[0],knee[1],105.5-base),PIPE_R,"omberg_main_gutter",seg=8)
        return
    tip=(knee[0]+out[0]*.3,knee[1]+out[1]*.3)
    tip_roof=neighbour_top(tip[0]+origin[0],tip[1]+origin[1])
    z=max(roof+.45,(tip_roof if tip_roof is not None else roof)+.3+.12)-base
    g.pipe((knee[0],knee[1],EAVE-.62-base),(knee[0],knee[1],z),PIPE_R,"omberg_main_gutter",seg=8)
    g.pipe((knee[0],knee[1],z),(tip[0],tip[1],z-.3),PIPE_R,"omberg_main_gutter",seg=8)


def window(g,t,z,w,h,cols,rows):
    """Real pocket: 22 cm deep wall reveals, an inset frame and a dark back."""
    x0,x1=t-w/2,t+w/2
    y0,y1=z,z+h
    outer=[(x0,y0,0),(x1,y0,0),(x1,y1,0),(x0,y1,0)]
    inner=[(x0+.018,y0+.018,-.22),(x1-.018,y0+.018,-.22),
           (x1-.018,y1-.018,-.22),(x0+.018,y1-.018,-.22)]
    for i in range(4):
        j=(i+1)%4
        g.poly([outer[i],outer[j],inner[j],inner[i]],"omberg_main_reveal")
    fw=.055
    for xx in [x0+fw/2,x1-fw/2]:
        g.box((xx,(y0+y1)/2,-.195),(fw,h,.085),"omberg_main_frame")
    for yy in [y0+fw/2,y1-fw/2]:
        g.box((t,yy,-.195),(w,fw,.085),"omberg_main_frame")
    g.poly([(x0+fw,y0+fw,-.247),(x1-fw,y0+fw,-.247),
            (x1-fw,y1-fw,-.247),(x0+fw,y1-fw,-.247)],"omberg_main_glass")
    g.box((t,(y0+y1)/2,-.65),(w-.06,h-.06,.035),"omberg_main_void")
    for i in range(1,cols):
        g.box((x0+w*i/cols,(y0+y1)/2,-.205),(.032,h-.07,.055),"omberg_main_frame")
    for i in range(1,rows):
        g.box((t,y0+h*i/rows,-.205),(w-.07,.028,.055),"omberg_main_frame")
    g.box((t,y0-.018,-.085),(w+.10,.045,.35),"omberg_main_sill")
    g.box((t,y1+.012,-.03),(w+.075,.025,.11),"omberg_main_sill")


def facade(g,volume,edge,a,b,openings,buried=None):
    dx,dy=b[0]-a[0],b[1]-a[1]
    length=math.hypot(dx,dy)
    ux,uy=dx/length,dy/length
    nx,ny=uy,-ux
    g.push(Matrix(((ux,0,nx,a[0]),(uy,0,ny,a[1]),(0,1,0,0),(0,0,0,1))))
    bottom=105.2-volume.base
    band=108.95-volume.base
    os=[]
    for p,z,w,h,cols,rows in openings:
        t=(p[0]-a[0])*ux+(p[1]-a[1])*uy
        if t-w/2>.12 and t+w/2<length-.12:
            # A window whose reveal, frame or sill touches a neighbouring roof or wall is dropped.
            if buried and any(buried((a[0]+ux*(t+dt)+nx*d,a[1]+uy*(t+dt)+ny*d),z+dz)
                              for dt in (-w/2-.1,w/2+.1) for dz in (-.12,h+.12) for d in (0,.35)):
                continue
            os.append((t,z,w,h,cols,rows))
    xs=sorted(set([0.,length]+[v for t,z,w,h,c,r in os for v in [t-w/2,t+w/2]]))
    zs=sorted(set([bottom,band,RIDGE-volume.base]+[v for t,z,w,h,c,r in os for v in [z,z+h]]))
    def top(t):
        return volume.height((a[0]+ux*t,a[1]+uy*t))-THICK
    # End gables must split at the ridge, independent of the glazing grid.
    la,lb=volume.local(a),volume.local(b)
    if la[1]*lb[1]<0:
        xs=sorted(set(xs+[length*(-la[1])/(lb[1]-la[1])]))
    for x0,x1 in zip(xs[:-1],xs[1:]):
        for z0,z1 in zip(zs[:-1],zs[1:]):
            midx,midz=(x0+x1)/2,(z0+z1)/2
            if any(abs(midx-t)<w/2-1e-7 and z<midz<z+h for t,z,w,h,c,r in os):
                continue
            za,zb=min(z1,top(x0)),min(z1,top(x1))
            if max(za,zb)<=z0+.0001:
                continue
            pts=[(x0,z0,0),(x1,z0,0),(x1,max(z0,zb),0),(x0,max(z0,za),0)]
            mat="omberg_basement_stone" if (z0+z1)/2<band else "omberg_main_grey"
            g.poly(pts,mat)
    for t,z,w,h,c,r in os:
        if z+h<top(t)-.2:
            window(g,t,z,w,h,c,r)
    # Restrained vertical panel joints, visible in the supplied course photo.
    if edge==volume.course_side:
        for frac in [.2,.4,.6,.8]:
            t=length*frac
            if not any(abs(t-ot)<w/2+.1 for ot,z,w,h,c,r in os) and not (
                    buried and buried((a[0]+ux*t,a[1]+uy*t),band)):
                g.box((t,(band+top(t))/2,.001),(.014,top(t)-band,.0015),"omberg_main_panel_joint")
    g.pop()


def window_layout(volume,edge,diagonal,segment=None):
    L,W=volume.L-2*OVER,volume.W-2*volume.oy
    out=[]
    def at(x,y,z,w,h,cols=2,rows=2):
        out.append((volume.world(x,y),z-volume.base,w,h,cols,rows))
    if edge in [0,2]:
        y=-W/2 if edge==0 else W/2
        if edge==volume.course_side:
            # Lay bays out on the exposed union edge, not the hidden original
            # rectangle. The first small bay must survive the kink's overlap.
            a,b=segment
            length=math.dist(a,b)
            bays=[(.12,1.50),(.33,1.50),(.57,3.25),(.82,3.25)] if diagonal else [(.16,1.50),(.50,3.25),(.84,1.50)]
            for frac,w in bays:
                p=(a[0]+(b[0]-a[0])*frac,a[1]+(b[1]-a[1])*frac)
                def put(z,ww,hh,cols=2,rows=2):
                    out.append((p,z-volume.base,ww,hh,cols,rows))
                for z in [109.65,112.65]:
                    put(z,1.50,1.25)
                put(115.75 if w>2 else 116.0,w,1.70 if w>2 else 1.20,4 if w>2 else 2,3 if w>2 else 2)
                put(106.65,1.2,1.20)
        else:
            for x in [-L*.32,0,L*.32]:
                for z in [109.65,112.65,115.90]:
                    at(x,y,z,1.50,1.25)
    else:
        x=L/2 if edge==1 else -L/2
        for y in [-W*.22,W*.22]:
            for z in [109.65,112.65,115.90]:
                at(x,y,z,1.50,1.25)
    return out


def build(sections,origin,base):
    g=kit.Geo()
    o=origin
    def loc(p): return (p[0]-o[0],p[1]-o[1])
    A=math.radians(90-DIAG_YAW)
    a=(math.cos(A),math.sin(A))              # diagonal ridge direction, towards the straight wing
    lat=(-a[1],a[0])                          # its lateral direction (+y, east side)
    B=math.radians(90-STRAIGHT_YAW)
    b=(math.cos(B),math.sin(B))              # straight ridge direction (north)
    es=(-b[1],b[0])                           # its lateral direction (+y = west, the course side)
    pd,ps=loc(DIAG_RIDGE),loc(STRAIGHT_RIDGE)
    # The bend is where the two ridges cross.
    den=a[0]*b[1]-a[1]*b[0]
    t=((ps[0]-pd[0])*b[1]-(ps[1]-pd[1])*b[0])/den
    X=(pd[0]+a[0]*t,pd[1]+a[1]*t)
    k=abs(lat[0]*es[0]+lat[1]*es[1])          # cos(bend)
    cd=(X[0]-a[0]*NW_LEN/2,X[1]-a[1]*NW_LEN/2)
    diag=Volume(cd,NW_LEN,2*HALF_W,DIAG_YAW,base,0,NW_LEN/2,OVER)
    # South verge point on the straight ridge; the wing runs north from it and is cut at the bend.
    s0=((loc((0,SOUTH_VERGE_N))[1]-ps[1])/b[1])
    south=(ps[0]+b[0]*s0,ps[1]+b[1]*s0)
    SL=17.5                                   # nominal length (window rhythm); the wing is trimmed at the bend
    cs=(south[0]+b[0]*SL/2,south[1]+b[1]*SL/2)
    straight=Volume(cs,SL,2*HALF_W*k,STRAIGHT_YAW,base,2,SL/2+6,OVER*k,
                    keep=lambda p:(p[0]-X[0])*a[0]+(p[1]-X[1])*a[1])
    volumes=[diag,straight]
    iw=(X[0]-lat[0]*HALF_W,X[1]-lat[1]*HALF_W)   # interface ends: west (inner) and east (outer) eave corners
    ie=(X[0]+lat[0]*HALF_W,X[1]+lat[1]*HALF_W)
    def porch_pt(x,y): return (X[0]+a[0]*x+lat[0]*y,X[1]+a[1]*x+lat[1]*y)
    porch=[porch_pt(PORCH_X[0],PORCH_Y[0]),porch_pt(PORCH_X[1],PORCH_Y[0]),
           porch_pt(PORCH_X[1],PORCH_Y[1]),porch_pt(PORCH_X[0],PORCH_Y[1])]
    def in_porch(p):
        d=(p[0]-X[0],p[1]-X[1])
        x,y=d[0]*a[0]+d[1]*a[1],d[0]*lat[0]+d[1]*lat[1]
        return PORCH_X[0]-.05<=x<=PORCH_X[1]+.05 and PORCH_Y[0]-.05<=y<=PORCH_Y[1]+.05
    def in_bay(p):
        d=(p[0]-X[0],p[1]-X[1])
        x,y=d[0]*a[0]+d[1]*a[1],d[0]*lat[0]+d[1]*lat[1]
        return abs(x-BAY_XC)<=BAY_HALF-OVER+.1 and HALF_W-OVER-.05<=y<=BAY_END-OVER+.05
    def W2(x,y): return (X[0]+a[0]*x+lat[0]*y,X[1]+a[1]*x+lat[1]*y)
    def bay_z(x): return BAY_RIDGE-base-BAY_PITCH*abs(x-BAY_XC)
    # Bay roof faces in (along, across) coordinates from the bend: inner halves only where above the
    # main east slope (they are cut out of it, valleys on the plane intersections), outer halves whole.
    bay_cutters,bay_faces=[],[]
    pm=(RIDGE-EAVE)/HALF_W
    for side in (-1,1):
        xa,xb=(BAY_XC-BAY_HALF,BAY_XC) if side<0 else (BAY_XC,BAY_XC+BAY_HALF)
        inner=[(xa,0),(xb,0),(xb,HALF_W),(xa,HALF_W)]
        def above(q,side=side): return BAY_RIDGE-BAY_PITCH*abs(q[0]-BAY_XC)-(RIDGE-pm*q[1])
        inner=clean(clip_scalar(inner,above))
        if len(inner)>=3:
            bay_cutters.append([W2(*q) for q in inner]); bay_faces.append(inner)
        bay_faces.append([(xa,HALF_W),(xb,HALF_W),(xb,BAY_END),(xa,BAY_END)])
    def roof_z(p):
        v=straight if (p[0]-X[0])*a[0]+(p[1]-X[1])*a[1]>=0 else diag
        return v.height(p)
    def buried(p,z):
        if in_porch(p) and z+base<PORCH_TOP+.1 or in_bay(p) and z+base>PORCH_TOP-.1:
            return True
        top=neighbour_top(p[0]+origin[0],p[1]+origin[1])
        return top is not None and z+base<top+.1
    for index,v in enumerate(volumes):
        for edge,a_,b_ in v.edges(False):
            facade(g,v,edge,a_,b_,window_layout(v,edge,index==0,(a_,b_)),buried)
        for poly in v.roof_faces():
            pieces=[poly]
            if v is diag and sum(v.local(q)[1] for q in poly)>0:      # east slope: the bay roof stands above it
                for cut in bay_cutters:
                    pieces=[r for pc in pieces for r in subtract_convex(pc,cut)]
            for poly in pieces:
                pts=[Vector((x,y,v.height((x,y)))) for x,y in poly]
                uv=[(v.local((p.x,p.y))[0]+v.L/2,abs(v.local((p.x,p.y))[1])) for p in pts]
                # Standing seams are in the phase-aligned albedo/normal only.
                # Millimetre-scale physical strips alias in Unity's course views.
                g.poly([tuple(p) for p in pts],"omberg_main_roof",uv=("uv",uv))
                g.poly([(p.x,p.y,p.z-THICK) for p in reversed(pts)],"omberg_main_reveal")
                # Fascia / bargeboard: the slab edge on eaves and verges, closed at every corner.
                for p,q in zip(pts,pts[1:]+pts[:1]):
                    if v.label((p.x,p.y),(q.x,q.y),v.x0,v.W/2) is not None:
                        g.poly([(p.x,p.y,p.z-THICK),(q.x,q.y,q.z-THICK),(q.x,q.y,q.z),(p.x,p.y,p.z)],"omberg_main_gutter")
        # Gutters on the eaves only; the verges have none.
        for edge,p,q in v.edges(True):
            if edge==3:
                continue
            n=outward(p,q)
            d=unit((q[0]-p[0],q[1]-p[1]))
            off=GUTTER_R+.015
            ex=[0,0]
            for i,e in enumerate([p,q]):          # run a little into the corner joint at the interface
                if abs(v.local(e)[0]-v.x0)>.01: ex[i]=.04
            pa=(p[0]+n[0]*off-d[0]*ex[0],p[1]+n[1]*off-d[1]*ex[0],EAVE-base-.09)
            pb=(q[0]+n[0]*off+d[0]*ex[1],q[1]+n[1]*off+d[1]*ex[1],EAVE-base-.09)
            runs=[(pa,pb)]
            if v is diag and edge==2:                 # no gutter across the bay
                ta=(pa[0]-X[0])*a[0]+(pa[1]-X[1])*a[1]
                tb=(pb[0]-X[0])*a[0]+(pb[1]-X[1])*a[1]
                lo,hi=BAY_XC-BAY_HALF-.05,BAY_XC+BAY_HALF+.05
                def at(t_):
                    f=(t_-ta)/(tb-ta)
                    return (pa[0]+(pb[0]-pa[0])*f,pa[1]+(pb[1]-pa[1])*f,pa[2])
                runs=[(pa,at(lo)),(at(hi),pb)]
            for r0,r1 in runs:
                g.pipe(r0,r1,GUTTER_R,"omberg_main_gutter",seg=8)
        # Downpipes at the free ends of the eave walls.
        for edge,p,q in v.edges(False):
            if edge not in [0,2]:
                continue
            n=outward(p,q)
            d=unit((q[0]-p[0],q[1]-p[1]))
            free,sgn=(p,1) if abs(v.local(p)[0]-(v.x0+OVER))<.01 else (q,-1)
            w=(free[0]+sgn*d[0]*.25,free[1]+sgn*d[1]*.25)
            reach=v.oy+GUTTER_R+.015
            downpipe(g,w,n,(w[0]+n[0]*reach,w[1]+n[1]*reach),base,origin)
    # One downpipe in the inner corner of the bend, where the valley drains.
    n1,n2=(-lat[0],-lat[1]),es
    bis=unit((n1[0]+n2[0],n1[1]+n2[1]))
    cw=(X[0]-lat[0]*(HALF_W-OVER),X[1]-lat[1]*(HALF_W-OVER))
    reach=(GUTTER_R+.015)/.96
    downpipe(g,cw,bis,(iw[0]+bis[0]*reach,iw[1]+bis[1]*reach),base,origin)
    # The bay: roof faces, fascia on its free edges, walls down to the porch roof (blank: no evidence of windows).
    for face in bay_faces:
        pts=[(*W2(*q),bay_z(q[0])) for q in face]
        uv=[(q[1],abs(q[0]-BAY_XC)) for q in face]
        g.poly(pts,"omberg_main_roof",uv=("uv",uv))
        g.poly([(x,y,z-THICK) for x,y,z in reversed(pts)],"omberg_main_reveal")
        for (q0,q1),(p0,p1) in zip(zip(face,face[1:]+face[:1]),zip(pts,pts[1:]+pts[:1])):
            near=lambda u,v:abs(u-v)<1e-6
            free=(near(q0[1],BAY_END) and near(q1[1],BAY_END)) or (
                (near(q0[0],BAY_XC-BAY_HALF) and near(q1[0],BAY_XC-BAY_HALF)) or
                (near(q0[0],BAY_XC+BAY_HALF) and near(q1[0],BAY_XC+BAY_HALF)))
            if free:
                g.poly([(p0[0],p0[1],p0[2]-THICK),(p1[0],p1[1],p1[2]-THICK),(p1[0],p1[1],p1[2]),p0],"omberg_main_gutter")
    xw=BAY_HALF-OVER                       # wall half width, wall end across
    ye,y0w=BAY_END-OVER,HALF_W-OVER
    zb=PORCH_TOP-base
    top=lambda x:bay_z(x)-THICK
    g.poly([(*W2(BAY_XC+xw,ye),zb),(*W2(BAY_XC-xw,ye),zb),(*W2(BAY_XC-xw,ye),top(BAY_XC-xw)),
            (*W2(BAY_XC,ye),top(BAY_XC)),(*W2(BAY_XC+xw,ye),top(BAY_XC+xw))],"omberg_main_grey")
    g.poly([(*W2(BAY_XC+xw,y0w),zb),(*W2(BAY_XC+xw,ye),zb),(*W2(BAY_XC+xw,ye),top(BAY_XC+xw)),(*W2(BAY_XC+xw,y0w),top(BAY_XC+xw))],"omberg_main_grey")
    g.poly([(*W2(BAY_XC-xw,ye),zb),(*W2(BAY_XC-xw,y0w),zb),(*W2(BAY_XC-xw,y0w),top(BAY_XC-xw)),(*W2(BAY_XC-xw,ye),top(BAY_XC-xw))],"omberg_main_grey")
    # The porch: a flat-roofed block against the NE wall, down to the basement.
    g.extrude(porch,105.2-base,PORCH_TOP-base,"omberg_main_grey",top="omberg_main_gutter",bottom=False)
    # Caps: one bent ridge cap, and a hip cap down the outside of the bend.
    r0,r1=diag.world(diag.x0,0),straight.world(straight.x0,0)
    z=RIDGE-base
    cap(g,[(r0[0],r0[1],z),(X[0],X[1],z),(r1[0],r1[1],z)],roof_z,"omberg_main_gutter",ext=(.04,.04))
    tip=.25/math.dist(X,ie)       # stop the hip cap short of the eave and run it out flat
    cap(g,[(X[0],X[1],z),(ie[0]+(X[0]-ie[0])*tip,ie[1]+(X[1]-ie[1])*tip,EAVE-base+(z-EAVE+base)*tip)],roof_z,"omberg_main_gutter",taper=True)
    return g
