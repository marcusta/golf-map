import { test, expect, describe } from 'bun:test';
import { SvgImportService, boundsFromGeoreference } from '../src/import/svg-import.service';
import type { CourseFeature, CourseFeaturesApi } from '../../shared/api/course-features.gen';

// Two layers: golf-map-2 fill convention (Master) + an unmappable fill; a
// translate transform; and a degenerate 2-point path in the green bucket.
const SVG = `<?xml version="1.0"?>
<svg xmlns="http://www.w3.org/2000/svg"
     xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape"
     viewBox="0 0 100 100">
  <g inkscape:label="Master">
    <path d="M 10 10 L 20 10 L 20 20 L 10 20 Z" style="fill:#bce5a4"/>
    <path d="M 30 10 L 40 10 L 40 20 Z" style="fill:#bce5a4"/>
    <path d="M 0 0 L 5 5 Z" style="fill:#bce5a4"/>
    <path d="M 50 50 L 60 50 L 60 60 Z" style="fill:#e5e5aa" transform="translate(10,0)"/>
  </g>
  <g inkscape:label="Decor">
    <path d="M 0 0 L 1 0 L 1 1 Z" style="fill:#fca328"/>
  </g>
</svg>`;

const BOUNDS = { minX: 1000, minY: 5000, maxX: 1100, maxY: 5100 };

function fakeApi(failAfter = Infinity) {
    const created: Array<{ courseId: string; type: string; geometry: unknown }> = [];
    const reject = () => Promise.reject(new Error('not under test'));
    const api: CourseFeaturesApi = {
        listByCourse: reject,
        listByHole: reject,
        geojsonByCourse: reject,
        create: async input => {
            if (created.length >= failAfter) throw new Error('boom');
            created.push(input as never);
            return { id: `f${created.length}`, version: 1, ...input, holeId: null, geojson: null } as CourseFeature;
        },
        update: reject,
        remove: reject,
    };
    return { api, created };
}

function loadedService(failAfter = Infinity) {
    const { api, created } = fakeApi(failAfter);
    const svc = new SvgImportService(api);
    svc.openFor('course-1', BOUNDS);
    svc.loadSvgText(SVG, 'test.svg');
    return { svc, created };
}

describe('SvgImportService', () => {
    test('openFor resets state and prefills bounds', () => {
        const svc = new SvgImportService(fakeApi().api);
        svc.openFor('c1', BOUNDS);
        expect(svc.open.get()).toBe(true);
        expect(svc.bounds.get()).toEqual(BOUNDS);
        expect(svc.parsed.get()).toBeNull();
    });

    test('loadSvgText parses buckets and prefills assignments from suggestions', () => {
        const { svc } = loadedService();
        const parsed = svc.parsed.get()!;
        expect(parsed.totalPaths).toBe(5);
        expect(svc.parseError.get()).toBeNull();
        const a = svc.assignments.get();
        expect(a['Master∷#bce5a4']).toBe('green');
        expect(a['Master∷#e5e5aa']).toBe('bunker');
        expect(a['Decor∷#fca328']).toBe('skip'); // no suggestion → skip
        expect(svc.assignedPathCount.get()).toBe(4);
    });

    test('loadSvgText surfaces parse failures', () => {
        const svc = new SvgImportService(fakeApi().api);
        svc.openFor('c1', BOUNDS);
        svc.loadSvgText('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"></svg>', 'empty.svg');
        expect(svc.parsed.get()).toBeNull();
        expect(svc.parseError.get()).toMatch(/no <path>/i);
    });

    test('assign and assignLayer update mapping and invalidate the preview', () => {
        const { svc } = loadedService();
        svc.build();
        expect(svc.built.get()).not.toBeNull();

        svc.assign('Decor∷#fca328', 'path');
        expect(svc.built.get()).toBeNull(); // stale preview dropped
        expect(svc.assignedPathCount.get()).toBe(5);

        svc.assignLayer('Master', 'skip');
        expect(svc.assignedPathCount.get()).toBe(1);
        svc.assignLayer('Master', 'suggested');
        expect(svc.assignments.get()['Master∷#bce5a4']).toBe('green');
    });

    test('build georeferences (y-flip), drops degenerate rings with warnings', () => {
        const { svc } = loadedService();
        const built = svc.build()!;
        // 4 assigned paths, one degenerate (2 anchors) → 3 features
        expect(built.features.length).toBe(3);
        expect(built.warnings.length).toBe(1);
        expect(built.warnings[0]).toMatch(/2 point/);

        const green = built.features[0];
        expect(green.type).toBe('green');
        // SVG (10,10) in a 100-box over [1000,5000 → 1100,5100]:
        // x = 1000 + 10 = 1010; y = 5100 − 10 = 5090 (flip)
        expect(green.geometry.rings[0].points[0]).toEqual({ x: 1010, y: 5090 });

        // bunker path had translate(10,0): SVG (50,50) → (60,50) → (1060, 5050)
        const bunker = built.features.find(f => f.type === 'bunker')!;
        expect(bunker.geometry.rings[0].points[0]).toEqual({ x: 1060, y: 5050 });
    });

    test('setBounds invalidates the preview and reprojects on next build', () => {
        const { svc } = loadedService();
        svc.build();
        svc.setBounds({ minX: 0, minY: 0, maxX: 200, maxY: 200 });
        expect(svc.built.get()).toBeNull();
        const built = svc.build()!;
        // scale ×2: SVG (10,10) → (20, 180)
        expect(built.features[0].geometry.rings[0].points[0]).toEqual({ x: 20, y: 180 });
    });

    test('confirmImport bulk-creates with per-type counts and clears the preview', async () => {
        const { svc, created } = loadedService();
        const summary = (await svc.confirmImport())!;
        expect(summary.error).toBeNull();
        expect(summary.created).toEqual({ green: 2, bunker: 1 });
        expect(summary.warnings.length).toBe(1);
        expect(created.length).toBe(3);
        expect(created.every(c => c.courseId === 'course-1')).toBe(true);
        expect(svc.built.get()).toBeNull();
        expect(svc.importing.get()).toBe(false);
        expect(svc.progress.get()).toEqual({ done: 3, total: 3 });
    });

    test('confirmImport aborts on failure, keeps partial counts, sets error', async () => {
        const { svc, created } = loadedService(1); // fail after 1 create
        const summary = (await svc.confirmImport())!;
        expect(summary.error).toBe('boom');
        expect(Object.values(summary.created).reduce((a, b) => a + b, 0)).toBe(1);
        expect(created.length).toBe(1);
        expect(svc.importing.get()).toBe(false);
    });

    test('close hides the wizard and drops the preview', () => {
        const { svc } = loadedService();
        svc.build();
        svc.close();
        expect(svc.open.get()).toBe(false);
        expect(svc.built.get()).toBeNull();
    });
});

describe('boundsFromGeoreference', () => {
    test('extracts the pipeline bbox', () => {
        const json = '{"crs": "EPSG:3006", "bbox": [541110.0, 6467550.0, 543410.0, 6469850.0]}';
        expect(boundsFromGeoreference(json)).toEqual({ minX: 541110, minY: 6467550, maxX: 543410, maxY: 6469850 });
    });

    test('null / malformed / missing bbox → null', () => {
        expect(boundsFromGeoreference(null)).toBeNull();
        expect(boundsFromGeoreference('not json')).toBeNull();
        expect(boundsFromGeoreference('{"crs": "EPSG:3006"}')).toBeNull();
        expect(boundsFromGeoreference('{"bbox": [1, 2, 3]}')).toBeNull();
    });
});
