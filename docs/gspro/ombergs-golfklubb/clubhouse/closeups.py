"""Close-up review renders of single assets from a built omberg-clubhouse-authored.blend.

Blender 4.5:  blender.exe -b <out>/omberg-clubhouse-authored.blend --python closeups.py --
                 --assets omberg_clubhouse,omberg_white_connector --out <folder> [--size 1200x800]
Each asset gets four oblique views from its corners (about 25 degrees down) and one
low view from the long side. The other assets stay in the scene, as on the course.
"""
import argparse
import math
import sys
from pathlib import Path

import bpy
from mathutils import Vector


def main():
    p=argparse.ArgumentParser()
    p.add_argument("--assets",required=True)
    p.add_argument("--out",required=True)
    p.add_argument("--size",default="1200x800")
    a=p.parse_args(sys.argv[sys.argv.index("--")+1:])
    out=Path(a.out)
    out.mkdir(parents=True,exist_ok=True)
    sc=bpy.context.scene
    sc.render.resolution_x,sc.render.resolution_y=map(int,a.size.split("x"))
    sc.render.image_settings.file_format="PNG"
    for name in a.assets.split(","):
        ob=bpy.data.objects[name]
        corners=[ob.matrix_world@Vector(c) for c in ob.bound_box]
        lo=Vector([min(c[i] for c in corners) for i in range(3)])
        hi=Vector([max(c[i] for c in corners) for i in range(3)])
        centre=(lo+hi)/2
        radius=max((hi-lo).xy.length/2,4)
        views=[(f"{name}-{label}",az,25) for label,az in [("ne",45),("se",135),("sw",225),("nw",315)]]
        views.append((f"{name}-low",(math.degrees(ob.rotation_euler.z)+90)%360,8))
        for view,az,tilt in views:
            d=radius*2.1
            t=math.radians(az)
            loc=centre+Vector((math.sin(t)*d*math.cos(math.radians(tilt)),
                               math.cos(t)*d*math.cos(math.radians(tilt)),
                               d*math.sin(math.radians(tilt))))
            cam=bpy.data.cameras.new("closeup")
            cam.lens=35
            cam.clip_end=3000
            co=bpy.data.objects.new("closeup",cam)
            sc.collection.objects.link(co)
            co.location=loc
            co.rotation_euler=(centre-loc).to_track_quat("-Z","Y").to_euler()
            sc.camera=co
            sc.render.filepath=str(out/(view+".png"))
            bpy.ops.render.render(write_still=True)
            bpy.data.objects.remove(co,do_unlink=True)
            print("VIEW",sc.render.filepath,flush=True)


main()
