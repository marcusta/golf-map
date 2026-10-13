"""Pure math and actual Blender synthetic fixture; never loads/saves a course."""
import os
import sys
import json
import math
sys.path.insert(0,os.path.dirname(__file__))
import shape_transition as st

spec = dict(id='fixture',pattern='wheel-tracks',startM=0,direction=1,transitionLengthM=8,
            holdLengthM=1,fadeLengthM=2,ending='grass',seed=123,dirtAmount=.3,variation=.7)
assert st.project((9,4),[(0,0),(10,0),(10,10)]) == (14.,1.,1.)
samples = []
for pattern in ('soft-fade','overgrown-gravel','wheel-tracks'):
    s = dict(spec,pattern=pattern)
    vals = [st.weights(a,l,s,4) for a in (1,3,5,7) for l in (0,.75,1.5)]
    assert all(abs(sum(v)-1)<1e-12 and min(v)>=0 for v in vals)
    assert vals == [st.weights(a,l,s,4) for a in (1,3,5,7) for l in (0,.75,1.5)]
    samples.append(vals)
assert len({json.dumps(s) for s in samples}) == 3
assert st.weights(-1,0,spec,4) is None
assert st.weights(12,0,spec,4) == (1.,0.,0.)
continued=dict(spec,ending='continue')
assert st.weights(20,.75,continued,4)[1]>.6
assert st.weights(8.5,.75,continued,4)[1]>.6
assert st.weights(8.5,0,continued,4)[1]<.1
ts=dict(spec,startM=5,centerGrassReachM=3)
assert st.weights(1.9,0,ts,4) is None
assert st.weights(3,0,ts,4)[0]>0
assert st.weights(3,1,ts,4)[0]==0
assert st.weights(5,0,ts,4)[0]==1
# A nearby return leg of a hairpin projects to its own station, not the first leg.
hairpin=[(0,0),(20,0),(20,3),(0,3)]
s,l,d=st.project((5,2.9),hairpin)
assert s>30 and d<.11
# The grid index answers as project() does inside its band, None beyond it.
import random
rnd=random.Random(1)
wavy=[(x*.7,3*math.sin(x*.2)) for x in range(200)]+hairpin
index=st.LineIndex(wavy,1.25)
for _ in range(4000):
    q=(rnd.uniform(-3,143),rnd.uniform(-6,6))
    full=st.project(q,wavy)
    assert index.project(q)==(full if full[2]<=1.25 else None)
assert st.weights(3,.5,spec,4) != st.weights(3,.5,dict(spec,seed=321),4)
for vals in samples:
    assert all(sum(round(x*255) for x in st.byte_weights(v)[:3])==255 for v in vals)
# Wear: packed in the two tracks, loose on the crown and the shoulders; one band on a footpath.
two=dict(tracks=2,trackWidthM=.75,trackSpacingM=1.6,strength=1,seed=5)
# A 2.2 m path keeps a loose string down the middle between its tracks.
narrow=dict(tracks=2,trackWidthM=.53,trackSpacingM=1.1,edgeM=.12,strength=1,seed=5)
assert all(st.wear(a,0,narrow,2.2)<.05 and max(st.wear(a,.5,narrow,2.2),st.wear(a,.6,narrow,2.2))>.5 for a in range(0,200,7))
assert all(st.wear(a,.8,two,3.5)>.5 and st.wear(a,-.8,two,3.5)>.5 for a in range(0,200,7))
assert all(st.wear(a,0,two,3.5)<.05 and st.wear(a,1.7,two,3.5)==0 for a in range(0,200,7))
one=dict(tracks=1,trackWidthM=.9,trackSpacingM=0,strength=.8,seed=5)
assert all(st.wear(a,0,one,2)>.4 and st.wear(a,.95,one,2)==0 for a in range(0,200,7))
# Worn green leaves the sum (MAHS black); red and blue keep their bytes.
assert st.byte_weights((.2,.6,.2),.5)==(51/255,76/255,51/255,1.)
assert st.byte_weights((0,1,0),1)==(0,0,0,1.)
print('path transition pure math passed')

try:
    import bpy
except ImportError:
    sys.exit(0)
from mathutils import Vector
bpy.ops.wm.read_factory_settings(use_empty=True)
objects=[]
for name,ys,kind in [('Path',[-2,0,2],'mesh'),('Fringe',[2,3],'blend')]:
    verts=[(x,y,.02*x+.01*y) for x in range(0,17,2) for y in ys]
    faces=[]
    for i in range(8):
        for j in range(len(ys)-1):
            a=i*len(ys)+j; n=len(ys)
            if kind=='blend': faces.append((a,a+n,a+n+1,a+1))
            else: faces.extend([(a,a+n,a+n+1),(a,a+n+1,a+1)])
    me=bpy.data.meshes.new(name); me.from_pydata(verts,[],faces)
    col=me.color_attributes.new(name='Col',type='BYTE_COLOR',domain='CORNER')
    for loop in me.loops:
        y=me.vertices[loop.vertex_index].co.y
        g=1 if kind=='mesh' else max(0,3-y)
        col.data[loop.index].color_srgb=(1,0,0,1) if kind=='mesh' else (g,0,0,1)
    me.normals_split_custom_set_from_vertices([Vector((-.02,-.01,1)).normalized()]*len(verts))
    obj=bpy.data.objects.new(name,me); bpy.context.collection.objects.link(obj); obj['opcd_kind']=kind
    objects.append(obj)
