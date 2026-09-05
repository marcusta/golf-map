import { Component, effect, template } from '@basics/core/client/core';
import { t } from '../theme';
import { s, btn } from '../css';
import { FurnitureService } from '../furniture/furniture.service';
import { PlannerToolService } from '../planner/planner-tool.service';
import { FlyoverService } from './flyover.service';
import { backTee, type LngLat } from './flyover-path';

const tpl = template(`
    <div class="flyover" bind="root">
        <button bind="btn" type="button" class="flyover-btn" data-testid="planner-flyover"
            title="Fly the camera from the tee down the hole to the green (Esc or touch the map to stop)">Flyover</button>
        <div bind="note" class="flyover-note"></div>
    </div>
`);

/**
 * "Flyover" action for the selected hole. Lives in the planner panel's
 * Hole setup section. Builds the waypoint list (tee → aim points or primary
 * plan shots → green centre) and hands it to `FlyoverService`; a second
 * click, or selecting another hole, stops the flight.
 *
 * Tee choice: the planner's own tee pick when the plan or the sticky tee
 * name names one, otherwise the back tee (farthest from the green).
 */
export class FlyoverButtonComponent extends Component {
    static styles = `
        .flyover {
            display: flex;
            flex-direction: column;
            gap: ${s('xs')};

            & .flyover-btn {
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
            & .flyover-note {
                display: none;
                font-size: 0.7rem;
                color: ${t('color-text-secondary')};
                &.show { display: block; }
            }
        }
    `;

    private tool = this.inject(PlannerToolService);
    private furniture = this.inject(FurnitureService);
    private flyover = this.inject(FlyoverService);

    render(): DocumentFragment {
        const frag = this.wire(tpl, {
            btn: {
                onclick: () => this.toggle(),
                disabled: () => !this.canFly(),
                textContent: () => this.flying() ? 'Stop flyover' : 'Flyover',
                'aria-pressed': () => this.flying() ? 'true' : 'false',
            },
            note: {
                textContent: () => this.noteText(),
                className: () => this.noteText() ? 'flyover-note show' : 'flyover-note',
            },
        });

        // Selecting another hole ends the flight.
        this.track(effect(() => {
            const hole = this.tool.selectedHole.get();
            const active = this.flyover.active.peek();
            if (active && active !== hole?.id) this.flyover.stop();
        }));
        this.track(() => this.flyover.stop());
        return frag;
    }

    private flying(): boolean {
        const hole = this.tool.selectedHole.get();
        return !!hole && this.flyover.active.get() === hole.id;
    }

    private canFly(): boolean {
        const hole = this.tool.selectedHole.get();
        if (!hole) return false;
        return this.furniture.teesForHole(hole.id).length > 0 && !!this.furniture.greenForHole(hole.id);
    }

    private noteText(): string {
        const notice = this.flyover.notice.get();
        if (notice) return notice;
        const hole = this.tool.selectedHole.get();
        if (!hole) return '';
        if (!this.furniture.greenForHole(hole.id)) return 'Flyover needs a green centre on this hole.';
        if (this.furniture.teesForHole(hole.id).length === 0) return 'Flyover needs a tee on this hole.';
        return '';
    }

    private toggle(): void {
        const hole = this.tool.selectedHole.peek();
        if (!hole) return;
        if (this.flyover.active.peek() === hole.id) {
            this.flyover.stop();
            return;
        }
        const waypoints = this.waypoints(hole.id);
        if (!waypoints) return;
        void this.flyover.start({ holeId: hole.id, waypoints });
    }

    /** Tee → aim points (or primary plan shots) → green centre; null without tee/green. */
    private waypoints(holeId: string): LngLat[] | null {
        const green = this.furniture.greenForHole(holeId);
        if (!green) return null;
        const tees = this.furniture.teesForHole(holeId);
        const explicitPick = !!(this.tool.planHole.peek()?.teeId || this.tool.activeTeeName.peek());
        const tee = explicitPick ? this.tool.originTee.peek() : backTee(tees, { lat: green.centerLat, lon: green.centerLon });
        if (!tee) return null;

        const aims = this.furniture.aimsForHole(holeId);
        const via = aims.length > 0 ? aims : this.tool.primaryShots.peek();
        return [
            { lng: tee.lon, lat: tee.lat },
            ...via.map(p => ({ lng: p.lon, lat: p.lat })),
            { lng: green.centerLon, lat: green.centerLat },
        ];
    }
}
