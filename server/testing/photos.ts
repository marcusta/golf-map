import * as os from 'node:os';
import * as path from 'node:path';
import { mkdtempSync, writeFileSync } from 'node:fs';
import type { CreatePhotoInput, PhotoKind, PhotosService } from '../services/photos.service';

/** A valid create body for `siteId`, near Stockholm. */
export function photoInput(id: string, siteId: string, over: Partial<CreatePhotoInput> = {}): CreatePhotoInput {
    return {
        id,
        siteId,
        capturedAt: '2026-10-02T09:14:31Z',
        lat: 59.33,
        lon: 18.06,
        hAccM: 3.5,
        attitudeQuat: { w: 1, x: 0, y: 0, z: 0 },
        yawDeg: 212.5,
        pitchDeg: -2,
        rollDeg: 0.4,
        headingAccDeg: 8,
        hfovDeg: 69.4,
        vfovDeg: 54.6,
        width: 4032,
        height: 3024,
        deviceModel: 'iPhone16,1',
        tags: ['tee'],
        ...over,
    };
}

export function sha256(bytes: Uint8Array | string): string {
    return new Bun.CryptoHasher('sha256').update(bytes).digest('hex');
}

export function tmpDir(prefix: string): string {
    return mkdtempSync(path.join(os.tmpdir(), `golf-${prefix}-`));
}

/** Stores `bytes` as the photo's file through the same path the upload route uses. */
export async function storeFile(svc: PhotosService, id: string, kind: PhotoKind, bytes: string) {
    const tmpPath = path.join(tmpDir('upload'), 'body');
    writeFileSync(tmpPath, bytes);
    const sha = sha256(bytes);
    return svc.storeUploadedFile(id, kind, { tmpPath, sha256: sha, bytes: Buffer.byteLength(bytes), declaredSha256: sha });
}
