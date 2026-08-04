import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export type FeatureTier = 'T1' | 'T2' | 'T3';

export type FeatureGateDefinition = {
    enabled: boolean;
    tier: FeatureTier;
};

export type FeatureGateConfig = Record<string, FeatureGateDefinition>;

const ROOT = resolve(import.meta.dir, '..');
const SOURCE_PATH = resolve(ROOT, 'shared/feature-gates.json');
const TS_OUTPUT_PATH = resolve(ROOT, 'shared/feature-gates.gen.ts');
const SWIFT_OUTPUT_PATH = resolve(ROOT, 'ios/GolfMap/App/FeatureGates.gen.swift');
const KEY_PATTERN = /^[a-z][A-Za-z0-9]*$/;
const TIERS = new Set<FeatureTier>(['T1', 'T2', 'T3']);
const RESERVED_KEYS = new Set([
    'as', 'break', 'case', 'catch', 'class', 'continue', 'default', 'defer',
    'do', 'else', 'enum', 'extension', 'fallthrough', 'false', 'for', 'func',
    'if', 'import', 'in', 'init', 'is', 'let', 'nil', 'protocol', 'repeat',
    'return', 'self', 'Self', 'static', 'struct', 'subscript', 'super',
    'switch', 'throw', 'throws', 'true', 'try', 'typealias', 'var', 'where',
    'while',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readConfig(text: string): FeatureGateConfig {
    let raw: unknown;
    try {
        raw = JSON.parse(text);
    } catch (error) {
        throw new Error(`Invalid JSON in ${SOURCE_PATH}: ${String(error)}`);
    }

    if (!isRecord(raw) || Object.keys(raw).length === 0) {
        throw new Error('Feature-gates source must be a non-empty object');
    }

    const config: FeatureGateConfig = {};
    for (const [key, value] of Object.entries(raw)) {
        if (!KEY_PATTERN.test(key) || RESERVED_KEYS.has(key)) {
            throw new Error(`Invalid feature-gate key '${key}'`);
        }
        if (!isRecord(value)
            || typeof value.enabled !== 'boolean'
            || typeof value.tier !== 'string'
            || !TIERS.has(value.tier as FeatureTier)
            || Object.keys(value).some(field => field !== 'enabled' && field !== 'tier')) {
            throw new Error(
                `Feature gate '${key}' must contain only boolean enabled and tier T1/T2/T3`,
            );
        }
        config[key] = { enabled: value.enabled, tier: value.tier as FeatureTier };
    }
    return config;
}

export function renderTypeScript(config: FeatureGateConfig): string {
    const keys = Object.keys(config);
    const keyLiterals = keys.map(key => `'${key}'`).join(', ');
    const definitions = keys.map(key => {
        const gate = config[key]!;
        return `    ${key}: { enabled: ${gate.enabled}, tier: '${gate.tier}' },`;
    }).join('\n');
    const defaults = keys.map(key => `    ${key}: ${config[key]!.enabled},`).join('\n');

    return `/**
 * Generated from shared/feature-gates.json. Do not edit by hand.
 * Run: bun run feature-gates:generate
 */

export type FeatureTier = 'T1' | 'T2' | 'T3';

export const FEATURE_GATE_KEYS = [${keyLiterals}] as const;
export type FeatureGateKey = (typeof FEATURE_GATE_KEYS)[number];

export type FeatureGates = Readonly<Record<FeatureGateKey, boolean>>;
export type FeatureGateDefinition = Readonly<{
    enabled: boolean;
    tier: FeatureTier;
}>;

export const FEATURE_GATE_DEFINITIONS = {
${definitions}
} as const satisfies Record<FeatureGateKey, FeatureGateDefinition>;

export const DEFAULT_FEATURE_GATES: FeatureGates = Object.freeze({
${defaults}
});
`;
}

export function renderSwift(config: FeatureGateConfig): string {
    const keys = Object.keys(config);
    const cases = keys.map(key => `    case ${key}`).join('\n');
    const accessors = keys.map(key => `        case .${key}: return ${key}`).join('\n');
    const assignments = keys.map(key => `            ${key}: overrides[.${key}] ?? ${key},`).join('\n');
    const properties = keys.map(key => `    let ${key}: Bool`).join('\n');
    const defaults = keys.map(key => `        ${key}: ${config[key]!.enabled},`).join('\n');

    return `// Generated from shared/feature-gates.json. Do not edit by hand.
// Run: bun run feature-gates:generate

enum FeatureGateKey: String, CaseIterable, Sendable {
${cases}
}

struct FeatureGates: Equatable, Sendable {
${properties}

    static let generatedDefaults = FeatureGates(
${defaults}
    )

    subscript(_ key: FeatureGateKey) -> Bool {
        switch key {
${accessors}
        }
    }

    func applying(_ overrides: [FeatureGateKey: Bool]) -> FeatureGates {
        FeatureGates(
${assignments}
        )
    }
}
`;
}

export async function generateFeatureGates(checkOnly = false): Promise<void> {
    const config = readConfig(await readFile(SOURCE_PATH, 'utf8'));
    const outputs = [
        [TS_OUTPUT_PATH, renderTypeScript(config)],
        [SWIFT_OUTPUT_PATH, renderSwift(config)],
    ] as const;

    for (const [path, expected] of outputs) {
        const file = Bun.file(path);
        const actual = await file.exists() ? await file.text() : null;
        if (actual !== expected) {
            if (checkOnly) {
                throw new Error(`Generated file is out of date: ${path}`);
            }
            await Bun.write(path, expected);
        }
    }
}

if (import.meta.main) {
    await generateFeatureGates(process.argv.includes('--check'));
}
