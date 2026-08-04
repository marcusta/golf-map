import { Signal } from '@basics/core/client/core';
import {
    DEFAULT_FEATURE_GATES,
    FEATURE_GATE_KEYS,
    type FeatureGateKey,
    type FeatureGates,
} from '../../../shared/feature-gates.gen';

export type FeatureGateStorage = Pick<Storage, 'getItem'>;

export type FeatureGatesResolveOptions = {
    /** Defaults are injectable so resolution stays deterministic in tests. */
    defaults?: FeatureGates;
    /** Pass null to disable browser storage, or a small test double. */
    storage?: FeatureGateStorage | null;
};

const STORAGE_PREFIX = 'gates.';

function browserStorage(): FeatureGateStorage | null {
    try {
        return typeof localStorage === 'undefined' ? null : localStorage;
    } catch {
        // Privacy mode and embedded contexts can expose localStorage but make
        // access throw. The generated defaults are the safe fallback.
        return null;
    }
}

function parseBoolean(value: string | null): boolean | undefined {
    if (value === 'true') return true;
    if (value === 'false') return false;
    return undefined;
}

/** Resolves generated defaults plus exact boolean development/test overrides. */
export function resolveFeatureGates(options: FeatureGatesResolveOptions = {}): FeatureGates {
    const resolved: Record<FeatureGateKey, boolean> = {
        ...(options.defaults ?? DEFAULT_FEATURE_GATES),
    };
    const storage = options.storage === undefined ? browserStorage() : options.storage;
    if (!storage) return resolved;

    for (const key of FEATURE_GATE_KEYS) {
        const override = parseBoolean(storage.getItem(`${STORAGE_PREFIX}${key}`));
        if (override !== undefined) resolved[key] = override;
    }
    return resolved;
}

/** Typed access point for consumers; a misspelled gate is a compile error. */
export function isFeatureEnabled(gates: FeatureGates, key: FeatureGateKey): boolean {
    return gates[key];
}

/** Carries the launch-resolved gate set without fetching or mutating config. */
export class FeatureGatesService {
    readonly gates: Signal<FeatureGates>;

    constructor(options: FeatureGatesResolveOptions = {}) {
        this.gates = new Signal(resolveFeatureGates(options));
    }
}
