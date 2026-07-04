import { Signal, Computed } from '@basics/core/client/core';
import { EntityStore } from '@basics/core/client/entity-store';
import { request, type RequestError } from '@basics/core/client/request';
import { api } from '../api';
import type { CoursesApi, CourseSummary } from '../../../shared/api/courses.gen';

export class CoursesService {
    readonly store = new EntityStore<CourseSummary>();
    readonly loading = new Signal(false);
    readonly error = new Signal<RequestError | null>(null);
    readonly page = new Signal(0);
    readonly pageSize = 50;
    private loaded = false;

    readonly pageCount = new Computed(() =>
        Math.ceil(this.store.total.get() / this.pageSize)
    );

    constructor(private coursesApi: CoursesApi = api.courses) {}

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
