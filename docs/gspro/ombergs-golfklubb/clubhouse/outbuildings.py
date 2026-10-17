"""Omberg lodges, southeast event hall and the small ancillary buildings.

Called from model.py; asset-local metres, z relative to each building's
ground median from survey.json. Placement goes through the add() callback.
"""
import math

from mathutils import Matrix, Vector
import props_kit as kit
from common import opening, roof_building, solar, ccw


def solid(name, rgb, smooth=.2, metal=0):
    kit.MATERIALS[name]=(None,(1,1),rgb,smooth,metal)


def register_materials():
    """Materials used only by the outbuildings."""
    # Green-brown sedum of the event hall (ortho: olive with red-brown patches).
    kit.MATERIALS["omberg_sedum"]=("foliage:88,85,81",(1.8,1.8),None,.08,0)
    # Cross-gable roof of the hall: dark brown-grey tile (ortho 2025 cal. 92,83,80), not the lodges' orange.
    kit.MATERIALS["omberg_tile_dark"]=("pantile:102,92,89",(2,2),None,.2,0)
    solid("omberg_roof_fascia",(112,56,47),.15)         # red-brown roof edge of the hall (DJI photo)
    solid("omberg_stair_grey",(166,167,162),.12)        # pale grey exterior stair (DJI photo)
    solid("omberg_fascia_dark",(62,62,60),.15)          # fascia of the metal annex roofs
    # Annex roofs: seamed sheet metal, rough and mid-tone. The shared silver roof reads white in the
    # course light (sun ~1.7x albedo); the ortho shows the padel annex nearly black, the central one
    # light grey.
    kit.MATERIALS["omberg_roof_charcoal"]=("seam:74,78,82:0.45:1.8:0",(1.8,1.8),None,.12,.1)
    # Lodge annex roofs (ortho cal.): the north lodge's is dark blue-grey, the east lodge's warm light grey.
    kit.MATERIALS["omberg_roof_annex_dark"]=("seam:52,58,71:0.45:1.8:0",(1.8,1.8),None,.12,.1)
    kit.MATERIALS["omberg_roof_annex_warm"]=("seam:124,114,109:0.45:1.8:0",(1.8,1.8),None,.12,.1)
    kit.MATERIALS["omberg_roof_greymetal"]=("seam:154,159,158:0.45:1.8:0",(1.8,1.8),None,.12,.1)


def outward(g, pts, mat, inside, uv=None):
    """Polygon wound counter-clockwise seen from outside: flips pts so the normal points away from `inside`."""
    p=[Vector(q) for q in pts]
    n=Vector((0,0,0))
    for a,b in zip(p,p[1:]+p[:1]):
        n+=Vector(((a.y-b.y)*(a.z+b.z),(a.z-b.z)*(a.x+b.x),(a.x-b.x)*(a.y+b.y)))
    c=sum(p,Vector((0,0,0)))/len(p)
    g.poly([tuple(q) for q in (p if n.dot(c-Vector(inside))>0 else p[::-1])],mat,uv)


def slab(g, top, thick, mat, under, edge, skip=()):
    """Roof plane from a planar convex polygon `top`: top face, underside and edge faces (edge i runs
    top[i] -> top[i+1]; `skip` lists edges that end inside another roof)."""
    p=[Vector(q) for q in top]
    n=(p[1]-p[0]).cross(p[2]-p[1]).normalized()
    if n.z<0:
        n=-n
    b=[q-n*thick for q in p]
    c=sum(p,Vector((0,0,0)))/len(p)-n*thick/2
    outward(g,p,mat,c-n)
    outward(g,b,under,c+n)
    for i in range(len(p)):
        if i not in skip:
            j=(i+1)%len(p)
            outward(g,[p[i],p[j],b[j],b[i]],edge,c)


def rail(g, pts, h=.95, mat="omberg_ivory_trim", step=1.3):
    """Handrail along the walking line pts [(x,y,z)...]: top and mid rail, posts at least every `step` m."""
    for a,b in zip(pts[:-1],pts[1:]):
        g.beam((a[0],a[1],a[2]+h),(b[0],b[1],b[2]+h),.07,.05,mat)
        g.beam((a[0],a[1],a[2]+h*.5),(b[0],b[1],b[2]+h*.5),.04,.04,mat)
        n=max(1,math.ceil(math.dist(a[:2],b[:2])/step))
        for i in range(n+1):
            t=i/n
            q=[a[k]+(b[k]-a[k])*t for k in range(3)]
            g.box((q[0],q[1],q[2]+(h-.14)/2),(.065,.065,h+.14),mat)    # foot sunk into the tread


