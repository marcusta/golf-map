// Contract of the cleaned photo's two raw (non-descriptor) routes, shared by
// the server (`server/api/cleaned-photo.routes.ts`) and the web client. The
// descriptor routes have their types in `api/cleaned-photo.gen.ts`; a
// raw-body route has no generated client, so its response type lives here.

/** Pixels per side of the cleaned photo, and of any image imported into it. */
export const CLEANED_PHOTO_SIZE = 8192;

/** Upload cap of `PUT /cleaned-photo/:courseId/import` (an 8192 px PNG is 100 to 200 MB). */
export const CLEANED_IMPORT_MAX_BYTES = 400 * 1024 * 1024;

/** Axis-aligned bounds; the field carrying them names the CRS. */
export interface CleanedPhotoBounds {
    west: number;
    south: number;
    east: number;
    north: number;
}

/**
 * 200 body of `PUT /cleaned-photo/:courseId/import`.
 *
 * `changed: false` is a normal answer: the image is the photo as it already
 * was, nothing was written, and `patchesGeneratedAt` is the version the
 * cleaned map tiles already had.
 */
export interface CleanedImportResult {
    /** Whether the cleaned photo now shows the image. */
    changed: boolean;
    /** Pixels that differ from the photo before the import. */
    changedPixels: number;
    /** EPSG:3006 bbox of those pixels; null when nothing changed. */
    bounds3006: CleanedPhotoBounds | null;
    /** Pixels per side of the cleaned photo. */
    size: number;
    /** Changes that can be undone after this import. */
    undoDepth: number;
    /** Cleaned map tile version: bumped when `changed`, otherwise the current one (null before the first change). */
    patchesGeneratedAt: string | null;
}

/** Error body of both raw routes (400, 401, 404, 408, 413, 422, 500). */
export interface CleanedPhotoRouteError {
    error: string;
}
