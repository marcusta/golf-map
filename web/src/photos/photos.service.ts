// State for the Photos sub-mode (docs/feature-reference-photos.md §7): the
// site's reference photos from the iPhone capture mode, the browse view (the
// catalog list or the map), the filter, the selected photo and the viewer.
//
// Photos belong to a site (D-RP7), so the list is loaded by the course's
// `siteId` and cached per site. Tags, note and hole are edited here through
// `photos.update`; on the builder a later VPS pull keeps those edits.
//
// DI singleton shared by the tool, the dock panel and the browser overlay; the
// constructor takes the API client so it is testable headlessly.

import { Signal, Computed } from '@basics/core/client/core';
import { request, type RequestError } from '@basics/core/client/request';
import { api, API_BASE } from '../api';
import type { PhotosApi } from '../../../shared/api/photos.gen';
import {
    EMPTY_FILTER,
    filterPhotos,
    knownTags,
    normalizeTag,
    type HoleLine,
    type Photo,
    type PhotoFilter,
} from './photo-filter';

export type PhotosView = 'list' | 'map';

type PhotoPatch = { tags?: string[]; note?: string | null; hole?: number | null };

const VIEW_KEY = 'golf-map.photos.view';

function loadView(): PhotosView {
    try {
        return localStorage.getItem(VIEW_KEY) === 'map' ? 'map' : 'list';
    } catch {
        return 'list';
    }
}

/** URL of a photo's 2048 px JPEG preview, or null before it has arrived. */
export function previewUrl(photo: Photo): string | null {
    return photo.previewSha256 ? `${API_BASE}/photos/file/${encodeURIComponent(photo.id)}?kind=preview` : null;
}

export class PhotosService {
    readonly photos = new Signal<Photo[]>([]);
    readonly loading = new Signal(false);
    readonly error = new Signal<RequestError | null>(null);
    readonly saving = new Signal(false);
    readonly saveError = new Signal<RequestError | null>(null);
    /** Site the list belongs to; null when the course has none. */
    readonly siteId = new Signal<string | null>(null);

    readonly view = new Signal<PhotosView>(loadView());
    readonly filter = new Signal<PhotoFilter>(EMPTY_FILTER);
    /** Play lines per hole number, for the "near hole" filter. */
    readonly holeLines = new Signal<ReadonlyMap<number, HoleLine>>(new Map());
    /** Waiting for a map click to set the "near position" filter. */
    readonly pickingPosition = new Signal(false);

    readonly selectedId = new Signal<string | null>(null);
    /** The large viewer over the map is open on `selected`. */
    readonly viewerOpen = new Signal(false);

    readonly filtered = new Computed<Photo[]>(() =>
        filterPhotos(this.photos.get(), this.filter.get(), this.holeLines.get()));

    readonly selected = new Computed<Photo | null>(() => {
        const id = this.selectedId.get();
        return id ? this.photos.get().find(p => p.id === id) ?? null : null;
    });

    readonly tags = new Computed<string[]>(() => knownTags(this.photos.get()));

    private loadedSiteId: string | null = null;
    private saveQueue: Promise<void> = Promise.resolve();

    constructor(private photosApi: PhotosApi = api.photos) {}

    /** Load the site's photos (cached per site; `force` refetches). */
    async load(siteId: string | null, force = false): Promise<void> {
        if (!force && siteId === this.loadedSiteId) return;
        this.loadedSiteId = siteId;
        this.siteId.set(siteId);
        if (!siteId) {
            this.photos.set([]);
            return;
        }
        const rows = await request(this.loading, this.error, () => this.photosApi.list({ siteId }));
        if (rows && this.loadedSiteId === siteId) this.photos.set(rows);
    }

    reload(): Promise<void> {
        return this.load(this.loadedSiteId, true);
    }

    // ── View + filter ───────────────────────────────────────────────────────

    setView(view: PhotosView): void {
        this.view.set(view);
        try {
            localStorage.setItem(VIEW_KEY, view);
        } catch {
            // Non-fatal — the view just won't be remembered.
        }
    }

    patchFilter(patch: Partial<PhotoFilter>): void {
        this.filter.set({ ...this.filter.peek(), ...patch });
    }

    clearFilter(): void {
        this.pickingPosition.set(false);
        this.filter.set(EMPTY_FILTER);
    }

    /** Toggle one tag in the tag filter (and leave "untagged only"). */
    toggleFilterTag(tag: string): void {
        const f = this.filter.peek();
        const tags = f.tags.includes(tag) ? f.tags.filter(t => t !== tag) : [...f.tags, tag];
        this.patchFilter({ tags, untagged: false });
    }

    /** Set the "near position" filter from a map click, keeping the radius. */
    pickPosition(lngLat: { lng: number; lat: number }): void {
        const radiusM = this.filter.peek().near?.radiusM ?? 50;
        this.pickingPosition.set(false);
        this.patchFilter({ near: { lng: lngLat.lng, lat: lngLat.lat, radiusM } });
    }

    // ── Selection + viewer ──────────────────────────────────────────────────

    select(id: string | null): void {
        this.selectedId.set(id);
        if (!id) this.viewerOpen.set(false);
    }

    open(id: string): void {
        this.selectedId.set(id);
        this.viewerOpen.set(true);
    }

    closeViewer(): void {
        this.viewerOpen.set(false);
    }

    /** Move the selection `delta` steps through the filtered photos (wraps). */
    step(delta: number): void {
        const list = this.filtered.peek();
        if (list.length === 0) return;
        const i = list.findIndex(p => p.id === this.selectedId.peek());
        const next = i < 0 ? 0 : (i + delta + list.length) % list.length;
        this.selectedId.set(list[next]!.id);
    }

    // ── Edits ───────────────────────────────────────────────────────────────

    toggleTag(id: string, rawTag: string): Promise<void> {
        const tag = normalizeTag(rawTag);
        if (!tag) return Promise.resolve();
        return this.save(id, photo => ({
            tags: photo.tags.includes(tag) ? photo.tags.filter(t => t !== tag) : [...photo.tags, tag],
        }));
    }

    setNote(id: string, note: string): Promise<void> {
        const trimmed = note.trim();
        return this.save(id, photo => ((photo.note ?? '') === trimmed ? null : { note: trimmed || null }));
    }

    setHole(id: string, hole: number | null): Promise<void> {
        return this.save(id, photo => (photo.hole === hole ? null : { hole }));
    }

    /**
     * Save under the row's version, then swap the server row in. Saves run
     * one at a time and `patchOf` sees the row the previous save left (null =
     * nothing to change), so a note saved on blur and quick tag clicks after
     * it neither conflict nor drop an edit. A version conflict (the photo
     * changed elsewhere) reloads the list.
     */
    private save(id: string, patchOf: (photo: Photo) => PhotoPatch | null): Promise<void> {
        const run = async () => {
            const photo = this.photos.peek().find(p => p.id === id);
            const patch = photo ? patchOf(photo) : null;
            if (!photo || !patch) return;
            const fresh = await request(this.saving, this.saveError, () =>
                this.photosApi.update({ id, version: photo.version, ...patch }));
            if (fresh) {
                this.photos.set(this.photos.peek().map(p => (p.id === id ? fresh : p)));
            } else {
                await this.reload();
            }
        };
        this.saveQueue = this.saveQueue.then(run, run);
        return this.saveQueue;
    }
}