def hall_deck(g, xc, W, zt):
    """First-floor terrace on the hall's north gable (lidar: a 3.3 m deck about 9.4 x 4.8 m with a 1.1 m
    railing, and the transverse gable above it) with the glass door at its back and a straight flight
    leaving the east end along the wall, descending to the ground. Posts and stringers carry everything."""
    m="omberg_stair_grey"
    ztop=zt-.03                          # deck surface, just under the door threshold
    y0,y1=W/2+.01,W/2+4.85               # deck back (against the wall) / front
    x0,x1=xc-4.6,xc+4.8
    n,run=19,.28
    rise=ztop/n
    fw=1.2
    ys0=y0+1.9                           # flight sits 1.9 m out from the wall
    ys1=ys0+fw
    g.box(((x0+x1)/2,(y0+y1)/2,ztop-.05),(x1-x0,y1-y0,.1),m)
    for x in [x0+.1]+[x0+i*(x1-x0)/6 for i in range(1,6)]+[x1-.1]:
        g.box((x,(y0+y1)/2,ztop-.2),(.1,y1-y0-.1,.2),m)                  # joists
    g.box(((x0+x1)/2,y1-.05,ztop-.22),(x1-x0,.1,.24),m)
    g.box((x0+.05,(y0+y1)/2,ztop-.22),(.1,y1-y0,.24),m)
    for ya,yb in ((y0,ys0),(ys1,y1)):
        g.box((x1-.05,(ya+yb)/2,ztop-.22),(.1,yb-ya,.24),m)
    for x in (x0+.12,xc,x1-.12):
        for y in (y0+.12,y1-.12):
            g.box((x,y,(ztop-.1)/2),(.14,.14,ztop-.1),m)
    # flight: closed risers, treads with a nosing, a stringer each side
    outward(g,[(x1,ys0,ztop-rise),(x1,ys1,ztop-rise),(x1,ys1,ztop-.1),(x1,ys0,ztop-.1)],m,(x1-1,ys0+.5,ztop-.2))
    for i in range(1,n):
        top=ztop-i*rise
        xa,xb=x1+(i-1)*run,x1+i*run
        g.box(((xa+xb)/2+.015,ys0+fw/2,top-.025),(run+.03,fw,.05),m)
        outward(g,[(xb,ys0,top-.05),(xb,ys1,top-.05),(xb,ys1,top-rise),(xb,ys0,top-rise)],m,(xb-1,ys0+.5,top-.1))
    xe=x1+(n-1)*run
    zlast=ztop-(n-1)*rise
    outward(g,[(xe,ys0,0),(xe,ys1,0),(xe,ys1,zlast-.05),(xe,ys0,zlast-.05)],m,(xe-1,ys0+.5,.1))
    for y in (ys0-.03,ys1+.03):                                  # stringers outside the treads
        g.beam((x1,y,ztop-.13),(xe+.1,y,zlast-.13+.1*rise/run),.06,.28,m)
        for i in (6,12,18):                                      # posts under the stringers
            zz=ztop-i*rise-.26
            if zz>.15:
                g.box((x1+i*run-.1,y,zz/2),(.12,.12,zz),m)
    # railings (lidar: ~1.1 m): terrace front and west end, east end either side of the flight, both flight sides
    rail(g,[(x1-.04,ys1+.03,ztop),(x1-.04,y1-.04,ztop),(x0+.04,y1-.04,ztop),(x0+.04,y0+.04,ztop)],h=1.1)
    rail(g,[(x1-.04,y0+.04,ztop),(x1-.04,ys0-.03,ztop)],h=1.1)
    rail(g,[(x1,ys0-.03,ztop),(xe,ys0-.03,zlast)],step=1.2)
    rail(g,[(x1,ys1+.03,ztop),(xe,ys1+.03,zlast)],step=1.2)


