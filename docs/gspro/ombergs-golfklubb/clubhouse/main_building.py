"""Photo-led main building with a continuous kinked shell and recessed glazing.

Geometry is asset-local EN, z relative to the placement base. Measured roof
centres and heights come from survey.json; facade bay types come from the user's
course-side photograph. Unseen elevations use restrained inferred windows.
"""
import math

from mathutils import Matrix, Vector
from mathutils.geometry import tessellate_polygon
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
    rgb=np.array([132,141,140])[None,None,:]/255*tone[:,:,None]
    height=np.broadcast_to(np.where(edge,.60,.50),(S,S)).copy()
    return rgb,height,.6


def ccw(p):
    area=sum(a[0]*b[1]-b[0]*a[1] for a,b in zip(p,p[1:]+p[:1]))
    return p if area>0 else list(reversed(p))


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


def inside(p,poly):
    return all((b[0]-a[0])*(p[1]-a[1])-(b[1]-a[1])*(p[0]-a[0])>1e-6
               for a,b in zip(poly,poly[1:]+poly[:1]))


def intersection_t(a,b,c,d):
    ab=(b[0]-a[0],b[1]-a[1])
    cd=(d[0]-c[0],d[1]-c[1])
    den=ab[0]*cd[1]-ab[1]*cd[0]
    if abs(den)<1e-9:
        return None
    ac=(c[0]-a[0],c[1]-a[1])
    t=(ac[0]*cd[1]-ac[1]*cd[0])/den
    u=(ac[0]*ab[1]-ac[1]*ab[0])/den
    return t if 0<t<1 and -1e-8<=u<=1+1e-8 else None


class Volume:
    def __init__(self,centre,length,width,yaw,base,course_side):
        self.c=centre
        self.L,self.W=length,width
        self.angle=math.radians(90-yaw)
        self.cos,self.sin=math.cos(self.angle),math.sin(self.angle)
        self.base=base
        self.course_side=course_side
        self.roof=self.rectangle(length,width)
        self.wall=self.rectangle(length-.65,width-.65)

    def world(self,x,y):
        return (self.c[0]+self.cos*x-self.sin*y,self.c[1]+self.sin*x+self.cos*y)

    def local(self,p):
        dx,dy=p[0]-self.c[0],p[1]-self.c[1]
        return (dx*self.cos+dy*self.sin,-dx*self.sin+dy*self.cos)

    def rectangle(self,L,W):
        return [self.world(x,y) for x,y in [(-L/2,-W/2),(L/2,-W/2),(L/2,W/2),(-L/2,W/2)]]

    def height(self,p):
        y=self.local(p)[1]
        return 121-self.base-(121-118.2)*abs(y)/(self.W/2)

    def roof_faces(self):
        for sign in [-1,1]:
            poly=[self.world(x,y) for x,y in [(-self.L/2,sign*self.W/2),(self.L/2,sign*self.W/2),
                                             (self.L/2,0),(-self.L/2,0)]]
            poly=ccw(poly)
            def z(p,side=sign):
                return 121-self.base-(121-118.2)*self.local(p)[1]*side/(self.W/2)
            yield poly,z

    def exposed_edges(self,others,roof=False):
        own=self.roof if roof else self.wall
        for edge,(a,b) in enumerate(zip(own,own[1:]+own[:1])):
            cuts=[0.,1.]
            for other in others:
                poly=other.roof if roof else other.wall
                for c,d in zip(poly,poly[1:]+poly[:1]):
                    t=intersection_t(a,b,c,d)
                    if t is not None:
                        cuts.append(t)
            cuts=sorted(set(round(t,8) for t in cuts))
            for lo,hi in zip(cuts[:-1],cuts[1:]):
                mid=(lo+hi)/2
                p=(a[0]+(b[0]-a[0])*mid,a[1]+(b[1]-a[1])*mid)
                if any(inside(p,o.roof if roof else o.wall) for o in others):
                    continue
                p0=(a[0]+(b[0]-a[0])*lo,a[1]+(b[1]-a[1])*lo)
                p1=(a[0]+(b[0]-a[0])*hi,a[1]+(b[1]-a[1])*hi)
                if math.dist(p0,p1)>.02:
                    yield edge,p0,p1


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


def facade(g,volume,edge,a,b,openings):
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
            os.append((t,z,w,h,cols,rows))
    xs=sorted(set([0.,length]+[v for t,z,w,h,c,r in os for v in [t-w/2,t+w/2]]))
    zs=sorted(set([bottom,band,121-volume.base]+[v for t,z,w,h,c,r in os for v in [z,z+h]]))
    def top(t):
        return volume.height((a[0]+ux*t,a[1]+uy*t))-.16
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
            if not any(abs(t-ot)<w/2+.1 for ot,z,w,h,c,r in os):
                g.box((t,(band+top(t))/2,.001),(.014,top(t)-band,.0015),"omberg_main_panel_joint")
    g.pop()


