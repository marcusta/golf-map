"""Curve-local path transition paint. Pure sampling; bpy is imported only by apply()."""
import math
import hashlib
import json
from collections import Counter
from shape_edgefade import value_noise, smoothstep


def project(point, line):
    """Nearest polyline station and signed lateral distance (metres)."""
    best = None
    station = 0.0
    for a, b in zip(line, line[1:]):
        dx, dy = b[0]-a[0], b[1]-a[1]
        length = math.hypot(dx, dy)
        if length < 1e-9:
            continue
        t = max(0.0, min(1.0, ((point[0]-a[0])*dx+(point[1]-a[1])*dy)/length**2))
        px, py = point[0]-a[0]-t*dx, point[1]-a[1]-t*dy
        distance = px*px+py*py
        candidate = (distance, station+t*length, (dx*py-dy*px)/length)
        if best is None or candidate[0] < best[0]:
            best = candidate
        station += length
    if best is None:
        raise ValueError('transition centreline needs two distinct points')
    return best[1], best[2], math.sqrt(best[0])


def weights(along, lateral, spec, width):
    """RGB weights or None outside the longitudinal footprint. Sum is exactly one."""
    a = (along-spec['startM'])*spec.get('direction', 1)
    length = spec['transitionLengthM']
    hold = spec.get('holdLengthM', 0.0)
    fade = spec.get('fadeLengthM', 0.0)
    reach = spec.get('centerGrassReachM', 0.0)
    if a < -reach:
        return None
    if a > length+hold+fade and spec.get('ending') == 'grass':
        return (1.,0.,0.)
    if a < 0:
        # Longitudinal grass tongue into the solid road, feathered both along and across.
        tongue = smoothstep(-reach, 0, a)*(1-smoothstep(.12,.55,abs(lateral)))
        return tongue, 1-tongue, 0.0
    seed = int(spec.get('seed', 0))
    noise = value_noise(a/3.5, lateral/.8, seed)
    wobble = spec.get('edgeIrregularity', .2)*noise
    t = smoothstep(0.0, max(.001, length), a)
    wander = .07*math.sin(a*.65)+spec.get('variation', .3)*.15*value_noise(a/4, .3, seed+42)
    dist = abs(abs(lateral-wander)-spec.get('trackSpacingM', 1.5)/2)
    ribbon = 1-smoothstep(spec.get('trackWidthM', .6)/2, spec.get('trackWidthM', .6)/2+.35, dist)
    pattern = spec.get('pattern', 'soft-fade')
    if pattern == 'soft-fade':
        path = 1-(.85+.12*noise)*smoothstep(.05+wobble*.1, 1, t)
    elif pattern == 'wheel-tracks':
        path = (1-smoothstep(0, .65+wobble*.15, t))
        path += (1-path)*ribbon
    elif pattern == 'overgrown-gravel':
        centre = 1-smoothstep(.15, max(.16, width*.35), abs(lateral-wander))
        grass = t*centre
        path = (1-grass)*(1-.55*t)
        path = max(path, ribbon*.7*t)
    else:
        raise ValueError('unknown path transition pattern: '+pattern)
    if reach:
        path *= 1-(1-smoothstep(.12,.55,abs(lateral)))*(1-t)
    if a > length+hold and fade and spec.get('ending') == 'grass':
        f = smoothstep(0, fade, a-length-hold)
        path = path*(1-f)
    dirt = (1-path)*spec.get('dirtAmount', 0)*t*smoothstep(-.2,.3,value_noise(a/2.4,lateral/.85,seed+83))
    if a > length+hold and fade and spec.get('ending') == 'grass':
        dirt *= 1-smoothstep(0,fade,a-length-hold)
    return 1-path-dirt, path, dirt


def byte_weights(rgb):
    g = max(0, min(255, round(rgb[1]*255)))
    b = max(0, min(255-g, round(rgb[2]*255)))
    return ((255-g-b)/255, g/255, b/255, 1.0)


