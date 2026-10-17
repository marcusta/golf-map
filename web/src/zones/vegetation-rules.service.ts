// The course's planting rules for the read-only Planting rules panel (server
// VegetationRulesService): what every vegetation generator and the tree planting go
// by, with the course's own values marked. Opened from the Vegetation mode's
// zone-type picker; re-read on every open, so it shows the files as they are now.

import { Signal } from '@basics/core/client/core';
import { api } from '../api';
import type { PlantingRules } from '../../../shared/api/vegetation-rules.gen';

export class VegetationRulesService {
    readonly rules = new Signal<PlantingRules | null>(null);
    readonly loading = new Signal(false);
    readonly error = new Signal('');
    /** Course the panel is open for; null = closed. */
    readonly panelCourseId = new Signal<string | null>(null);

    async openFor(courseId: string): Promise<void> {
        this.panelCourseId.set(courseId);
        this.error.set('');
        this.loading.set(true);
        try {
            const rules = await api.vegetationRules.get({ courseId });
            if (this.panelCourseId.peek() === courseId) this.rules.set(rules);
        } catch (e) {
            this.error.set(e instanceof Error ? e.message : String(e));
        } finally {
            this.loading.set(false);
        }
    }

    close(): void {
        this.panelCourseId.set(null);
    }
}

/** A rule value as one short line: lists joined, objects as `key value`, clearances as `tee, green: clear 4, ramp 4`. */
export function formatRuleValue(v: unknown): string {
    if (v === null || v === undefined) return '—';
    if (typeof v === 'number') return String(v);
    if (typeof v === 'string') return v;
    if (typeof v === 'boolean') return v ? 'on' : 'off';
    if (Array.isArray(v)) {
        if (v.every((x) => x === null || typeof x !== 'object' || Array.isArray(x))) {
            return v.map((x) => Array.isArray(x) ? `[${x.map(formatRuleValue).join(', ')}]` : formatRuleValue(x)).join(', ');
        }
        return v.map(formatRuleValue).join('; ');
    }
    const o = v as Record<string, unknown>;
    const { surfaces, ...rest } = o;
    const parts = Object.entries(rest).filter(([k]) => !k.startsWith('_')).map(([k, x]) => `${k} ${formatRuleValue(x)}`);
    return Array.isArray(surfaces) ? `${surfaces.join(', ')}: ${parts.join(', ')}` : parts.join(', ');
}

/** The lines a value is shown as: a list of objects (clearances) one per line, anything else as one. */
export function ruleValueLines(v: unknown): string[] {
    if (Array.isArray(v) && v.length > 1 && v.every((x) => x !== null && typeof x === 'object' && !Array.isArray(x))) {
        return v.map(formatRuleValue);
    }
    return [formatRuleValue(v)];
}