def cross_gable(g, xc, W, ea, ri, door=None):
    """The hall's transverse cross gable (ortho: valleys meeting about 1.4 m south of the ridge line; lidar:
    a horizontal ridge at 9.75 m over the middle, same pitch as the main roof, no wall projection).
    Its end wall is flush with the long wall (burgundy triangle above the eave) on both long sides and the
    terracotta planes end in real valleys on the main slope. Hall-local, ground z = 0."""
    hw=7.2                               # half span at the eave line
    RG=9.75
    thick,oe,gov=.12,.3,.36              # slab thickness, eave overhang, barge overhang (> main eave .3)
    ovm=.3
    sm=(ri-ea)/(W/2)
    sg=(RG-ea)/hw
    dv=thick*math.sqrt(1+sg*sg)
    uv=(RG-ea)/sm                        # inward distance of the ridge's end on the main slope
    zg=lambda dx: RG-sg*abs(dx)
    for s in (-1,1):
        Y=lambda u: s*(W/2-u)            # u = distance inward from the wall plane
        # burgundy gable triangle in the wall plane, base on the wall top the kit stops at (roof thick/2)
        outward(g,[(xc-hw,Y(0),ea-.08),(xc+hw,Y(0),ea-.08),(xc,Y(0),RG-.07)],"omberg_red",(xc,Y(3),ea))
        for sx in (-1,1):
            ub=-oe*sg/sm                 # where the eave edge meets the extended main plane
            pts=[(xc+sx*(hw+oe),Y(-gov),zg(hw+oe)),(xc,Y(-gov),RG),(xc,Y(uv),RG),(xc+sx*(hw+oe),Y(ub),zg(hw+oe))]
            slab(g,pts,thick,"omberg_tile_dark","omberg_ivory_trim","omberg_ivory_trim",skip=(1,2))
        g.box((xc,(Y(-gov)+Y(uv))/2,RG+.03),(.2,uv+gov,.1),"omberg_tile_dark")
    foot=[(-60,-W/2),(60,W/2)]
    # first-floor terrace door and a ground-floor door under the terrace, on the north wall
    kit.opening(g,opening("+y",xc,1.9,2.15,door,kind="glassdoor",frame="omberg_sage"),foot,None,"omberg_sage")
    kit.opening(g,opening("+y",xc+3.1,1.1,2.2,.22,kind="door",frame="omberg_sage",mat="omberg_sage"),foot,None,"omberg_sage")
    hall_deck(g,xc,W,door)


def hall(g, L, W, ea, ri, ground):
    """The pale event hall (OSM 1431566994): cream-grey boards, burgundy gables, sage glazing, sedum roof
    with two solar arrays on the south slope and a terracotta cross gable in the middle (ortho 2025 + lidar:
    arrays x -24..-9 and 8..24, y -7.8..-1.3; cross gable centred at x 0.3), a terrace on the north side."""
    xg=.3                                # centre of the cross gable
    ops=[]
    for side in ("-y","+y"):
        for i in range(12):
            x=-L/2+(i+.5)*L/12
            if not (side=="+y" and abs(x-xg)<4.4):   # ground bays under the terrace: its beams stand there
                ops.append(opening(side,x,1.7,2.4,.4,frame="omberg_sage",bars=[2,2]))
            # small upper-floor windows above every ground bay (photo: row of smaller rectangular openings)
            ops.append(opening(side,x,.95,1.25,4.2,bars=[2,2]))
    for sx in (-1,1):
        s="+x" if sx>0 else "-x"
        ops.append(opening(s,0,4.8,4.7,.22,kind="glassdoor",frame="omberg_sage",bars=[4,4]))
        for y in (-W*.36,W*.36):
            ops.append(opening(s,y,1.0,2.55,.25,frame="omberg_sage",bars=[1,3]))
        ops.append(opening(s,0,1.7,1.15,ea+.6,bars=[3,1]))
    kit.building(g,dict(length=L,width=W,wall="omberg_pale_grey",trim="omberg_ivory_trim",
        roof=dict(type="gable",eave=ea,ridge=ri,mat="omberg_sedum",overhang=.3,gableOverhang=.25,thick=.16,
                  edge="omberg_roof_fascia",under="omberg_ivory_trim",gutters=False,ridgeCap=False),
        cladding={},cornerBoard=.14,openings=ops,plinth=dict(h=.22,mat="concrete"),sink=.9))
    # Gable end walls: boards up to the eave, burgundy triangle above. Splitting the wall polygon keeps
    # the triangle in the wall plane (no proud overlay to fight the barge boards).
    faces=[]
    for idx,mat,uv in g.faces:
        v=[g.verts[i] for i in idx]
        if mat=="omberg_pale_grey" and len(idx)==5 and all(abs(abs(q.x)-L/2)<1e-4 for q in v):
            faces.append(([idx[0],idx[1],idx[2],idx[4]],mat,uv))
            faces.append(([idx[2],idx[3],idx[4]],"omberg_red",uv))
        else:
            faces.append((idx,mat,uv))
    g.faces=faces
    cross_gable(g,xg,W,ea,ri,3.25)
    # Solar on the south (-y) slope: the two arrays of the ortho, clear of the cross gable's valleys.
    zf=lambda y: ri-(ri-ea)*abs(y)/(W/2)
    solar(g,-L/2+1.1,-9.3,-W/2+.7,-1.4,zf,rows=4)
    solar(g,8.4,L/2-1.0,-W/2+.7,-1.4,zf,rows=4)