def apply(objects, entries, frame, max_edge=.3):
    """Refine interior triangles without moving vertices or transferring faces between objects.

    Preserve source corner normals, UVs, material and colour by barycentric interpolation.
    Boundary edges are immutable: coincident original seam vertices receive identical bytes.
    """
    import bpy
    from mathutils import Vector
    from shape_coords import to_blend
    marker = hashlib.sha256(json.dumps([entries,max_edge],sort_keys=True).encode()).hexdigest()
    curves = [(e, [to_blend(*p, frame) for p in e['centerline3006']]) for e in entries]
    def sample(co):
        for entry, line in curves:
            s,l,d = project(co,line)
            # OPCD's outer fringe is narrow; a broad search band would paint an
            # unrelated parallel road in the same merged road shape.
            if d > entry['widthM']/2+.25:
                continue
            for spec in entry['transitions']:
                rgb = weights(s,l,spec,entry['widthM'])
                if rgb is not None:
                    return rgb
        return None
    report = {}
    seam = {}
    from mathutils.kdtree import KDTree
    seam_tree = None
    # Meshes first; fringes reuse their actual paint bytes at coincident vertices.
    for obj in sorted(objects,key=lambda o:(o.get('opcd_kind')=='blend',o.name)):
        if obj.get('golfmap_path_transition') == marker:
            continue
        me = obj.data
        if not any(sample(obj.matrix_world@v.co) is not None for v in me.vertices):
            continue
        me.calc_loop_triangles()
        verts = [v.co.copy() for v in me.vertices]
        world = [obj.matrix_world@v for v in verts]
        # OPCD cuts can leave zero-area triangulation slivers. They have no
        # surface to preserve and would otherwise export invalid normals/faces.
        dropped_area = sum(t.area for t in me.loop_triangles if t.area <= 1e-10)
        triangles = [t for t in me.loop_triangles if t.area > 1e-10]
        sources = [tuple(t.loops) for t in triangles]
        faces = [(tuple(t.vertices),i,((1.,0.,0.),(0.,1.,0.),(0.,0.,1.))) for i,t in enumerate(triangles)]
        key = lambda a,b: (min(a,b),max(a,b))
        counts = Counter(key(f[i],f[(i+1)%3]) for f,_,_ in faces for i in range(3))
        boundary = {e for e,n in counts.items() if n==1}
        for iteration in range(12):
            chosen = set()
            for f,_,_ in faces:
                edges = [key(f[i],f[(i+1)%3]) for i in range(3)]
                edge = max(edges,key=lambda e:(world[e[0]]-world[e[1]]).length_squared)
                if edge not in boundary and (world[edge[0]]-world[edge[1]]).length > max_edge and any(sample(world[j]) is not None for j in f):
                    chosen.add(edge)
            if not chosen:
                break
            mids = {}
            for a,b in sorted(chosen):
                mids[a,b] = len(verts)
                verts.append((verts[a]+verts[b])*.5)
                world.append(obj.matrix_world@verts[-1])
            out = []
            for f,src,bary in faces:
                parts = [(f,bary)]
                for edge in (key(f[0],f[1]),key(f[1],f[2]),key(f[2],f[0])):
                    if edge not in mids:
                        continue
                    newer = []
                    for tri,bs in parts:
                        if not all(v in tri for v in edge):
                            newer.append((tri,bs)); continue
                        for j in range(3):
                            k,h = (j+1)%3,(j+2)%3
                            if key(tri[j],tri[k]) == edge:
                                mid = tuple((bs[j][q]+bs[k][q])*.5 for q in range(3))
                                newer.extend([((tri[j],mids[edge],tri[h]),(bs[j],mid,bs[h])),((mids[edge],tri[k],tri[h]),(mid,bs[k],bs[h]))]); break
                    parts = newer
                out.extend((tri,src,bs) for tri,bs in parts)
            faces = out
        dropped_area += sum((verts[f[1]]-verts[f[0]]).cross(verts[f[2]]-verts[f[0]]).length*.5
                            for f,_,_ in faces if (verts[f[1]]-verts[f[0]]).cross(verts[f[2]]-verts[f[0]]).length <= 1e-9)
        faces = [(f,src,bs) for f,src,bs in faces
                 if (verts[f[1]]-verts[f[0]]).cross(verts[f[2]]-verts[f[0]]).length > 1e-9]
        new = bpy.data.meshes.new(me.name+' transition')
        new.from_pydata(verts,[],[f for f,_,_ in faces])
        for material in me.materials:
            new.materials.append(material)
        attrs = [(a,new.color_attributes.new(name=a.name,type=a.data_type,domain='CORNER')) for a in me.color_attributes if a.domain=='CORNER']
        if not attrs:
            attrs = [(None,new.color_attributes.new(name='Col',type='BYTE_COLOR',domain='CORNER'))]
        uvs = [(u,new.uv_layers.new(name=u.name)) for u in me.uv_layers]
        normals = []
        for pi,(tri,src,bs) in enumerate(faces):
            new.polygons[pi].material_index = triangles[src].material_index
            new.polygons[pi].use_smooth = me.polygons[triangles[src].polygon_index].use_smooth
            loops = sources[src]
            for j,bary in enumerate(bs):
                li = pi*3+j
                no = sum((me.corner_normals[loops[q]].vector*bary[q] for q in range(3)),Vector())
                normals.append(no.normalized())
                for old,uv in uvs:
                    uv.data[li].uv = sum((old.data[loops[q]].uv*bary[q] for q in range(3)),Vector((0.,0.)))
                rgb = sample(world[tri[j]])
                for old,col in attrs:
                    base = tuple(sum(old.data[loops[q]].color_srgb[k]*bary[q] for q in range(3)) for k in range(4)) if old else (0.,1.,0.,1.)
                    if rgb is not None:
                        # Keep the fringe's transverse grass ramp; meshes use canonical G path.
                        coverage = base[1] if obj.get('opcd_kind')=='blend' else 1.
                        value = byte_weights((1-coverage*(rgb[1]+rgb[2]),coverage*rgb[1],coverage*rgb[2]))
                        pos = tuple(world[tri[j]])
                        if obj.get('opcd_kind')=='blend':
                            if seam_tree is not None:
                                _, index, distance = seam_tree.find(pos)
                                if distance < .001:
                                    value = seam_values[index]
                        else:
                            seam[pos] = value
                        col.data[li].color_srgb = value
                    else:
                        # Unity's current path SurfaceMaterial maps every original
                        # channel to the same own surface. Full green therefore
                        # preserves its rendered appearance under the RGB convention.
                        col.data[li].color_srgb = (0.,1.,0.,base[3]) if obj.get('opcd_kind')!='blend' else base
                    pos = tuple(world[tri[j]])
                    if obj.get('opcd_kind') != 'blend':
                        seam[pos] = tuple(col.data[li].color_srgb)
                    elif seam_tree is not None:
                        _, index, distance = seam_tree.find(pos)
                        if distance < .001:
                            col.data[li].color_srgb = seam_values[index]
        new.normals_split_custom_set(normals)
        new.update()
        obj.data = new
        obj['golfmap_path_transition'] = marker
        report[obj.name] = {'vertices':len(verts),'triangles':len(faces),'iterations':iteration,
                            'droppedSliverArea':dropped_area}
        if obj.get('opcd_kind') != 'blend' and seam:
            seam_tree = KDTree(len(seam))
            seam_values = []
            for index,(pos,value) in enumerate(seam.items()):
                seam_tree.insert(pos,index)
                seam_values.append(value)
            seam_tree.balance()
    return report
