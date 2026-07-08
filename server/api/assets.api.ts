import { Type, type Static } from '@sinclair/typebox';
import { requireAuth } from '@basics/core/server/auth';
import type { AssetsService } from '../services/assets.service';

// --- Input schemas ---

const AssetKindSchema = Type.Union([
    Type.Literal('ortho_cog'),
    Type.Literal('dem_cog'),
    Type.Literal('svg_source'),
    Type.Literal('tile_manifest'),
]);

const ListAssetsInput = Type.Object({
    courseId: Type.String(),
});

const ListBySiteInput = Type.Object({
    siteId: Type.String(),
});

const GetAssetInput = Type.Object({
    id: Type.String(),
});

const RegisterAssetInput = Type.Object({
    siteId: Type.String(),
    courseId: Type.Optional(Type.String()),
    kind: AssetKindSchema,
    filename: Type.String(),
    metaJson: Type.Optional(Type.String()),
});

const UpdateAssetInput = Type.Object({
    id: Type.String(),
    version: Type.Number(),
    metaJson: Type.Optional(Type.String()),
});

const RemoveAssetInput = Type.Object({
    id: Type.String(),
    version: Type.Number(),
});

// --- API descriptor ---

export function createAssetsApi(svc: AssetsService) {
    const mw = [requireAuth()];
    return {
        listByCourse: {
            method: 'GET' as const,
            path: '/assets/by-course',
            fn: (input: Static<typeof ListAssetsInput>) => svc.listByCourse(input.courseId),
            schema: ListAssetsInput,
            middleware: mw,
        },
        listBySite: {
            method: 'GET' as const,
            path: '/assets/by-site',
            fn: (input: Static<typeof ListBySiteInput>) => svc.listBySite(input.siteId),
            schema: ListBySiteInput,
            middleware: mw,
        },
        get: {
            method: 'GET' as const,
            path: '/assets/get',
            fn: (input: Static<typeof GetAssetInput>) => svc.get(input.id),
            schema: GetAssetInput,
            middleware: mw,
        },
        register: {
            method: 'POST' as const,
            path: '/assets/register',
            fn: (input: Static<typeof RegisterAssetInput>) => svc.register(input),
            schema: RegisterAssetInput,
            middleware: mw,
        },
        update: {
            method: 'POST' as const,
            path: '/assets/update',
            fn: (input: Static<typeof UpdateAssetInput>) => svc.update(input.id, input.version, { metaJson: input.metaJson }),
            schema: UpdateAssetInput,
            middleware: mw,
        },
        remove: {
            method: 'POST' as const,
            path: '/assets/remove',
            fn: (input: Static<typeof RemoveAssetInput>) => svc.remove(input.id, input.version),
            schema: RemoveAssetInput,
            middleware: mw,
        },
    };
}
