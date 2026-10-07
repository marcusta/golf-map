// Contract of the two raw (non-descriptor) ortho-patch routes, shared by the
// server (`server/api/ortho-patches.routes.ts`) and the web client. The
// descriptor routes have their types in `api/ortho-patches.gen.ts`; a raw-body
// route has no generated client, so its response type lives here.
// Plan: docs/feature-ortho-export-import.md §5.

/** Upload cap of `PUT /ortho-patches/import/:courseId` (an 8192 px PNG is 100 to 200 MB). */
export const ORTHO_IMPORT_MAX_BYTES = 400 * 1024 * 1024;

/** Axis-aligned bounds; the field carrying them names the CRS. */
export interface OrthoImportBounds {
    west: number;
    south: number;
    east: number;
    north: number;
}

/** Why an import changed nothing. */
export type OrthoImportNoChangeReason = 'identical' | 'below-min-area' | 'outside-ortho';

/**
 * 200 body of `PUT /ortho-patches/import/:courseId`.
 *
 * `changed: false` is a normal answer: the edited image holds no change worth
 * storing, nothing was appended or baked, and `patchesGeneratedAt` is the
 * version the sim tiles already had.
 */
export interface OrthoImportResult {
    /** Whether a `raster` entry was appended to the patch log and baked. */
    changed: boolean;
    /** Present when `changed` is false. */
    reason?: OrthoImportNoChangeReason;
    /** Patch-log length after this import. */
    count: number;
    /** Sim tile version: bumped when `changed`, otherwise the current one (null before the first bake). */
    patchesGeneratedAt: string | null;
    /** Log seq of the new entry; null when nothing changed. */
    seq: number | null;
    /** The export the edited image was compared with. */
    exportSeq: number;
    /** Pixels of the export frame the stored patch covers (after noise removal and 1 px dilation). */
    changedPixels: number;
    /** Pixels that differed by more than `tolerance` before noise removal. */
    diffPixels: number;
    /** Per-channel tolerance used (0..254). */
    tolerance: number;
    /** Changed regions under this many frame pixels were dropped. */
    minAreaPx: number;
    /** EPSG:3006 bbox of the change; null when nothing changed. */
    bounds3006: OrthoImportBounds | null;
    /** EPSG:3857 bbox of the change, the retiled area; null when nothing changed. */
    bounds3857: OrthoImportBounds | null;
    /** Number of separate changed regions; null when nothing changed. */
    regions: number | null;
}

/** Error body of both raw routes (400, 401, 404, 413, 422, 500). */
export interface OrthoRouteError {
    error: string;
}
