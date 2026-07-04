import MapLibre

/// Placeholder for MapLibre map rendering.
///
/// IMPORTANT: never instantiate `MLNMapView` with a zero frame — give it a real
/// frame (or add it via UIViewRepresentable with proper layout) when this module
/// is implemented.
enum MapModule {
    /// Referencing a MapLibre type proves the framework links, not just resolves.
    static func linkedMapViewType() -> AnyClass {
        MLNMapView.self
    }
}
