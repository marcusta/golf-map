"""Omberg lodges, southeast event hall and the small ancillary buildings.

Called from model.py; asset-local metres, z relative to each building's
ground median from survey.json. Placement goes through the add() callback.
"""
import math

from mathutils import Matrix
import props_kit as kit
from common import opening, roof_building, solar, ccw


def register_materials():
    """Materials used only by the outbuildings (none of their own yet)."""



def flat_roof(g, length, width, eave, ridge, sedum=False):
    """Low ridge/sedum roof over rectangular modern annex."""
    L,W=length,width
    kit.building(g,dict(length=L,width=W,wall="omberg_dark_brown",trim="omberg_dark_brown",
        roof=dict(type="gable",eave=eave,ridge=ridge,mat="roof_felt_brown",overhang=.2,
                  gableOverhang=.2,thick=.16,edge="omberg_dark_brown",under="omberg_dark_brown",
                  gutters=False,ridgeCap=False),cladding={},cornerBoards=False,
        plinth=dict(h=.25,mat="concrete"),sink=.9))
    if sedum:
        mat="omberg_sedum"
        kit.MATERIALS[mat]=("foliage:91,93,65",(1.8,1.8),None,.08,0)
        for sign in [-1,1]:
            g.poly([(-L/2-.1,sign*W/2,eave+.05),(L/2+.1,sign*W/2,eave+.05),
                    (L/2+.1,0,ridge+.05),(-L/2-.1,0,ridge+.05)][::-sign],mat)


def lodging(g, length, width, eave, ridge, bays=7, solar_sides=(), porch_side="-y", levels=2):
    openings=[]
    xs=[-length/2+(i+.5)*length/bays for i in range(bays)]
    for side in ["-y","+y"]:
        for x in xs:
            for floor in range(levels):
                openings.append(opening(side,x,w=1.15,h=1.3,sill=.85+floor*2.8))
    for side in ["-x","+x"]:
        for y in [-width*.24,width*.24]:
            for floor in range(levels):
                openings.append(opening(side,y,w=1.2,h=1.3,sill=.85+floor*2.8))
    roof_building(g,length,width,eave,ridge,openings=openings)
    # Lodging entrance with glazing, not a vehicle-sized opening.
    kit.opening(g,opening(porch_side,0,w=1.6,h=2.2,sill=.2,kind="glassdoor"),
                [(-length/2,-width/2),(length/2,width/2)],None,"omberg_ivory_trim")
    for side in solar_sides:
        sgn=-1 if side=="-y" else 1
        solar(g,-length*.43,length*.43,sgn*.45,sgn*(width/2-.5),
              lambda y: ridge-(ridge-eave)*abs(y)/(width/2),rows=3)
    # Quiet facade band and sill-course at the upper floor.
    if levels>1:
        for sgn in [-1,1]:
            g.box((0,sgn*(width/2+.045),3.1),(length,.08,.13),"omberg_ivory_trim")



