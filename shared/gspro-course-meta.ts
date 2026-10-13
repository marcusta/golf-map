// The course details GSPro shows for a course — name, location, designer,
// description, keywords — as the app keeps them per course
// (`courses.gspro_meta_json`) and as GreenKeeper keeps them in the `.GKD`.
// Both sides edit the same fields: the app writes them into the `.GKD` on
// export (`gspro.py gkd`), and reads them back from a `.GKD` GreenKeeper
// saved (`metaFromGkd`). Each tee set's course rating and slope are not
// here: they belong to the course's tee sets (shared/tee-sets.ts). Everything
// else in the file's header (wind, stimp, firmness, the range, the splash
// image) stays GreenKeeper's.

/** The keyword flags a GKD carries (`Keyword<name>`), in file order. */
export const GKD_KEYWORDS = [
    'BeginnerFriendly', 'Coastal', 'Desert', 'Fantasy', 'Heathland', 'Historic', 'Links',
    'LowPoly', 'MajorVenue', 'Mountain', 'Parkland', 'TourStop', 'Training', 'Tropical',
] as const;
export type GkdKeyword = typeof GKD_KEYWORDS[number];

export interface GsproCourseMeta {
    /** `CourseName`: the name GSPro lists the course under. */
    courseName: string;
    /** `CityTown`, `StateCountyProvince`, `Country`; the GKD's `Location` is the three joined. */
    city: string;
    state: string;
    country: string;
    /** `Designer`: who built the GSPro course. */
    designer: string;
    /** `Homage`: the real course a fantasy one is modelled on. */
    homage: string;
    /** `CourseInfo`: the description GSPro shows. */
    description: string;
    /** `DifficultyRating`. */
    difficulty: number;
    /** The `Keyword<name>` flags that are on. */
    keywords: GkdKeyword[];
}

/** What a course that has never been described starts from. */
export function emptyCourseMeta(courseName = ''): GsproCourseMeta {
    return {
        courseName, city: '', state: '', country: '', designer: '', homage: '', description: '',
        difficulty: 0, keywords: [],
    };
}

/** The course details in a parsed `.GKD`. */
export function metaFromGkd(doc: Record<string, unknown>): GsproCourseMeta {
    const text = (key: string) => (typeof doc[key] === 'string' ? doc[key] as string : '');
    return {
        courseName: text('CourseName'), city: text('CityTown'), state: text('StateCountyProvince'),
        country: text('Country'), designer: text('Designer'), homage: text('Homage'),
        description: text('CourseInfo'),
        difficulty: typeof doc.DifficultyRating === 'number' && Number.isFinite(doc.DifficultyRating) ? doc.DifficultyRating : 0,
        keywords: GKD_KEYWORDS.filter(k => doc[`Keyword${k}`] === true),
    };
}

const LABELS: Record<keyof GsproCourseMeta, string> = {
    courseName: 'name', city: 'city', state: 'state', country: 'country', designer: 'designer',
    homage: 'homage', description: 'description', difficulty: 'difficulty', keywords: 'keywords',
};

/** What differs between two sets of course details, named for a hint (`designer`, `keywords`); empty = the same. */
export function courseMetaDiff(a: GsproCourseMeta, b: GsproCourseMeta): string[] {
    const out: string[] = [];
    for (const key of Object.keys(LABELS) as (keyof typeof LABELS)[]) {
        const same = key === 'keywords'
            ? [...a.keywords].sort().join() === [...b.keywords].sort().join()
            : a[key] === b[key];
        if (!same) out.push(LABELS[key]);
    }
    return out;
}
