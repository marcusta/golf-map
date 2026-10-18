// GENERATED — DO NOT EDIT
import { apiFetch } from '@basics/core/client/fetch';

export interface PlantingRules {
    courseId: string;
    courseName: string;
    courseDocs: string;
    generators: PlantingRuleSection[];
    trees: PlantingRuleSection[];
    treeAreas: TreeAreaRule[];
    treeAssets: { species: string; enabled: number; total: number }[];
    treeModels: TreeSpeciesModels[];
}

export interface PlantingRuleSection {
    source: string;
    label: string;
    script: null | string;
    summary: string;
    steps: string[];
    courseFile: null | string;
    groups: PlantingRuleGroup[];
    courseExtras: { key: string; value: unknown }[];
    mixes: PlantingMix[];
}

export interface TreeAreaRule {
    name: string;
    mix: string;
    ignoreKind: boolean;
}

export interface TreeSpeciesModels {
    species: string;
    weight: number;
    models: TreeModelRule[];
}

export interface PlantingRuleGroup {
    title: string;
    rules: PlantingRule[];
}

export interface PlantingMix {
    zoneType: string;
    zoneTypeName: string;
    variant: string;
    variantName: string;
    items: string[];
}

export interface TreeModelRule {
    id: string;
    renderer: string;
    heightM: number;
    crownWidthM: number;
    enabled: boolean;
    missing?: boolean;
}

export interface PlantingRule {
    key: string;
    unit: null | string;
    text: string;
    flag: boolean;
    defaultValue: unknown;
    courseSets: boolean;
    courseValue: unknown;
    value: unknown;
}

export interface VegetationRulesApi {
    get(input: { courseId: string }): Promise<PlantingRules>;
}

export function createVegetationRulesClient(baseUrl: string): VegetationRulesApi {
    return {
        async get(input) {
            const params = new URLSearchParams();
            for (const [k, v] of Object.entries(input as any))
                if (v !== undefined) params.set(k, String(v));
            const qs = params.toString();
            return apiFetch({ method: 'GET', url: `${baseUrl}/vegetation-rules${qs ? '?' + qs : ''}` });
        },
    };
}
