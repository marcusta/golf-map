"""Isolated actual worker sync regression; no course files or live worker.

Run from the repository root:
    "C:/Program Files/Blender Foundation/Blender 4.5/blender.exe" -b --factory-startup --python-exit-code 1 --python blender/tools/shape_worker_transition_test.py
"""
import bpy
import os
import sys
import json
import tempfile
from types import SimpleNamespace
sys.path.insert(0, os.path.dirname(__file__))
import shape_worker as sw
import shape_apply as sa

with tempfile.TemporaryDirectory(prefix="golfmap_transition_worker_") as folder:
    try:
        layers = os.path.join(folder, 'layers')
        os.makedirs(layers)
        svg = os.path.join(folder, 'fixture.svg')
        sidecar = os.path.join(folder, 'fixture-paths.json')
        dem = os.path.join(folder, 'fixture-inner-dem-20m.tif.json')
        blend = os.path.join(folder, 'fixture.conformed.blend')
        with open(svg, 'w') as f:
            f.write('<svg xmlns="http://www.w3.org/2000/svg"><path id="roads_fixture" '
                    'data-type="path" data-feature-id="fixture" d="M 0 0 L 16 0"/></svg>')
        with open(dem, 'w') as f:
            json.dump(dict(square3006=[0, 0, 20, 20], minM=0), f)
        op = dict(id='paths-transitions', op='golfmap.path_transition',
                  select=dict(type='path'), maxEdgeM=.6)
        with open(os.path.join(layers, '00-global.json'), 'w') as f:
            json.dump(dict(format='golfmap-shaping-layer-v1', id='global', ops=[op]), f)
        spec = dict(id='t', pattern='wheel-tracks', placement='section', startM=3,
                    direction=1, transitionLengthM=5, holdLengthM=2, fadeLengthM=2,
                    ending='grass', seed=1)
        doc = dict(format='golfmap-path-regions-v1', transitions=[dict(
            shape='roads_fixture', surface='gravel', widthM=4,
            centerline3006=[[0, 0], [-16, 0]], transitions=[spec])])

        def save():
            with open(sidecar, 'w') as f:
                json.dump(doc, f)
        save()
        bpy.ops.wm.read_factory_settings(use_empty=True)
        me = bpy.data.meshes.new('Fixture')
        me.from_pydata([(x, y, 0) for x in range(17) for y in (-2, 0, 2)], [],
                      [(i*3+j, i*3+j+3, i*3+j+4, i*3+j+1) for i in range(16) for j in range(2)])
        col = me.color_attributes.new(name='Col', type='BYTE_COLOR', domain='CORNER')
        for c in col.data:
            c.color_srgb = (1, 0, 0, 1)
        obj = bpy.data.objects.new('Spline_roads_fixture_Concrete_-_Mesh', me)
        bpy.context.collection.objects.link(obj)
        obj['opcd_kind'] = 'mesh'
        obj['opcd_shape_id'] = 'roads_fixture'
        obj['golfmap_surface'] = 'gravel'
        baseline = sa.state_hash(*sa.capture_state(obj))
        name = obj.name
        # This file is exclusively the synthetic test fixture, never a course file.
        bpy.ops.wm.save_as_mainfile(filepath=blend)
        args = SimpleNamespace(port=0, blend=blend, layers=layers, fbx_folder=None,
                               svg=svg, sidecar=dem, no_cache=False)
        worker = sw.Worker(args)
        result = worker.load({})
        assert not result['errors'], result['errors']
        assert worker.app.ctx.by_name[name]['type'] == 'path'
        default = worker.op_list(layers)[0]['canon']
        for override in ('fixture-paths.json', sidecar):
            resolved = sa._split_sidecar(worker.app.ctx, dict(op, paths=override))
            assert os.path.abspath(resolved) == sidecar
        os.rename(sidecar, sidecar + '.saved')
        missing = worker.op_list(layers)[0]['canon']
        assert missing != default and 'missing' in missing
        try:
            sa.plan_units(worker.app.ctx, op)
            raise AssertionError('planner accepted a missing sidecar')
        except FileNotFoundError:
            pass
        os.rename(sidecar + '.saved', sidecar)
        assert worker.op_list(layers)[0]['canon'] == default
        first = sa.state_hash(*sa.capture_state(bpy.data.objects[name]))
        assert first != baseline
        unchanged = worker.sync({})
        assert unchanged['changedOps'] == [] and unchanged['changedObjects'] == []
        # Unrelated region metadata must not trigger this paint operation.
        doc['regionNote'] = 'unrelated surface export metadata'
        save()
        unchanged = worker.sync({})
        assert unchanged['changedOps'] == [] and unchanged['changedObjects'] == []
        worker.app.ctx._sidecars = {sidecar: {'stale': True}}
        spec['pattern'] = 'soft-fade'
        save()
        changed = worker.sync({})
        assert changed['changedOps'] == ['global:paths-transitions'], changed
        assert changed['ranOps'] == ['global:paths-transitions'], changed
        assert '_sidecars' not in worker.app.ctx.__dict__
        second = sa.state_hash(*sa.capture_state(bpy.data.objects[name]))
        assert second != first
        doc['transitions'] = []
        save()
        removed = worker.sync({})
        assert removed['changedOps'] == ['global:paths-transitions'], removed
        assert sa.state_hash(*sa.capture_state(bpy.data.objects[name])) == baseline
        assert not bpy.data.objects[name].get('golfmap_path_transition')
        again = worker.sync({})
        assert again['changedOps'] == [] and again['changedObjects'] == []
        print('PASS actual worker sync: sidecar edit/remove replay transition only; '
              'unchanged skips; memo cleared; baseline restored')
    finally:
        # Release the open synthetic fixture before Windows removes the directory.
        bpy.ops.wm.read_factory_settings(use_empty=True)
