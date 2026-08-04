import { test, expect } from 'bun:test';
import {
    DEFAULT_FEATURE_GATES,
    FEATURE_GATE_KEYS,
} from '../../shared/feature-gates.gen';
import {
    FeatureGatesService,
    isFeatureEnabled,
    resolveFeatureGates,
    type FeatureGateStorage,
} from '../src/app/feature-gates';

function storage(values: Record<string, string>): FeatureGateStorage {
    return {
        getItem(key: string): string | null {
            return values[key] ?? null;
        },
    };
}

test('generated gate defaults are complete and disabled', () => {
    expect(FEATURE_GATE_KEYS).toEqual([
        'pinEntry',
        'laserCalibration',
        'planEditing',
        'planOptionsTree',
        'decideMode',
        'puttRead',
    ]);
    expect(DEFAULT_FEATURE_GATES).toEqual({
        pinEntry: false,
        laserCalibration: false,
        planEditing: false,
        planOptionsTree: false,
        decideMode: false,
        puttRead: false,
    });
});

test('resolver applies exact per-gate storage overrides', () => {
    const gates = resolveFeatureGates({
        storage: storage({
            'gates.pinEntry': 'true',
            'gates.laserCalibration': 'false',
            'gates.planEditing': '1',
            'gates.planOptionsTree': 'TRUE',
            'gates.unknown': 'true',
        }),
    });

    expect(gates.pinEntry).toBe(true);
    expect(gates.laserCalibration).toBe(false);
    expect(gates.planEditing).toBe(false);
    expect(gates.planOptionsTree).toBe(false);
    expect(Object.keys(gates).sort()).toEqual([...FEATURE_GATE_KEYS].sort());
});

test('resolver supports injected defaults and storage-free operation', () => {
    const defaults = { ...DEFAULT_FEATURE_GATES, puttRead: true };
    expect(resolveFeatureGates({ defaults, storage: null })).toEqual(defaults);
});

test('typed helper and service expose the resolved record', () => {
    const service = new FeatureGatesService({
        storage: storage({ 'gates.decideMode': 'true' }),
    });

    expect(isFeatureEnabled(service.gates.peek(), 'decideMode')).toBe(true);
    expect(isFeatureEnabled(service.gates.peek(), 'puttRead')).toBe(false);
});