def window_layout(volume,edge,diagonal,segment=None):
    L,W=volume.L-.65,volume.W-.65
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


def clipped_line(a,b,poly):
    lo,hi=0.,1.
    for c,d in zip(poly,poly[1:]+poly[:1]):
        def side(p):
            return (d[0]-c[0])*(p[1]-c[1])-(d[1]-c[1])*(p[0]-c[0])
        va,vb=side(a),side(b)
        if va<0 and vb<0:
            return None
        if (va<0)!=(vb<0):
            t=va/(va-vb)
            if va<0: lo=max(lo,t)
            else: hi=min(hi,t)
        if lo>=hi:
            return None
    return ((a[0]+(b[0]-a[0])*lo,a[1]+(b[1]-a[1])*lo),
            (a[0]+(b[0]-a[0])*hi,a[1]+(b[1]-a[1])*hi))


def build(sections,origin,base):
    g=kit.Geo()
    volumes=[]
    for key,L,W,yaw,side in [("white-diagonal-link",24.3,14.6,149.5,0),("white-straight-link",16.1,12.7,0,2)]:
        pts=sections[key]["roofEdge3006"]
        centre=(sum(p[0] for p in pts)/4-origin[0],sum(p[1] for p in pts)/4-origin[1])
        volumes.append(Volume(centre,L,W,yaw,base,side))
    for index,v in enumerate(volumes):
        others=[o for o in volumes if o is not v]
        for edge,a,b in v.exposed_edges(others):
            facade(g,v,edge,a,b,window_layout(v,edge,index==0,(a,b)))
        for poly,z in v.roof_faces():
            pieces=[poly]
            for other in others:
                for cutter,oz in other.roof_faces():
                    cutter=clip_scalar(cutter,lambda p:oz(p)-z(p)-.00001)
                    if len(cutter)<3:
                        continue
                    pieces=[q for piece in pieces for q in subtract_convex(piece,cutter)]
            for piece in pieces:
                pts=[Vector((x,y,z((x,y)))) for x,y in piece]
                for tri in tessellate_polygon([pts]):
                    tri=[pts[t] if isinstance(t,int) else t for t in tri]
                    uv=[(v.local((p.x,p.y))[0]+v.L/2,abs(v.local((p.x,p.y))[1])) for p in tri]
                    g.poly([tuple(p) for p in tri],"omberg_main_roof",uv=("uv",uv))
                    g.poly([(p.x,p.y,p.z-.12) for p in reversed(tri)],"omberg_main_reveal")
                # Standing seams are in the phase-aligned albedo/normal only.
                # Millimetre-scale physical strips alias in Unity's course views.
        r0,r1=v.world(-v.L/2+.04,0),v.world(v.L/2-.04,0)
        g.beam((r0[0],r0[1],121-base+.015),(r1[0],r1[1],121-base+.015),.14,.05,"omberg_main_gutter")
        for edge,a,b in v.exposed_edges(others,roof=True):
            za,zb=v.height(a),v.height(b)
            # Split cross-gables at their ridge so fascia follows both slopes.
            cuts=[a,b]
            la,lb=v.local(a),v.local(b)
            if la[1]*lb[1]<0:
                f=-la[1]/(lb[1]-la[1])
                cuts=[a,(a[0]+(b[0]-a[0])*f,a[1]+(b[1]-a[1])*f),b]
            for aa,bb in zip(cuts[:-1],cuts[1:]):
                az,bz=v.height(aa),v.height(bb)
                g.poly([(aa[0],aa[1],az-.14),(bb[0],bb[1],bz-.14),(bb[0],bb[1],bz),(aa[0],aa[1],az)],"omberg_main_gutter")
            if edge in [0,2]:
                g.pipe((a[0],a[1],za-.13),(b[0],b[1],zb-.13),.055,"omberg_main_gutter",seg=8)
        # Small round downpipes at exposed long-wall ends; no invented ornaments.
        for edge,a,b in v.exposed_edges(others):
            if edge not in [0,2] or math.dist(a,b)<4:
                continue
            ux,uy=(b[0]-a[0])/math.dist(a,b),(b[1]-a[1])/math.dist(a,b)
            for p,sgn in [(a,1),(b,-1)]:
                x=p[0]+sgn*ux*.22+uy*.075
                y=p[1]+sgn*uy*.22-ux*.075
                z=v.height((x,y))-.22
                g.pipe((x,y,z),(x,y,106.1-base),.045,"omberg_main_gutter",seg=8)
    return g