def lodging(g, length, width, eave, ridge, bays=7, solar_sides=(), porch_side="-y", levels=2,
            porch=None, annex_ends=()):
    """Two-storey red lodging block. `porch` = dict(x, w, eave, ridge) of the entrance porch (wall width w,
    centred at x): windows that would collide with its walls or its roof are left out. `annex_ends` lists the
    gable ends ("-x"/"+x") that carry a low annex, whose 3 m roof covers the ground-floor end windows."""
    openings=[]
    px,pw=(porch["x"],porch["w"]) if porch else (0,0)
    xs=[-length/2+(i+.5)*length/bays for i in range(bays)]
    for side in ["-y","+y"]:
        for x in xs:
            for floor in range(levels):
                if porch and side==porch_side:
                    dx=abs(x-px)
                    if floor==0 and dx<pw/2+.6+.2:
                        continue         # porch walls stand in front of these
                    if floor==1:         # porch roof top at the window's nearest edge vs the sill board (3.5 m)
                        dn=max(0,dx-.75)
                        zr=porch["ridge"]-(porch["ridge"]-porch["eave"])*min(dn,pw/2+.46)/(pw/2+.46)
                        if zr+.17>3.45:
                            continue
                openings.append(opening(side,x,w=1.15,h=1.3,sill=.85+floor*2.8))
    for side in ["-x","+x"]:
        for y in [-width*.24,width*.24]:
            for floor in range(levels):
                if floor==0 and side in annex_ends:
                    continue
                openings.append(opening(side,y,w=1.2,h=1.3,sill=.85+floor*2.8))
        # louvred attic vent in the gable peak, between the ridge cap and the upper windows
        openings.append(opening(side,0,w=.7,h=.7,sill=ridge-1.9,kind="vent",frame="omberg_ivory_trim"))
    roof_building(g,length,width,eave,ridge,openings=openings)
    # Lodging entrance with glazing, not a vehicle-sized opening.
    kit.opening(g,opening(porch_side,px,w=1.6,h=2.2,sill=.22,kind="glassdoor"),
                [(-length/2,-width/2),(length/2,width/2)],None,"omberg_ivory_trim")
    for side in solar_sides:
        sgn=-1 if side=="-y" else 1
        solar(g,-length*.43,length*.43,sgn*.6,sgn*(width/2-.55),
              lambda y: ridge-(ridge-eave)*abs(y)/(width/2),rows=3)
    # Quiet facade band between the floors, interrupted by the porch (its roof meets the wall there).
    if levels>1:
        for sgn in [-1,1]:
            side="-y" if sgn<0 else "+y"
            segs=[(-length/2,length/2)]
            if porch and side==porch_side:
                segs=[(-length/2,px-pw/2-.3),(px+pw/2+.3,length/2)]
            for a,b in segs:
                g.box(((a+b)/2,sgn*(width/2+.045),3.1),(b-a,.08,.13),"omberg_ivory_trim")


def battens(g, L, W, base, roof, openings, mat="omberg_red", spacing=.64, w=.05, depth=.025):
    """Vertical battens over the boards (as on the lodges) but with three faces each and a wide spacing:
    the boards themselves are in the texture, the battens only add shadow lines. Kept clear of openings."""
    fp=[(-L/2,-W/2),(L/2,-W/2),(L/2,W/2),(-L/2,W/2)]
    for a,b in zip(fp,fp[1:]+fp[:1]):
        Lw,ux,uy,nx,ny=kit._edge_frame(a,b)
        ops=kit._edge_openings(a,b,openings,fp)
        rz=math.degrees(math.atan2(uy,ux))
        n=max(1,int(round(Lw/spacing)))
        for i in range(1,n):
            t=i*Lw/n
            if t<.2 or t>Lw-.2:
                continue
            zt=roof.z(a[1]+uy*t)-.14
            segs=[(base,zt)]
            for t0,t1,s0,s1 in ops:
                if t0-w/2<t<t1+w/2:
                    segs=kit._cut(segs,s0,s1)
            for za,zb in segs:
                if zb-za>.1:
                    g.box((a[0]+ux*t+nx*depth/2,a[1]+uy*t+ny*depth/2,(za+zb)/2),(w,depth,zb-za),mat,rz=rz,
                          skip=("+y","bottom"))


