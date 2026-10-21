# Domain vocabulary

Short glossary of the project's domain nouns. One line each; add a term when it is settled.

## Vegetation

- **Model**: one tree (or plant) model that can be drawn on a course: its species, its source and renderer (`arborist:<catalogue label>` or `vsp:<Unity prefab>`), its size (height, crown width) and its look in that renderer's terms. Two looks of the same mesh are two models.
- **Model library**: every model a course can use - trees, and the lower vegetation's grass (`vsp:texture:<texture>`), ground plants and bushes (forms grass, plant, shrub; one asset in several looks is several models, `#<variant>`). Palettes and zone palettes refer to it; it is the only place that says where a model is drawn, and it holds each model's look.
- **Zone palette**: what grows in one vegetation zone type (grass-palette.json): items that each refer to a model and keep only where and how densely it grows and its size; the colour is the model's, so it is set once for every zone that uses the model.
- **Renderer**: what draws a model in GSPro: the course's own VSP (Unity) or Arborist.
- **Palette**: the species a course (or a zone) plants and their weights, as references to models. It never says where anything is drawn; the size fit picks among a species' models.
- **Placement**: one planted tree before any renderer: tree id, model, position, rotation, scale, ground height. Planting produces the placements; each renderer's writer draws its own.
- **Routing policy**: a course's rules that send a placement to another renderer than its model's own (e.g. far from the play an Arborist billboard).
- **Tree edit**: a hand change to one placement by tree id (other model or species, size, position, rotation, delete, add), applied before routing.
- **Photo stem**: a tree stem found from its shadow in the summer photo (source `ortho-shadow`), on open surfaces only (rough, semi, deep rough, fairway); a proposal until accepted, then planted like a lidar stem. Woodland stays lidar-only.
- **Sun factor**: one photo's shadow length per metre of tree height, measured on the lidar stems that cast a shadow in it; it sizes the photo stems.
