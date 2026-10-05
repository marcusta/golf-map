// Ids of the three.js custom layers. They live apart from the layer modules so
// MapService can reserve and look up the layers without pulling three.js into
// the initial bundle (the layers load through import(), see lazy-custom-layer.ts).

export const WATER_LAYER_ID = 'course-water-3d';
export const TREES_LAYER_ID = 'individual-trees';