import shape_apply as sa
edge_report=sa.edge_fade_core([objects[0]],[objects[1]],width=.6,max_edge=.45,amplitude=.2,seed=123,weld=False)
assert edge_report
print('Actual edge_fade_core -> path_transition fixture')
frame=dict(e0=0,n0=0,px=0,pz=0)
entries=[dict(shape='fixture',surface='gravel',widthM=4,centerline3006=[[0,0],[-8,0],[-16,-2]],transitions=[dict(spec,startM=2,ending='continue')])]
original={o.name:[v.co.copy() for v in o.data.vertices] for o in objects}
baseline={o.name:o.data.copy() for o in objects}
# Submillimetre seam discrepancy observed in FBX: paint still must match bytes.
from mathutils.kdtree import KDTree
seam_kd=KDTree(len(objects[0].data.vertices))
for i,v in enumerate(objects[0].data.vertices): seam_kd.insert(v.co,i)
seam_kd.balance()
shifted=0
for v in objects[1].data.vertices:
    if seam_kd.find(v.co)[2]<1e-6:
        v.co.x+=.0004
        shifted+=1
assert shifted>0
original={o.name:[v.co.copy() for v in o.data.vertices] for o in objects}
parallel_mesh=bpy.data.meshes.new('Nearby unrelated parallel path')
parallel_mesh.from_pydata([(0,4.7,0),(16,4.7,0),(16,5.7,0),(0,5.7,0)],[],[(0,1,2),(0,2,3)])
parallel=bpy.data.objects.new('Nearby unrelated parallel path',parallel_mesh)
bpy.context.collection.objects.link(parallel); parallel['opcd_kind']='mesh'
report=st.apply(objects+[parallel],entries,frame,.45)
assert parallel.data is parallel_mesh and not parallel.get('golfmap_path_transition')
parallel.hide_render=True
assert len(report)==2
assert all(r['droppedSliverArea']<1e-7 for r in report.values())
for o in objects:
    assert all(o.data.vertices[i].co==v for i,v in enumerate(original[o.name]))
    for poly in o.data.polygons:
        a,b,c=(o.data.vertices[i].co for i in poly.vertices)
        assert (b-a).cross(c-a).length>1e-9
    assert all(math.isfinite(c) for n in o.data.corner_normals for c in n.vector)
    assert all(abs(n.vector.length-1)<1e-5 for n in o.data.corner_normals)
    col=o.data.color_attributes['Col']
    assert all(sum(round(c*255) for c in col.data[l.index].color_srgb[:3])==255 for l in o.data.loops if 2<=o.data.vertices[l.vertex_index].co.x<8 and o.data.vertices[l.vertex_index].co.y<=2)
    for loop in o.data.loops:
        if o.data.vertices[loop.vertex_index].co.x<2:
            if loop.vertex_index < len(original[o.name]):
                if o.name=='Path':
                    assert tuple(round(c*255) for c in col.data[loop.index].color_srgb[:3])==(0,255,0)
def colors(o):
    return {tuple(round(c,5) for c in o.data.vertices[l.vertex_index].co):tuple(round(c*255) for c in o.data.color_attributes['Col'].data[l.index].color_srgb[:3]) for l in o.data.loops}
p,b=map(colors,objects)
shared=[]
for k,value in b.items():
    nearest=min(p,key=lambda q:sum((q[i]-k[i])**2 for i in range(3)))
    if sum((nearest[i]-k[i])**2 for i in range(3))<1e-6:
        shared.append(k)
        assert p[nearest]==value
