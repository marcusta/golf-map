import { Type, type Static } from '@sinclair/typebox';
import { requireAuth } from '@basics/core/server/auth';
import type { SitesService } from '../services/sites.service';

// --- Input schemas ---

const ListSitesInput = Type.Object({});

const GetSiteInput = Type.Object({
    id: Type.String(),
});

const CreateSiteInput = Type.Object({
    name: Type.String(),
    notes: Type.Optional(Type.String()),
});

const UpdateSiteInput = Type.Object({
    id: Type.String(),
    version: Type.Number(),
    name: Type.Optional(Type.String()),
    notes: Type.Optional(Type.String()),
});

const RemoveSiteInput = Type.Object({
    id: Type.String(),
    version: Type.Number(),
});

const SiteCoursesInput = Type.Object({
    siteId: Type.String(),
});

// --- API descriptor ---

export function createSitesApi(svc: SitesService) {
    const mw = [requireAuth()];
    return {
        list:    { method: 'GET'  as const, path: '/sites',         fn: () => svc.list(),                                                                 schema: ListSitesInput,   middleware: mw },
        get:     { method: 'GET'  as const, path: '/sites/get',     fn: (input: Static<typeof GetSiteInput>)     => svc.get(input.id),                    schema: GetSiteInput,     middleware: mw },
        courses: { method: 'GET'  as const, path: '/sites/courses', fn: (input: Static<typeof SiteCoursesInput>) => svc.listCoursesForSite(input.siteId), schema: SiteCoursesInput, middleware: mw },
        create:  { method: 'POST' as const, path: '/sites/create',  fn: (input: Static<typeof CreateSiteInput>)  => svc.create(input),                     schema: CreateSiteInput,  middleware: mw },
        update:  { method: 'POST' as const, path: '/sites/update',  fn: (input: Static<typeof UpdateSiteInput>)  => svc.update(input.id, input.version, { name: input.name, notes: input.notes }), schema: UpdateSiteInput, middleware: mw },
        remove:  { method: 'POST' as const, path: '/sites/remove',  fn: (input: Static<typeof RemoveSiteInput>)  => svc.remove(input.id, input.version),  schema: RemoveSiteInput,  middleware: mw },
    };
}