def annex(g, L, W, ea, rise, roof_mat, doors, windows, vents=()):
    """Small utility building with a low mono-pitch seamed-metal roof (low edge at -y), dark fascia,
    gutter on the low edge, Falu-red board-and-batten walls with corner boards and roof vents."""
    spec=dict(length=L,width=W,wall="omberg_red",trim="omberg_ivory_trim",cornerBoard=.14,
        roof=dict(type="mono",low=ea,high=ea+rise,mat=roof_mat,overhang=.3,gableOverhang=.25,thick=.12,
                  edge="omberg_fascia_dark",under="omberg_fascia_dark",gutters=True,gutterMat="galvanised"),
        cladding={},openings=windows+doors,plinth=dict(h=.2,mat="concrete"),sink=.8)
    roof=kit.building(g,spec)
    battens(g,L,W,.2,roof,windows+doors)
    # Flashing cap on the high edge, where the roof ends against the sky.
    zh=ea+rise*(W/2+.2)/W+rise/2
    g.box((0,W/2+.2,zh+.04),(L+.4,.18,.08),"omberg_fascia_dark")
    for x,y in vents:                    # ventilation stacks with a cap
        z=roof.z(y)+.12
        g.cylinder((x,y,z-.1),.06,.62,"galvanised",seg=8)
        g.cylinder((x,y,z+.5),.11,.04,"galvanised",seg=8)


