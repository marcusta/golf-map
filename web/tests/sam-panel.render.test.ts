import { test, expect, afterEach } from 'bun:test';
import { di } from '@basics/core/client/core';
import { _reset } from '@basics/core/client/error-report';
import { SamPanelComponent } from '../src/sam/sam-panel.component';
import { SamToolService, SAM_SCOPE_FOLLOW, SAM_SCOPE_COURSE } from '../src/sam/sam-tool.service';
import { CourseDetailService } from '../src/course-detail/course-detail.service';
import type { Hole } from '../../shared/api/holes.gen';

// Render smoke for the SAM panel's hole-scope picker (there are no
// per-component specs by design — TESTING.md — but the scope select's
// option list + signal wiring is worth one throw-check through happy-dom).

afterEach(() => {
    _reset();
    di.reset();
});

function hole(number: number, id: string): Hole {
    return {
        id, courseId: 'c1', number, par: 4, strokeIndex: null, notes: null,
        savedRegionJson: null, version: 1, createdAt: '', updatedAt: '',
    };
}

function mount(): { host: HTMLElement; tool: SamToolService } {
    const tool = new SamToolService();
    di.set(SamToolService, tool);
    const detail = new CourseDetailService();
    detail.holeStore.set([hole(1, 'h1'), hole(2, 'h2')]);
    di.set(CourseDetailService, detail);
    const host = document.createElement('div');
    new SamPanelComponent({}).mount(host);
    return { host, tool };
}

test('scope select defaults to follow and lists course level + every hole', () => {
    const { host } = mount();
    const select = host.querySelector('[data-testid="sam-scope-select"]') as HTMLSelectElement;
    expect(select).not.toBeNull();
    expect(select.value).toBe(SAM_SCOPE_FOLLOW);
    const options = [...select.options].map(o => [o.value, o.textContent]);
    expect(options).toEqual([
        [SAM_SCOPE_FOLLOW, 'Selected hole (auto)'],
        [SAM_SCOPE_COURSE, 'Course level'],
        ['h1', 'Hole 1 (par 4)'],
        ['h2', 'Hole 2 (par 4)'],
    ]);
});

test('changing the select arms the service scope', () => {
    const { host, tool } = mount();
    const select = host.querySelector('[data-testid="sam-scope-select"]') as HTMLSelectElement;
    select.value = 'h2';
    select.dispatchEvent(new Event('change'));
    expect(tool.holeScope.peek()).toBe('h2');
    select.value = SAM_SCOPE_COURSE;
    select.dispatchEvent(new Event('change'));
    expect(tool.holeScope.peek()).toBe(SAM_SCOPE_COURSE);
});