assert st.apply(objects,entries,frame,.45)=={}
# Cache snapshots and worker history must restore the exported convention marker.
marker=objects[0]['golfmap_path_transition']
state=sa.capture_state(objects[0])
del objects[0]['golfmap_path_transition']
sa.apply_state(objects[0].name,*state)
assert objects[0]['golfmap_path_transition']==marker
history=sa.History()
snap=history.copy(objects[0].name)
history.record(objects[0].name,0,snap)
del objects[0]['golfmap_path_transition']
assert history.restore(objects[0].name,0)
assert objects[0]['golfmap_path_transition']==marker
print('Cache snapshot and worker history retained transition marker')
out=os.path.abspath(os.path.join(os.path.dirname(__file__),'../../data/path-transition-fixture'))
os.makedirs(out,exist_ok=True)
import shape_apply as sa
from types import SimpleNamespace
sidecar=os.path.join(out,'fixture-paths.json')
doc=dict(format='golfmap-path-regions-v1',transitions=entries)
with open(sidecar,'w') as f: json.dump(doc,f)
ctx=SimpleNamespace(frame=frame,index=[dict(name=o.name,svgId='fixture',type='path',kind=o['opcd_kind'],featureIds=['f']) for o in objects])
op=dict(id='transitions',op='golfmap.path_transition',select=dict(type='path'),paths=sidecar)
units,problems=sa.plan_units(ctx,op)
assert not problems and len(units)==1 and units[0].reads()=={'Path','Fringe'}
runner=sa.UnitRunner()
key=runner.key(ctx,op,units[0],{'Path':'a','Fringe':'b'})
doc['transitions'][0]['transitions'][0]['seed']=456
with open(sidecar,'w') as f: json.dump(doc,f)
changed,_=sa.plan_units(ctx,op)
assert runner.key(ctx,op,changed[0],{'Path':'a','Fringe':'b'})!=key
assert runner.key(ctx,op,units[0],{'Path':'a','Fringe':'changed'})!=key
print('path transition planner sidecar/input cache invalidation passed')
for o in objects:
    bpy.ops.object.select_all(action='DESELECT'); o.select_set(True); bpy.context.view_layer.objects.active=o
    bpy.ops.export_scene.fbx(filepath=os.path.join(out,o.name+'.fbx'),use_selection=True,bake_space_transform=True,use_custom_props=True)
    before=set(bpy.data.objects)
    bpy.ops.import_scene.fbx(filepath=os.path.join(out,o.name+'.fbx'))
    imported=set(bpy.data.objects)-before
    assert imported and all(i.get('golfmap_path_transition')==o.get('golfmap_path_transition') for i in imported if i.type=='MESH')
    for i in imported: bpy.data.objects.remove(i,do_unlink=True)
print('FBX import preserved exact path-transition custom property')
with open(os.path.join(out,'result.json'),'w') as f:
    json.dump(dict(objects=report,sharedVertices=len(shared),seamByteMismatches=0,geometryMoved=0,validNormals=True),f,indent=2)
print('path transition Blender fixture passed:',out)

# Actual top-down emission renders of the mesh's exported vertex colours.
scene=bpy.context.scene
scene.render.engine='BLENDER_EEVEE_NEXT'
scene.render.resolution_x=900; scene.render.resolution_y=360; scene.render.resolution_percentage=100
scene.view_settings.view_transform='Standard'
camera_data=bpy.data.cameras.new('Transition fixture camera')
camera=bpy.data.objects.new('Transition fixture camera',camera_data)
scene.collection.objects.link(camera); camera.location=(8,.5,25)
camera_data.type='ORTHO'; camera_data.ortho_scale=19; scene.camera=camera
material=bpy.data.materials.new('Transition RGB evidence'); material.use_nodes=True
nodes=material.node_tree.nodes; nodes.clear()
attr=nodes.new('ShaderNodeVertexColor'); attr.layer_name='Col'
emission=nodes.new('ShaderNodeEmission'); output=nodes.new('ShaderNodeOutputMaterial')
material.node_tree.links.new(attr.outputs['Color'],emission.inputs['Color'])
material.node_tree.links.new(emission.outputs[0],output.inputs['Surface'])
for pattern in ('soft-fade','wheel-tracks','overgrown-gravel'):
    for o in objects:
        o.data=baseline[o.name].copy()
        if 'golfmap_path_transition' in o: del o['golfmap_path_transition']
    entries[0]['transitions'][0]=dict(spec,pattern=pattern)
    st.apply(objects,entries,frame,.3)
    for o in objects:
        o.data.materials.clear(); o.data.materials.append(material)
    scene.render.filepath=os.path.join(out,pattern+'.png')
    bpy.ops.render.render(write_still=True)
print('Rendered three actual vertex-colour pattern fixtures')

# Wear alone (a gravel road with no transition): packed tracks leave the byte sum, no red on the road.
for o in objects:
    o.data=baseline[o.name].copy()
    if 'golfmap_path_transition' in o: del o['golfmap_path_transition']
entries[0]=dict(entries[0],transitions=[],wear=dict(tracks=2,trackWidthM=.75,trackSpacingM=1.6,strength=1,seed=5))
assert set(st.apply(objects,entries,frame,.3))=={'Path','Fringe'}
col=objects[0].data.color_attributes['Col']
sums=[]
for l in objects[0].data.loops:
    r,g,b=(round(c*255) for c in col.data[l.index].color_srgb[:3])
    assert r==0 and b==0
    v=objects[0].data.vertices[l.vertex_index].co
    if 1<v.x<7: sums.append((abs(v.y),g))
assert min(g for y,g in sums if .7<y<.9)<120 and all(g==255 for y,g in sums if y<.05 or y>1.85)
for o in objects:
    o.data.materials.clear(); o.data.materials.append(material)
scene.render.filepath=os.path.join(out,'wear.png')
bpy.ops.render.render(write_still=True)
print('path wear fixture passed')
