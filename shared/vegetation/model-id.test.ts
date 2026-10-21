// The model id grammar against shared/vegetation/model-ids.fixture.json, the table its twins
// (pipeline/arborist.py, pipeline/tests/test_model_id.py; Unity's GolfMapModels.TryParse) read too.
import { expect, test } from 'bun:test';
import fixture from './model-ids.fixture.json';
import { modelId, parseModelId, type ModelRef } from './model-id';

type Good = ModelRef & { id: string };

test('every good id parses to its renderer, label, variant and texture, and builds back to itself', () => {
    for (const { id, ...ref } of fixture.good as Good[]) {
        expect(parseModelId(id)).toEqual(ref);
        expect(modelId(ref.renderer, ref.label, ref)).toBe(id);
    }
});

test('every bad id is refused', () => {
    for (const bad of fixture.bad) expect(() => parseModelId(bad)).toThrow(/Invalid model id/);
});