def build(byid, add, new):
    lodges=[("687779185","omberg_north_lodge",477790.75,6457763.78,84.3,25.4,12.63,111.5,114.11,6,"-y"),
            ("687779186","omberg_west_lodge",477780.1,6457724.03,148.4,24.64,13.25,112.0,114.79,6,"+y"),
            ("687779187","omberg_east_lodge",477871.12,6457745.55,174.4,35.93,12.9,113.4,116.88,9,"-y")]
    for fid,aid,e,n,yaw,L,W,ea,ri,bays,porch in lodges:
        row=byid[fid]
        ground=row["groundMedianAbsM"]
        g=new()
        lodging(g,L,W,ea-ground,ri-ground,bays=bays,
                solar_sides=["-y"] if fid=="687779185" else ["+y","-y"] if fid=="687779187" else [],porch_side=porch)
        # Small cross-gabled entrance on the OSM protrusion.
        sgn=1 if porch=="+y" else -1
        roof_building(g,5.6,4.7,3.25,4.2,at=(0,sgn*(W/2+1.9),0),rot=90,
                      openings=[opening("+x" if sgn>0 else "-x",0,1.5,2.25,.15,kind="glassdoor")])
        add(aid,g,e,n,yaw,ground)

    row=byid["1431566994"]
    r=row["rect"]
    g=new()
    ground=row["groundMedianAbsM"]
    L,W=r["lengthM"],r["widthM"]
    ea,ri=117.5-ground,121.03-ground
    flat_roof(g,L,W,ea,ri,sedum=True)
    # Official 2025 DJI photo identifies this as the pale event hall: cream-grey
    # board walls, burgundy gables and sage-green full-height ground glazing.
    g.faces=[(f,"omberg_pale_grey" if m=="omberg_dark_brown" else m,uv) for f,m,uv in g.faces]
    for side in ["-y","+y"]:
        sgn=-1 if side=="-y" else 1
        for i in range(12):
            x=-L/2+(i+.5)*L/12
            kit.opening(g,opening(side,x,1.7,2.4,.4,frame="omberg_sage",bars=[2,2],plane=sgn*(W/2+.025)),
                        [(-L/2,-W/2),(L/2,W/2)],None,"omberg_sage")
            g.box((x,sgn*(W/2+.06),5.25),(.82,.08,1.25),"omberg_ivory_trim")
    for signx in [-1,1]:
        x=signx*(L/2+.03)
        g.poly([(x,-W/2,ea-.03),(x,W/2,ea-.03),(x,0,ri-.08)][::signx],"omberg_red")
        kit.opening(g,opening("+x" if signx>0 else "-x",0,4.8,4.7,.2,
                             kind="glassdoor",frame="omberg_sage",bars=[4,4],plane=x),
                    [(-L/2,-W/2),(L/2,W/2)],None,"omberg_sage")
        for y in [-W*.36,W*.36]:
            kit.opening(g,opening("+x" if signx>0 else "-x",y,1.0,2.55,.25,
                                 frame="omberg_sage",bars=[1,3],plane=x),
                        [(-L/2,-W/2),(L/2,W/2)],None,"omberg_sage")
        kit.opening(g,opening("+x" if signx>0 else "-x",0,1.7,1.15,ea+.6,
                             frame="omberg_ivory_trim",bars=[3,1],plane=x+.02*signx),
                    [(-L/2,-W/2),(L/2,W/2)],None,"omberg_sage")
    # Transverse projecting stair gable; the main rectangle stays as measured.
    g.push(Matrix.Translation((-7.8,-W/2+.8,0)) @ Matrix.Rotation(math.pi/2,4,"Z"))
    roof_building(g,4.2,7.3,ea,ri,wall="omberg_pale_grey",roof="omberg_terracotta",cladding={},
                  openings=[opening("-x",0,1.9,2.15,3.25,kind="glassdoor",frame="omberg_sage")])
    g.poly([(-2.13,-3.65,ea),(-2.13,3.65,ea),(-2.13,0,ri)][::-1],"omberg_red")
    # Exterior stair and landing to the first-floor door.
    for i in range(19):
        g.box((-2.5-i*.25,0,.14+i*.17),(.28,1.25,.18),"omberg_ivory_trim")
    kit.railing(g,[(-2.5,0.7,.2),(-7.25,.7,3.25)],h=.95,mat="omberg_ivory_trim",post=.9)
    g.pop()
    solar(g,-r["lengthM"]*.45,r["lengthM"]*.45,-r["widthM"]/2+.6,-.5,
          lambda y:121.03-ground-(121.03-117.5)*abs(y)/(r["widthM"]/2),rows=3)
    add("omberg_southeast_lodge",g,r["cx"],r["cy"],row["axisBearingFromNorthDeg"],ground)

    # White, low central utility / covered seating buildings, plus the small
    # terracotta outbuilding and the flat eastern padel-side ancillary.
    for fid,aid in [("687779189","omberg_padel_annex"),("687779190","omberg_south_pavilion"),
                    ("687779191","omberg_central_annex"),("1431573558","omberg_solar_shelter")]:
        row=byid[fid]
        r=row["rect"]
        ground=row["groundMedianAbsM"]
        g=new()
        if fid=="687779190":
            roof_building(g,r["lengthM"],r["widthM"],114.6-ground,116.05-ground,
                          openings=[opening("-y",-2.3),opening("-y",2.3),opening("+x",0,1.25,2.2,.15,kind="glassdoor")])
        else:
            ea=row["roofAbsoluteQuantilesP05P20P50P95P99"][1]-ground
            kit.building(g,dict(length=r["lengthM"],width=r["widthM"],wall="omberg_red",trim="omberg_ivory_trim",
                roof=dict(type="mono",low=ea,high=ea+.15,mat="omberg_silver_roof",overhang=.2,
                          gableOverhang=.2,thick=.14,edge="omberg_ivory_trim",gutters=False),cladding={},
                openings=[opening("-y",x,1.5,1.4,.8) for x in [-r["lengthM"]*.3,0,r["lengthM"]*.3]],
                plinth=dict(h=.2,mat="concrete"),sink=.8))
            if fid=="1431573558":
                solar(g,-r["lengthM"]/2+.25,r["lengthM"]/2-.25,-r["widthM"]/2+.15,r["widthM"]/2-.15,
                      lambda y:ea+.10,rows=2)
        add(aid,g,r["cx"],r["cy"],row["axisBearingFromNorthDeg"],ground)
