import { Signal, Computed } from '@basics/core/client/core';
import { EntityStore } from '@basics/core/client/entity-store';
import { request, type RequestError } from '@basics/core/client/request';
import { api } from '../api';
import type { CoursesApi, CourseSummary } from '../../../shared/api/courses.gen';

export type SortBy = 'name' | 'updated' | 'progress';
export type GroupBy = 'site' | 'status' | 'none';

export type CourseGroup = {
    /** Group label; null renders as a single unlabeled group (groupBy = none). */
    label: string | null;
    courses: CourseSummary[];
};

const SORT_KEY = 'courses.sortBy';
const GROUP_KEY = 'courses.groupBy';
const UNASSIGNED = 'Unassigned';

const SORTS: SortBy[] = ['name', 'updated', 'progress'];
const GROUPS: GroupBy[] = ['site', 'status', 'none'];

function readStored<T extends string>(key: string, allowed: T[], fallback: T): T {
    try {
        const v = localStorage.getItem(key);
        if (v && (allowed as string[]).includes(v)) return v as T;
    } catch { /* localStorage unavailable */ }
    return fallback;
}

function writeStored(key: string, value: string): void {
    try { localStorage.setItem(key, value); } catch { /* ignore */ }
}

function progressPct(c: CourseSummary): number {
    return c.holeCount > 0 ? c.mappedHoleCount / c.holeCount : 0;
}

export class CoursesService {
    readonly store = new EntityStore<CourseSummary>();
    readonly loading = new Signal(false);
    readonly error = new Signal<RequestError | null>(null);
    readonly page = new Signal(0);
    readonly pageSize = 50;
    private loaded = false;

    // ── list controls (client-side; persisted) ──────────────────────────
    readonly query = new Signal('');
    readonly sortBy = new Signal<SortBy>(readStored(SORT_KEY, SORTS, 'name'));
    readonly groupBy = new Signal<GroupBy>(readStored(GROUP_KEY, GROUPS, 'none'));

    readonly pageCount = new Computed(() =>
        Math.ceil(this.store.total.get() / this.pageSize)
    );

    /** Filter → sort → group. Groups are ordered alphabetically, "Unassigned" last. */
    readonly groups = new Computed<CourseGroup[]>(() => {
        const q = this.query.get().trim().toLowerCase();
        const sortBy = this.sortBy.get();
        const groupBy = this.groupBy.get();

        const filtered = this.store.items.get().filter(c => {
            if (!q) return true;
            return c.name.toLowerCase().includes(q)
                || (c.siteName?.toLowerCase().includes(q) ?? false);
        });

        const sorted = [...filtered].sort((a, b) => {
            switch (sortBy) {
                case 'updated': return b.updatedAt.localeCompare(a.updatedAt);
                case 'progress': return progressPct(b) - progressPct(a);
                default: return a.name.localeCompare(b.name);
            }
        });

        if (groupBy === 'none') return [{ label: null, courses: sorted }];

        const buckets = new Map<string, CourseSummary[]>();
        for (const c of sorted) {
            const label = groupBy === 'status'
                ? (c.status === 'published' ? 'Published' : 'Draft')
                : (c.siteName ?? UNASSIGNED);
            let bucket = buckets.get(label);
            if (!bucket) buckets.set(label, bucket = []);
            bucket.push(c);
        }

        return [...buckets.entries()]
            .sort(([a], [b]) => {
                if (a === UNASSIGNED) return 1;
                if (b === UNASSIGNED) return -1;
                return a.localeCompare(b);
            })
            .map(([label, courses]) => ({ label, courses }));
    });

    constructor(private coursesApi: CoursesApi = api.courses) {}

    setSortBy(v: SortBy): void { this.sortBy.set(v); writeStored(SORT_KEY, v); }
    setGroupBy(v: GroupBy): void { this.groupBy.set(v); writeStored(GROUP_KEY, v); }

    async load(): Promise<void> {
        if (this.loaded) return;
        const data = await request(this.loading, this.error, () =>
            this.coursesApi.list({ offset: this.page.get() * this.pageSize, limit: this.pageSize }));
        if (data) {
            this.store.set(data.items, data.total);
            this.loaded = true;
        }
    }

    async nextPage(): Promise<void> {
        if (this.page.get() + 1 >= this.pageCount.get()) return;
        this.page.update(p => p + 1);
        this.loaded = false;
        await this.load();
    }

    async prevPage(): Promise<void> {
        if (this.page.get() === 0) return;
        this.page.update(p => p - 1);
        this.loaded = false;
        await this.load();
    }
}
