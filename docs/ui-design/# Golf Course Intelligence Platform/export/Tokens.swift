//  Tokens.swift
//  Golf Intel — Design Tokens · v0.1 · "Links & Loam"
//  iOS / SwiftUI
//
//  Semantic names match the web tokens 1:1 (only casing differs):
//      web  --color-text-primary   ↔   iOS  Color.textPrimary
//      web  --space-4              ↔   iOS  Space.s4
//      web  --radius-md            ↔   iOS  Radius.md
//
//  Light/dark resolve automatically via UITraitCollection — no asset
//  catalog required. Map + data-viz colors are theme-independent.

import SwiftUI

// MARK: - Hex + dynamic helpers

extension Color {
    init(hex: String) {
        let s = hex.trimmingCharacters(in: CharacterSet(charactersIn: "#"))
        var v: UInt64 = 0
        Scanner(string: s).scanHexInt64(&v)
        let r, g, b, a: Double
        if s.count == 8 {
            r = Double((v >> 24) & 0xFF) / 255; g = Double((v >> 16) & 0xFF) / 255
            b = Double((v >> 8)  & 0xFF) / 255; a = Double(v & 0xFF) / 255
        } else {
            r = Double((v >> 16) & 0xFF) / 255; g = Double((v >> 8) & 0xFF) / 255
            b = Double(v & 0xFF) / 255;        a = 1
        }
        self.init(.sRGB, red: r, green: g, blue: b, opacity: a)
    }

    /// Resolves per light/dark appearance.
    static func dynamic(light: String, dark: String) -> Color {
        Color(UIColor { tc in
            tc.userInterfaceStyle == .dark ? UIColor(Color(hex: dark)) : UIColor(Color(hex: light))
        })
    }
    static func dynamic(light: Color, dark: Color) -> Color {
        Color(UIColor { tc in
            tc.userInterfaceStyle == .dark ? UIColor(dark) : UIColor(light)
        })
    }
}

// MARK: - Semantic color tokens (light / dark)

extension Color {
    // text
    static let textPrimary   = Color.dynamic(light: "#211D14", dark: "#F1EADB")
    static let textSecondary = Color.dynamic(light: "#55503F", dark: "#C4BBA6")
    static let textTertiary  = Color.dynamic(light: "#8B8471", dark: "#94896F")
    static let textDisabled  = Color.dynamic(light: "#B4AC98", dark: "#5F5847")
    static let textAccent    = Color.dynamic(light: "#A6572F", dark: "#E08A4E")
    static let textInverse   = Color.dynamic(light: "#F6F1E7", dark: "#16130D")
    // surface
    static let surfaceApp    = Color.dynamic(light: "#F6F1E7", dark: "#16130D")
    static let surfaceSunken = Color.dynamic(light: "#EDE4D2", dark: "#100E09")
    static let surfaceCard   = Color.dynamic(light: "#FBF8F1", dark: "#221D15")
    static let surfaceRaised = Color.dynamic(light: "#FFFFFF", dark: "#2C2519")
    static let surfaceBrand  = Color(hex: "#1E2B22")
    // border
    static let borderSubtle  = Color.dynamic(light: "#E8E0CF", dark: "#2C2517")
    static let borderDefault = Color.dynamic(light: "#DDD0B4", dark: "#3A3122")
    static let borderStrong  = Color.dynamic(light: "#C9B899", dark: "#4A4033")
    static let borderFocus   = Color.dynamic(light: "#BF6A3E", dark: "#D2793F")
    // accent / action
    static let accentPrimary   = Color.dynamic(light: "#BF6A3E", dark: "#D2793F")
    static let accentHover     = Color.dynamic(light: "#A6572F", dark: "#E08A4E")
    static let accentPress     = Color.dynamic(light: "#8F4A28", dark: "#BF6A3E")
    static let onAccent        = Color.dynamic(light: "#FBF3E8", dark: "#1C130B")
    static let accentSecondary = Color.dynamic(light: "#5C6B4A", dark: "#7E9159")
    static let accentData      = Color.dynamic(light: "#C68A2E", dark: "#E6C08A")
    // status
    static let statusPositive = Color.dynamic(light: "#4E7A46", dark: "#7BA36A")
    static let statusCaution  = Color.dynamic(light: "#C68A2E", dark: "#E6B355")
    static let statusNegative = Color.dynamic(light: "#B24A32", dark: "#E07C5E")
    static let statusInfo     = Color.dynamic(light: "#3E7E92", dark: "#6BB6C9")
}

