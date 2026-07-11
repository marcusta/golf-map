//  Components.swift
//  Golf Intel — Design System · "Links & Loam" component treatments
//  iOS / SwiftUI
//
//  Shared view primitives applying the component-treatment guide on top of
//  Tokens.swift. All colors/spacing/radii/typography read from the tokens —
//  no new decisions here, only application:
//
//    · glassPanel()        — translucent panel fill + blur + rim-light stroke
//    · OverlineLabel       — mono uppercase overline (panel/section titles)
//    · MetricText          — mono tabular value + dimmed ~80%-size unit
//    · MapLabelPill        — scrim pill for text over map imagery
//    · mapLabelScrim()     — same scrim treatment for arbitrary content
//    · mapControl()        — round over-map control fill (zoom/tools stack)
//    · PrimaryButtonStyle  — the one clay action per view
//    · SecondaryButtonStyle— quiet raised + border action
//    · selectedState()     — 12% accent tint + 1.5pt inset accent ring

import SwiftUI

// MARK: - Glass panel (chrome floats over terrain, it doesn't cover it)

/// Overlay panel fill over a blur, rim-light stroke, radius-lg, elev-3.
/// Background-only: callers keep their own content padding.
private struct GlassPanelModifier: ViewModifier {
    var cornerRadius: CGFloat = Radius.lg

    func body(content: Content) -> some View {
        let shape = RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
        content
            .background {
                shape.fill(Overlay.panelFill)
                    .background(.ultraThinMaterial, in: shape)
                    .overlay(shape.strokeBorder(Overlay.panelStroke, lineWidth: 1))
                    .elevation(Elevation.e3)
            }
    }
}

extension View {
    /// The guide's glass-panel treatment for chrome floating over the map.
    func glassPanel(cornerRadius: CGFloat = Radius.lg) -> some View {
        modifier(GlassPanelModifier(cornerRadius: cornerRadius))
    }
}

// MARK: - Overline (mono uppercase section/panel titles)

/// Mono uppercase overline — panel titles and metric captions. "Never bold
/// body": headers are quiet tertiary mono, not heavy sans.
struct OverlineLabel: View {
    let text: String
    var color: Color = .textTertiary
    var size: CGFloat = 11

    init(_ text: String, color: Color = .textTertiary, size: CGFloat = 11) {
        self.text = text
        self.color = color
        self.size = size
    }

    var body: some View {
        Text(text.uppercased())
            .font(AppFont.mono(size, .semibold))
            .kerning(size * 0.16)   // web --tracking-overline (0.16em)
            .foregroundStyle(color)
            .lineLimit(1)
    }
}

// MARK: - Metric (every number a user reads as a measurement)

/// Mono tabular value with the unit dimmed to tertiary at ~80% size — the
/// number leads. Built from concatenated `Text` so baseline alignment,
/// truncation, and `minimumScaleFactor` keep working at call sites.
struct MetricText: View {
    let value: String
    var unit: String?
    var size: CGFloat = 15
    var weight: Font.Weight = .semibold
    var color: Color = .primary
    var unitColor: Color = .textTertiary

    init(
        _ value: String,
        unit: String? = nil,
        size: CGFloat = 15,
        weight: Font.Weight = .semibold,
        color: Color = .primary,
        unitColor: Color = .textTertiary
    ) {
        self.value = value
        self.unit = unit
        self.size = size
        self.weight = weight
        self.color = color
        self.unitColor = unitColor
    }

    var body: some View {
        var text = Text(value)
            .font(AppFont.mono(size, weight))
            .foregroundStyle(color)
        if let unit {
            text = text + Text("\u{2009}\(unit)")
                .font(AppFont.mono(size * 0.8, .regular))
                .foregroundStyle(unitColor)
        }
        return text.lineLimit(1)
    }
}

// MARK: - Over-map labels (text on imagery always gets protection)

/// Scrim pill for a numeric label over map imagery: dark readout fill +
/// blur, pill radius, overlay text — never raw text on the map.
struct MapLabelPill: View {
    let value: String
    var unit: String?
    var size: CGFloat = 12

    init(_ value: String, unit: String? = nil, size: CGFloat = 12) {
        self.value = value
        self.unit = unit
        self.size = size
    }

    var body: some View {
        MetricText(
            value, unit: unit, size: size,
            color: Overlay.text, unitColor: Overlay.textMuted
        )
        .mapLabelScrim()
    }
}

extension View {
    /// The scrim-pill treatment for arbitrary over-map content (compound
    /// chips, icon + value rows). Sets the overlay default text color;
    /// explicit inner styles still win.
    func mapLabelScrim() -> some View {
        foregroundStyle(Overlay.text)
            .padding(.horizontal, Space.s3)
            .padding(.vertical, 6)
            .background(Overlay.readoutFill, in: Capsule())
            .background(.ultraThinMaterial, in: Capsule())
    }

    /// Round over-map control fill (the zoom/tool button stack): warm
    /// control fill over blur instead of the bare system material.
    func mapControl() -> some View {
        background(Overlay.controlFill, in: Circle())
            .background(.ultraThinMaterial, in: Circle())
    }
}

// MARK: - Buttons (one clay action per view, everything else quiet)

/// The single clay primary action of a view.
struct PrimaryButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(AppFont.sans(15, .semibold))
            .foregroundStyle(Color.onAccent)
            .padding(.vertical, Space.s3)
            .padding(.horizontal, Space.s4)
            .background(
                configuration.isPressed ? Color.accentPress : Color.accentPrimary,
                in: RoundedRectangle(cornerRadius: Radius.sm, style: .continuous)
            )
            .opacity(isEnabled ? 1 : 0.4)
            .animation(Motion.fast, value: configuration.isPressed)
    }
}

/// Quiet secondary action: raised surface + default border.
struct SecondaryButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        let shape = RoundedRectangle(cornerRadius: Radius.sm, style: .continuous)
        configuration.label
            .font(AppFont.sans(15, .medium))
            .foregroundStyle(Color.textPrimary)
            .padding(.vertical, Space.s3)
            .padding(.horizontal, Space.s4)
            .background(
                configuration.isPressed ? Color.surfaceSunken : Color.surfaceRaised,
                in: shape
            )
            .overlay(shape.strokeBorder(Color.borderDefault, lineWidth: 1))
            .opacity(isEnabled ? 1 : 0.4)
            .animation(Motion.fast, value: configuration.isPressed)
    }
}

// MARK: - Selected state (tint + inset ring, not a heavy border)

extension View {
    /// The guide's selected-row treatment: 12% accent fill + a 1.5pt inset
    /// accent ring (`strokeBorder` insets by nature).
    func selectedState(_ isSelected: Bool, cornerRadius: CGFloat = Radius.sm) -> some View {
        let shape = RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
        return background(shape.fill(Color.accentPrimary.opacity(isSelected ? 0.12 : 0)))
            .overlay(
                shape.strokeBorder(
                    Color.accentPrimary.opacity(isSelected ? 1 : 0), lineWidth: 1.5
                )
            )
    }
}
