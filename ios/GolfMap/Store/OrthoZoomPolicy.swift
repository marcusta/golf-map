import Foundation

/// The single place that decides how deep the ortho pyramid is used — both for
/// the archive the device downloads and for the raster source MapLibre renders.
///
/// Two independent ceilings meet here:
///
///  - **Device ceiling** (`deviceMaxZoom`) — deeper native ortho levels balloon
///    the bundle for little on-course benefit, so the archive request has always
///    stopped at z19 and the map overzooms z19 tiles past it.
///  - **Published cap** — the builder generates ortho to z20, but the publish
///    step (`docs/feature-local-builder-vps-serve.md` §7/§9) filters the tile
///    tree and rewrites `manifest.json` with a lower `layers.ortho.maxzoom`. A
///    VPS serving a capped site simply has no tiles above that level, so asking
///    for more means an archive that silently lacks the deepest levels and a
///    style that requests z20 tiles which 404.
///
/// The effective ceiling is the **lower of the two**. A manifest that does not
/// declare a usable ortho `maxzoom` — bundles predating the cap, hand-written
/// fixtures, a publish that dropped the field — falls back to the device
/// ceiling, i.e. exactly the behavior before the cap existed.
public enum OrthoZoomPolicy {
    /// Deepest ortho level this device ever wants, regardless of what the
    /// server publishes. The map overzooms past it up to `MapStyleBuilder.mapMaxZoom`.
    public static let deviceMaxZoom = 19

    /// Deepest ortho level to request/render, given the manifest's published
    /// ortho `maxzoom`. Pass `nil` (or a non-positive value, the sentinel for
    /// "the manifest didn't declare one") to get the device ceiling.
    public static func effectiveMaxZoom(publishedMaxZoom: Int?) -> Int {
        guard let publishedMaxZoom, publishedMaxZoom > 0 else { return deviceMaxZoom }
        return min(deviceMaxZoom, publishedMaxZoom)
    }
}