// MARK: - Map overlay (chrome on imagery)

enum Overlay {
    static let panelFill        = Color.dynamic(light: "#F6F1E7D1", dark: "#1C1810BD")  // .82 / .74
    static let panelStroke      = Color.dynamic(light: "#FFFFFF8C", dark: "#96876947")  // .55 / .28
    static let readoutFill      = Color.dynamic(light: "#1E2B22E6", dark: "#1C1810D6")  // .90 / .84
    static let scrim            = Color.dynamic(light: "#14110B73", dark: "#08060399")  // .45 / .60
    static let text             = Color.white
    static let textMuted        = Color.dynamic(light: "#FFFFFFB8", dark: "#F1EADBA6")
    static let controlFill      = Color.dynamic(light: "#F6F1E7EB", dark: "#1C1810D1")
    static let dispersionFill   = Color(hex: "#BF6A3E24")                                // .14
    static let dispersionStroke = Color.dynamic(light: "#E6D8BE", dark: "#E6C08A")
    static let panelBlur: CGFloat = 14   // dark: 16
}

// MARK: - Course cartography (SVG feature shapes, theme-independent)

enum MapFeature {
    struct Style { let fill, draw, outline: Color }
    static let green        = Style(fill: Color(hex: "#7FC489"), draw: Color(hex: "#97D79B"), outline: Color(hex: "#3F7A55"))
    static let tee          = Style(fill: Color(hex: "#5FA76E"), draw: Color(hex: "#6FC07E"), outline: Color(hex: "#34734A"))
    static let fairway      = Style(fill: Color(hex: "#4C9256"), draw: Color(hex: "#4FA85E"), outline: Color(hex: "#2C6B3B"))
    static let semiRough    = Style(fill: Color(hex: "#7E9E56"), draw: Color(hex: "#8FB157"), outline: Color(hex: "#4C6E37"))
    static let rough        = Style(fill: Color(hex: "#566E3A"), draw: Color(hex: "#5F7C34"), outline: Color(hex: "#384E23"))
    static let deepRough    = Style(fill: Color(hex: "#3C5730"), draw: Color(hex: "#3E5A28"), outline: Color(hex: "#26381C"))
    static let trees        = Style(fill: Color(hex: "#24402B"), draw: Color(hex: "#1E3C26"), outline: Color(hex: "#142619"))
    static let bunker       = Style(fill: Color(hex: "#E1CC93"), draw: Color(hex: "#ECD588"), outline: Color(hex: "#B0894A"))
    static let water        = Style(fill: Color(hex: "#4C8FBE"), draw: Color(hex: "#3E93D0"), outline: Color(hex: "#2E6389"))
    static let waterCreek   = Style(fill: Color(hex: "#77AED2"), draw: Color(hex: "#6FB6E0"), outline: Color(hex: "#3F7BA0"))
    static let penaltyYellow = Style(fill: Color(hex: "#E8CB56"), draw: Color(hex: "#E8CB56"), outline: Color(hex: "#C39A2E"))
    static let penaltyRed   = Style(fill: Color(hex: "#DE6152"), draw: Color(hex: "#DE6152"), outline: Color(hex: "#B0402E"))
    static let oob          = Style(fill: Color(hex: "#EFEAE0"), draw: Color(hex: "#EFEAE0"), outline: Color(hex: "#3A4148"))
    static let path         = Style(fill: Color(hex: "#C2A879"), draw: Color(hex: "#CBAE75"), outline: Color(hex: "#866B47"))
    static let outside      = Style(fill: Color(hex: "#8A8E90"), draw: Color(hex: "#7C8286"), outline: Color(hex: "#565C61"))
}

