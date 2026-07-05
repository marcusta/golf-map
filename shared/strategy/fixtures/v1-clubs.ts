// The 13 clubs from the v1 export (golfcoursemap-export-2026-03-24.json,
// exported from the v1 iOS app; also tabulated in the Phase-5 recon spec).
// Used as test fixtures here and as seed data for web player config.
// Units: meters. dispersionM is the FULL lateral extent (v1 gotcha #1).

import type { ClubSpec } from '../club';

export const V1_CLUBS: readonly Required<ClubSpec>[] = [
    { name: 'Driver', carryM: 243, dispersionM: 65 },
    { name: '3w', carryM: 220, dispersionM: 55 },
    { name: '3h', carryM: 200, dispersionM: 42 },
    { name: '4i', carryM: 187, dispersionM: 40 },
    { name: '5i', carryM: 177, dispersionM: 38 },
    { name: '6i', carryM: 168, dispersionM: 37 },
    { name: '7i', carryM: 155, dispersionM: 32 },
    { name: '8i', carryM: 142, dispersionM: 30 },
    { name: '9i', carryM: 127, dispersionM: 30 },
    { name: 'PW', carryM: 115, dispersionM: 27 },
    { name: '50', carryM: 100, dispersionM: 25 },
    { name: '54', carryM: 90, dispersionM: 20 },
    { name: 'LW', carryM: 75, dispersionM: 16 },
];

/** Look up a fixture club by name (throws on a bad name — test helper). */
export function v1Club(name: string): Required<ClubSpec> {
    const club = V1_CLUBS.find(c => c.name === name);
    if (!club) throw new Error(`No v1 fixture club named "${name}"`);
    return club;
}
