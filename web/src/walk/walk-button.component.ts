import { Component, effect, template } from '@basics/core/client/core';
import { t } from '../theme';
import { s, btn } from '../css';
import { FurnitureService } from '../furniture/furniture.service';
import { PlannerToolService } from '../planner/planner-tool.service';
import { WalkService, type WalkHoleContext } from './walk.service';

const tpl = template(`
    <div class="walk" bind="root">
        <button bind="btn" type="button" class="walk-btn" data-testid="planner-walk"
            title="Walk the hole at ground level: click a spot on the map (or Alt+click the map directly). Esc exits.">Walk</button>
        <div bind="note" class="walk-note"></div>
    </div>
`);

/**
 * "Walk" action for the selected hole, next to Flyover in the planner
 * panel's Hole setup section. Clicking arms a one-shot "click a spot" state;
 * the next map click enters walk mode there. While walking the button reads
 * "Stop walk". Also installs the Alt+click entry gesture for as long as the
 * panel is mounted, supplying the hole's aims/green so the first look points
 * down the hole. Selecting another hole exits the walk.
 */
export class WalkButtonComponent extends Component {
    static styles = `
        .walk {
            display: flex;
            flex-direction: column;
            gap: ${s('xs')};

            & .walk-btn {
                padding: 3px ${s('xs')};
                font-size: 0.72rem;
                font-family: inherit;
                ${btn(t('radius-sm'))}
                &[aria-pressed="true"] {
                    border-color: ${t('color-accent-primary')};
                    color: ${t('color-on-accent')};
                    background: ${t('color-accent-primary')};
                }
                &:disabled { opacity: 0.5; cursor: default; }
            }
            & .walk-note {
                display: none;
                font-size: 0.7rem;
                color: ${t('color-text-secondary')};
                &.show { display: block; }
            }
        }
    `;

    private tool = this.inject(PlannerToolService);
    private furniture = this.inject(FurnitureService);
    private walk = this.inject(WalkService);

    render(): DocumentFragment {
        const frag = this.wire(tpl, {
            btn: {
                onclick: () => this.toggle(),
                disabled: () => !this.tool.selectedHole.get(),
                textContent: () => this.walking() ? 'Stop walk' : this.walk.armed.get() ? 'Cancel' : 'Walk',
                'aria-pressed': () => this.walking() || this.walk.armed.get() ? 'true' : 'false',
            },
            note: {
                textContent: () => this.noteText(),
                className: () => this.noteText() ? 'walk-note show' : 'walk-note',
            },
        });

        this.track(this.walk.bindEntry(() => this.holeContext()));

        // Selecting another hole ends the walk (and drops an armed click).
        this.track(effect(() => {
            const hole = this.tool.selectedHole.get();
            const active = this.walk.active.peek();
            if (active && active !== hole?.id) this.walk.stop();
            if (!hole && this.walk.armed.peek()) this.walk.disarmClick();
        }));
        this.track(() => {
            this.walk.disarmClick();
            this.walk.stop();
        });
        return frag;
    }

    private walking(): boolean {
        const hole = this.tool.selectedHole.get();
        return !!hole && this.walk.active.get() === hole.id;
    }

    private noteText(): string {
        const notice = this.walk.notice.get();
        if (notice) return notice;
        if (this.walk.armed.get()) return 'Click a spot on the map to walk there (Esc cancels).';
        return '';
    }

    private toggle(): void {
        const hole = this.tool.selectedHole.peek();
        if (!hole) return;
        if (this.walk.active.peek() === hole.id) {
            this.walk.stop();
            return;
        }
        this.walk.armClick();
    }

    /** Selected hole's aims (hole order) and green centre for the initial look direction. */
    private holeContext(): WalkHoleContext | null {
        const hole = this.tool.selectedHole.peek();
        if (!hole) return null;
        const green = this.furniture.greenForHole(hole.id);
        return {
            holeId: hole.id,
            aims: this.furniture.aimsForHole(hole.id).map(a => ({ lng: a.lon, lat: a.lat })),
            green: green ? { lng: green.centerLon, lat: green.centerLat } : null,
        };
    }
}