// MARK: - Data-viz ramps (theme-independent)

enum DataViz {
    static let seqElevation = ["#2E4A3A","#4C6142","#7D8560","#B0A079","#D8C08A","#F1E4C8"].map(Color.init(hex:))
    static let seqHeat      = ["#F6E7D5","#EAC29A","#E0975E","#CC7038","#A6572F","#6E3A1F"].map(Color.init(hex:))
    static let diverging    = ["#3E7E92","#7FA9B2","#C7CBBE","#EDE4D2","#E4A579","#CC7038","#A6572F"].map(Color.init(hex:))
    static let categorical  = ["#BF6A3E","#3E8EA0","#D8A441","#5C6B4A","#5E6D94","#8A5A6E","#6FA8C9","#7A6A50"].map(Color.init(hex:))
    static let good    = Color(hex: "#4E7A46")
    static let neutral = Color(hex: "#9C917A")
    static let risk    = Color(hex: "#C68A2E")
    static let bad     = Color(hex: "#B24A32")
}

// MARK: - Scale

enum Space {
    static let s1: CGFloat = 4;  static let s2: CGFloat = 8;  static let s3: CGFloat = 12
    static let s4: CGFloat = 16; static let s5: CGFloat = 20; static let s6: CGFloat = 24
    static let s8: CGFloat = 32; static let s10: CGFloat = 40; static let s12: CGFloat = 48
    static let s16: CGFloat = 64; static let s20: CGFloat = 80
}

enum Radius {
    static let xs: CGFloat = 4;  static let sm: CGFloat = 8;  static let md: CGFloat = 12
    static let lg: CGFloat = 16; static let xl: CGFloat = 24; static let pill: CGFloat = 999
}

// MARK: - Elevation (dark theme swaps shadow → warm glow)

enum Elevation {
    struct Shadow { let color: Color; let radius, x, y: CGFloat }
    static let e1 = Shadow(color: Color(hex: "#282A1A1F"), radius: 4,  x: 0, y: 2)
    static let e2 = Shadow(color: Color(hex: "#282A1A38"), radius: 14, x: 0, y: 8)
    static let e3 = Shadow(color: Color(hex: "#282A1A80"), radius: 15, x: 0, y: 12)
    static let glow = Shadow(color: Color(hex: "#E6C08A40"), radius: 12, x: 0, y: 0)
}

extension View {
    func elevation(_ s: Elevation.Shadow) -> some View {
        shadow(color: s.color, radius: s.radius, x: s.x, y: s.y)
    }
}

// MARK: - Typography

enum AppFont {
    static func sans(_ size: CGFloat, _ weight: Font.Weight = .regular) -> Font {
        .custom("SchibstedGrotesk", size: size).weight(weight)
    }
    static func mono(_ size: CGFloat, _ weight: Font.Weight = .semibold) -> Font {
        .custom("JetBrainsMono", size: size).weight(weight).monospacedDigit()
    }
    // ramp
    static let displayXL = sans(44, .heavy)
    static let displayL  = sans(34, .bold)
    static let titleL    = sans(26, .bold)
    static let titleM    = sans(20, .semibold)
    static let bodyL     = sans(17, .regular)
    static let bodyM     = sans(15, .regular)
    static let bodyS     = sans(13, .regular)
    static let label     = sans(12, .semibold)
    static let overline  = mono(11, .semibold)
    static let metricXL  = mono(30, .semibold)
    static let metricL   = mono(20, .semibold)
    static let metricM   = mono(15, .semibold)
}

// MARK: - Motion

enum Motion {
    static let instant = Animation.timingCurve(0.2, 0, 0, 1, duration: 0.08)
    static let fast    = Animation.timingCurve(0.2, 0, 0, 1, duration: 0.14)
    static let base    = Animation.timingCurve(0.16, 1, 0.3, 1, duration: 0.22)
    static let slow    = Animation.timingCurve(0.16, 1, 0.3, 1, duration: 0.32)
    static let map     = Animation.timingCurve(0.4, 0, 0.1, 1, duration: 0.48)
}
