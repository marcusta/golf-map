// A job's phase list, as the Terrain editor's shaping job has always shown
// them: done ✓ / running … / failed ✗ / skipped – / pending ·, with what the
// phase did and how long it took. The GSPro status board's update jobs carry
// the same `JobPhase[]` (the server's `job-phases.ts` bookkeeping is shared
// between `ShapingService` and `GsproSyncService`), so the drawing is one
// component instead of two.
//
// Props are a getter, not a value: the host keeps the signal and this redraws
// whenever it changes.

import { Component, effect } from '@basics/core/client/core';
import { t } from '../theme';
import { s } from '../css';
import type { JobPhase } from '../../../shared/api/gspro-sync.gen';
import { secsLabel } from './gspro-sync.service';

/** What each phase status looks like in the list. */
export const PHASE_MARK: Record<JobPhase['status'], string> = {
    done: '✓', running: '…', failed: '✗', skipped: '–', pending: '·',
};

/** `✓ Heightmaps — inner + outer (12 s)`. */
export function phaseLine(p: JobPhase): string {
    const mark = PHASE_MARK[p.status] ?? '·';
    const detail = p.detail && p.status !== 'pending' ? ` — ${p.detail}` : '';
    return `${mark} ${p.label}${detail}${p.seconds !== null ? ` (${secsLabel(p.seconds)})` : ''}`;
}

export interface JobPhasesProps {
    phases: () => readonly JobPhase[];
    /** `data-testid` of the list, so a spec can read it. */
    testid?: string;
}

export class JobPhasesComponent extends Component<JobPhasesProps> {
    static styles = `
        .job-phases {
            margin: 0;
            padding: 0;
            list-style: none;
            font-size: 0.7rem;
            line-height: 1.5;
            color: ${t('color-text-secondary')};
            & li { padding-left: ${s('xs')}; word-break: break-word; }
            & li[data-status="running"] { color: ${t('color-text-primary')}; }
            & li[data-status="failed"] { color: ${t('color-status-negative')}; }
            & li[data-status="pending"], & li[data-status="skipped"] { color: ${t('color-text-tertiary')}; }
            &:empty { display: none; }
        }
    `;

    render(): HTMLElement {
        const list = document.createElement('ol');
        list.className = 'job-phases';
        if (this.props.testid) list.dataset.testid = this.props.testid;
        this.track(effect(() => {
            const phases = this.props.phases();
            list.replaceChildren();
            for (const p of phases) {
                const li = document.createElement('li');
                li.dataset.phase = p.id;
                li.dataset.status = p.status;
                li.textContent = phaseLine(p);
                list.append(li);
            }
        }));
        return list;
    }
}
