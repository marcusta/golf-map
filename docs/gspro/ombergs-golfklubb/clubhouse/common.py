"""Shared helpers for the Omberg clubhouse generators (model.py, outbuildings.py)."""
import math

from mathutils import Matrix
import props_kit as kit


def opening(side, at, w=1.15, h=1.35, sill=.9, kind="window", **kw):
    d=dict(side=side, at=at, w=w, h=h, sill=sill, kind=kind,
                frame="omberg_ivory_trim", frameW=.065, casing=.09,
                bars=[2,3] if kind == "window" else [1,1])
    d.update(kw)
    return d


def roof_building(g, length, width, eave, ridge, at=(0,0,0), rot=0,
                  openings=(), wall="omberg_red", roof="omberg_terracotta", **kw):
    g.push(Matrix.Translation(at) @ Matrix.Rotation(math.radians(rot),4,"Z"))
    s=dict(length=length,width=width,wall=wall,trim="omberg_ivory_trim",
           roof=dict(type="gable",eave=eave,ridge=ridge,mat=roof,
                     overhang=.46,gableOverhang=.32,thick=.16,
                     edge="omberg_ivory_trim",under="omberg_ivory_trim",gutterMat="omberg_ivory_trim"),
           openings=list(openings),plinth=dict(h=.22,mat="concrete"),sink=.85,
           cornerBoard=.16,cladding=dict(type="battens",spacing=.16,w=.034,depth=.016))
    s.update(kw)
    kit.building(g,s)
    g.pop()


def solar(g, x0, x1, y0, y1, zfunc, rows=3):
    """Ortho-visible arrays: blue modules, fine cell grid in shared solar texture."""
    cols=max(1,int((x1-x0)/1.05))
    for j in range(rows):
        ya=y0+(y1-y0)*j/rows
        yb=y0+(y1-y0)*(j+1)/rows
        for i in range(cols):
            xa=x0+(x1-x0)*i/cols+.012
            xb=x0+(x1-x0)*(i+1)/cols-.012
            inset=.025 if y1>y0 else -.025
            g.poly([(xa,ya,zfunc(ya)+.09),(xb,ya,zfunc(ya)+.09),
                    (xb,yb-inset,zfunc(yb-inset)+.09),(xa,yb-inset,zfunc(yb-inset)+.09)][::1 if y1>y0 else -1],
                   "solar_panel",uv=("fit",1,1))


def ccw(poly):
    area=sum(a[0]*b[1]-b[0]*a[1] for a,b in zip(poly,poly[1:]+poly[:1]))
    return poly if area>0 else list(reversed(poly))

