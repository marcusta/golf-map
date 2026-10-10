import { test, expect } from '@playwright/test';
import { FURNITURE_COURSE_ID, tid, waitForMapReady, selectSubMode } from './fixtures';

test('curved path transitions edit, drag, undo and survive reload', async ({page, context}, info) => {
    test.setTimeout(90000);
    await context.request.post('/api/auth/login', {data:{username:'marcus', password:'test-password-123'}});
    await page.goto(`/course/${FURNITURE_COURSE_ID}`);
    await waitForMapReady(page);
    const fixture = await page.evaluate(async courseId => {
        const transform = await import('/src/geo/transform.ts');
        const map = (window as any).__map;
        const q = transform.lngLatToSweref99tm(map.getCenter());
        const points = [{x:q.x-60,y:q.y},{x:q.x,y:q.y+30},{x:q.x+60,y:q.y}];
        const response = await fetch('/api/features/create', {method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({courseId,type:'path',geometry:{crs:'EPSG:3006', rings:[],centerline:{points,widthM:4}},attributes:{surface:'gravel'}})});
        if (!response.ok) throw new Error(await response.text());
        const feature = await response.json();
        const centre = transform.sweref99tmToWgs84(q.x,q.y+30);
        return {id:feature.id,lon:centre.lon,lat:centre.lat};
    }, FURNITURE_COURSE_ID);
    const read = async () => { const r = await context.request.get(`/api/features?courseId=${FURNITURE_COURSE_ID}`); return (await r.json()).find((f:any)=>f.id===fixture.id); };
    const select = async () => {
        await page.reload(); await waitForMapReady(page); await selectSubMode(page,'draw');
        const point = await page.evaluate(({lon,lat})=>{const m=(window as any).__map; m.jumpTo({center:[lon,lat],zoom:18}); const p=m.project([lon,lat]); const rect=m.getCanvas().getBoundingClientRect(); return {x:p.x+rect.left,y:p.y+rect.top};},fixture);
        await page.mouse.click(point.x,point.y);
        await expect(page.locator(tid('path-transition-add'))).toBeVisible();
    };
    try {
        await select(); await page.locator(tid('path-transition-add')).click();
        await expect(page.locator(tid('path-transition-pattern'))).toHaveValue('soft-fade');
        await page.locator(tid('path-transition-pattern')).selectOption('wheel-tracks');
        await page.locator(tid('path-transition-placement')).selectOption('section');
        await page.locator(tid('path-transition-transitionLengthM')).fill('12');
        await page.locator(tid('path-transition-transitionLengthM')).press('Tab');
        await expect.poll(async()=> (await read()).attributes.pathTransitions[0].transitionLengthM).toBe(12);
        const before = (await read()).attributes.pathTransitions[0];
        const marker = page.locator(tid('path-transition-marker-0'));
        await marker.scrollIntoViewIfNeeded();
        const box = (await marker.boundingBox())!;
        await page.mouse.move(box.x+box.width/2,box.y+box.height/2); await page.mouse.down(); await page.mouse.move(box.x+box.width/2+30,box.y+box.height/2+5,{steps:6}); await page.mouse.up();
        await expect.poll(async()=> (await read()).attributes.pathTransitions[0].startM).not.toBe(before.startM);
        await page.getByRole('button',{name:'Undo',exact:true}).click();
        await expect.poll(async()=> (await read()).attributes.pathTransitions[0].startM).toBe(before.startM);
        await select();
        await expect(page.locator(tid('path-transition-pattern'))).toHaveValue('wheel-tracks');
        await expect(page.locator(tid('path-transition-transitionLengthM'))).toHaveValue('12');
        await page.screenshot({path:info.outputPath('path-transitions.png'),fullPage:true});
        await page.locator(tid('path-transition-ending')).selectOption('continue');
        await expect(page.locator(tid('path-transition-fadeLengthM'))).toBeHidden();
        await expect.poll(async()=> (await read()).attributes.pathTransitions[0].ending).toBe('continue');
        await page.locator(tid('path-transition-remove')).click();
        await expect.poll(async()=> (await read()).attributes.pathTransitions).toEqual([]);
    } finally {
        const feature = await read();
        if (feature) await context.request.post('/api/features/remove', {data:{id:feature.id,version:feature.version}});
    }
});