def build(byid, add, new):
    # Fitted to the class-1 lidar points (ridge level, slope 0.40 on both sides, roof edges) in the frame of
    # the old OSM-based rectangle: the real roofs are 14.3-14.7 m edge to edge and sit off that rectangle by
    # (dx, dy) m along/across the axis. porch = lidar roof of the entrance wing: centre x, wall width w,
    # ridge/eave heights above ground and depth d beyond the main wall.
    lodges=[dict(fid="687779185",aid="omberg_north_lodge",e=477790.75,n=6457763.78,yaw=84.3,dx=.69,dy=1.10,
                 L=25.55,W=13.53,ridge=114.08,pitch=.403,bays=6,side="-y",solar=["-y"],
                 porch=dict(x=1.8-.69,w=5.5,eave=2.9,ridge=3.5,d=6.0),annex=[("-x",5.0,-5.6,5.6,"omberg_roof_annex_dark")]),
            dict(fid="687779186",aid="omberg_west_lodge",e=477780.1,n=6457724.03,yaw=148.4,dx=-1.89,dy=-.95,
                 L=23.6,W=14.02,ridge=114.78,pitch=.397,bays=6,side="+y",solar=[],
                 porch=dict(x=-3.8+1.89,w=6.1,eave=2.9,ridge=4.1,d=6.2),annex=[]),
            dict(fid="687779187",aid="omberg_east_lodge",e=477871.12,n=6457745.55,yaw=174.4,dx=-.1,dy=-.6,
                 L=35.8,W=13.35,ridge=116.79,pitch=.395,bays=9,side="-y",solar=["+y","-y"],
                 porch=dict(x=-.25,w=5.3,eave=2.9,ridge=3.65,d=3.5),
                 canopy=(5.6,9.3,2.1,2.75,3.25),
                 annex=[("-x",5.45,-5.65,5.85,"omberg_roof_annex_warm"),("+x",4.6,-5.65,5.85,"omberg_roof_annex_warm")])]
    for c in lodges:
        row=byid[c["fid"]]
        ground=row["groundMedianAbsM"]
        L,W=c["L"],c["W"]
        ri=c["ridge"]-ground
        ea=ri-c["pitch"]*W/2
        g=new()
        po=c["porch"]
        sgn=1 if c["side"]=="+y" else -1
        lodging(g,L,W,ea,ri,bays=c["bays"],solar_sides=c["solar"],porch_side=c["side"],porch=po,
                annex_ends=[a[0] for a in c["annex"]])
        # Entrance wing on the main wall; it reaches 0.9 m into the lodge so no gap is left.
        d=po["d"]
        roof_building(g,d+.9,po["w"],po["eave"],po["ridge"],at=(po["x"],sgn*(W/2+(d-.9)/2),0),rot=90,
                      openings=[opening("+x" if sgn>0 else "-x",0,1.5,2.25,.22,kind="glassdoor")])
        # Low flat-roofed annexes at the gable ends (lidar: 2.9-3.0 m flat roofs, 5 m deep, ~11 m long; the
        # ortho shows grey roofs there).
        for end,depth,y0,y1,mat in c["annex"]:
            sx=-1 if end=="-x" else 1
            g.push(Matrix.Translation((sx*(L/2+depth/2),(y0+y1)/2,0)))
            annex(g,depth,y1-y0,2.92,.08,mat,[],[])
            g.pop()
        if "canopy" in c:                # lean-to canopy on the wall beside the porch (lidar: 2.8-3.2 m, 3.7 x 2 m)
            x0,x1,dep,zl,zh=c["canopy"]
            yw=sgn*(W/2)
            ys=sgn
            top=[(x0,yw,zh),(x1,yw,zh),(x1,yw+ys*dep,zl),(x0,yw+ys*dep,zl)]
            slab(g,top,.1,"omberg_roof_annex_warm","omberg_fascia_dark","omberg_fascia_dark")
            for x in (x0+.1,x1-.1):
                g.box((x,yw+ys*(dep-.1),(zl-.1)/2),(.12,.12,zl-.1),"omberg_ivory_trim")
        dxy=(c["dx"]*math.sin(math.radians(c["yaw"]))+c["dy"]*-math.cos(math.radians(c["yaw"])),
             c["dx"]*math.cos(math.radians(c["yaw"]))+c["dy"]*math.sin(math.radians(c["yaw"])))
        add(c["aid"],g,c["e"]+dxy[0],c["n"]+dxy[1],c["yaw"],ground)

    row=byid["1431566994"]
    r=row["rect"]
    g=new()
    ground=row["groundMedianAbsM"]
    L,W=r["lengthM"],r["widthM"]
    hall(g,L,W,117.5-ground,121.03-ground,ground)
    add("omberg_southeast_lodge",g,r["cx"],r["cy"],row["axisBearingFromNorthDeg"],ground)

    # Low central utility / covered seating buildings, plus the small terracotta outbuilding and the
    # flat eastern padel-side ancillary (ortho: padel annex dark grey, central annex pale grey standing seam,
    # shelter solar-covered; the roofs overhang the OSM walls by 0.3-0.5 m).
    for fid,aid in [("687779189","omberg_padel_annex"),("687779190","omberg_south_pavilion"),
                    ("687779191","omberg_central_annex"),("1431573558","omberg_solar_shelter")]:
        row=byid[fid]
        r=row["rect"]
        ground=row["groundMedianAbsM"]
        g=new()
        if fid=="687779190":
            roof_building(g,r["lengthM"],r["widthM"],114.6-ground,116.05-ground,
                          openings=[opening("-y",-2.3),opening("-y",2.3),opening("+y",-2.3),opening("+y",2.3),
                                    opening("+x",0,1.25,2.2,.22,kind="glassdoor"),
                                    opening("-x",0,.6,.6,114.6-ground+.5,kind="vent"),
                                    opening("+x",0,.6,.6,114.6-ground+.5,kind="vent")])
        else:
            L,W=r["lengthM"],r["widthM"]
            # lidar: the padel and central roofs are flat to 4 cm (plane fit), the shelter falls 0.1 m/m to -y
            # (2.57 m low edge, 0.5 m rise). Flat ones get a 0.1 m fall, centred on the measured height.
            med=row["roofAbsoluteQuantilesP05P20P50P95P99"][2]-ground
            ea,rise=(2.57,.5) if fid=="1431573558" else (med-.05,.1)
            low=fid=="1431573558"            # the shelter's wall is only 2.5 m: smaller openings
            win=[opening("-y",x,1.5,1.2 if low else 1.4,.8) for x in [-L*.3,0,L*.3]]
            door=[opening("-y",L*.4,1.0,1.95 if low else 2.1,.2,kind="door",mat="omberg_sage",frame="omberg_ivory_trim")]
            vents=[] if fid=="1431573558" else [(-L*.18,W*.12),(L*.22,W*.12)]
            annex(g,L,W,ea,rise,"omberg_roof_charcoal" if fid=="687779189" else "omberg_roof_greymetal",door,win,vents)
            if fid=="1431573558":
                solar(g,-L/2+.25,L/2-.25,-W/2+.15,W/2-.15,
                      lambda y:ea+.10+rise*(y+W/2)/W,rows=2)
        add(aid,g,r["cx"],r["cy"],row["axisBearingFromNorthDeg"],ground)
