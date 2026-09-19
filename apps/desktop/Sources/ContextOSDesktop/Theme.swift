import AppKit
import SwiftUI

enum ContextOSTheme {
    // Dynamic modern semantic colors supporting both Light and Dark modes
    static func dynamicColor(light: NSColor, dark: NSColor) -> Color {
        Color(nsColor: NSColor(name: nil, dynamicProvider: { appearance in
            let match = appearance.bestMatch(from: [.darkAqua, .aqua])
            return match == .darkAqua ? dark : light
        }))
    }

    // Pure white canvas in light mode, sleek dark in dark mode
    static var canvas: Color {
        dynamicColor(
            light: NSColor.white,                                                  // #FFFFFF Pure White
            dark: NSColor(white: 0.10, alpha: 1.0)                                 // Deep Dark
        )
    }

    // Pure white surface (sidebar, headers, drawers)
    static var surface: Color {
        dynamicColor(
            light: NSColor.white,                                                  // #FFFFFF Pure White
            dark: NSColor(white: 0.13, alpha: 1.0)                                 // Elevated Dark
        )
    }

    // Pure crisp white card background
    static var cardBackground: Color {
        dynamicColor(
            light: NSColor.white,                                                  // #FFFFFF Pure White
            dark: NSColor(white: 0.17, alpha: 1.0)                                 // Card Dark
        )
    }

    static var cardGhostBackground: Color {
        dynamicColor(
            light: NSColor.white.withAlphaComponent(0.82),
            dark: NSColor(white: 0.13, alpha: 0.82)
        )
    }

    static var ink: Color { Color(nsColor: NSColor.labelColor) }
    static var muted: Color { Color(nsColor: NSColor.secondaryLabelColor) }

    // Pure neutral light hairline border (strictly 0% saturation / zero blue tint)
    static var hairline: Color {
        dynamicColor(
            light: NSColor(white: 0.89, alpha: 1.0),                               // #E3E3E3 Neutral Light Gray
            dark: NSColor(white: 0.25, alpha: 1.0)                                 // #404040
        )
    }

    static var focus: Color { Color(nsColor: NSColor.controlAccentColor) }
    static var success: Color { Color(nsColor: NSColor.systemGreen) }
    static var pending: Color { Color(nsColor: NSColor.systemOrange) }
    static var failure: Color { Color(nsColor: NSColor.systemRed) }
    static var unstable: Color { Color(nsColor: NSColor.systemPurple) }

    static func healthColor(_ state: String) -> Color {
        switch state {
        case "healthy": success
        case "warning": pending
        case "failing": failure
        case "unstable", "disputed": unstable
        default: muted.opacity(0.55)
        }
    }

    static func deliveryColor(_ state: String) -> Color {
        switch state {
        case "complete": success
        case "implementing": focus
        case "verifying": pending
        case "deprecated": muted.opacity(0.35)
        case "planned": Color(nsColor: NSColor.systemIndigo)
        default: muted.opacity(0.6)
        }
    }

    static func planColor(_ status: String) -> Color {
        switch status {
        case "complete": success
        case "active": focus
        case "verifying", "ready": pending
        case "blocked", "failed": failure
        case "retest_required": Color(nsColor: NSColor.systemOrange)
        case "cancelled": muted.opacity(0.35)
        default: muted.opacity(0.65)
        }
    }

    static func linkKindColor(_ kind: String) -> Color {
        switch kind {
        case "flows_to": Color(nsColor: NSColor.systemGray)
        case "calls": Color(nsColor: NSColor.systemBlue)
        case "reads": Color(nsColor: NSColor.systemTeal)
        case "writes": Color(nsColor: NSColor.systemOrange)
        case "depends_on": Color(nsColor: NSColor.systemPurple)
        case "implements": Color(nsColor: NSColor.systemGreen)
        case "validates": Color(nsColor: NSColor.systemIndigo)
        case "constrains": Color(nsColor: NSColor.systemBrown)
        case "supersedes": Color(nsColor: NSColor.systemRed)
        default: muted
        }
    }

    static func checkpointColor(_ status: String) -> Color {
        switch status {
        case "passed": success
        case "partial_pass": pending
        case "running": focus
        case "failed": failure
        case "blocked": unstable
        case "retest_required": Color(nsColor: NSColor.systemOrange)
        default: muted
        }
    }

    static var chainPalette: [Color] {
        [
            focus,
            Color(nsColor: NSColor.systemOrange),
            success,
            Color(nsColor: NSColor.systemPurple),
            failure,
            Color(nsColor: NSColor.systemTeal),
            Color(nsColor: NSColor.systemPink),
            Color(nsColor: NSColor.systemBrown),
            Color(nsColor: NSColor.systemIndigo),
            Color(nsColor: NSColor.systemYellow),
            Color(nsColor: NSColor.systemBlue),
            Color(nsColor: NSColor.systemMint),
        ]
    }

    static func chainColor(index: Int) -> Color {
        chainPalette[index % chainPalette.count]
    }

    static func blockKindColor(_ kind: String) -> Color {
        switch kind {
        case "ui", "flow": Color(nsColor: NSColor.systemBlue)
        case "service": Color(nsColor: NSColor.systemGreen)
        case "function": Color(nsColor: NSColor.systemTeal)
        case "integration": Color(nsColor: NSColor.systemPurple)
        case "data": Color(nsColor: NSColor.systemOrange)
        case "database": Color(nsColor: NSColor.systemPink)
        case "test", "checkpoint": Color(nsColor: NSColor.systemIndigo)
        case "risk": failure
        case "principle", "decision", "requirement", "product": Color(nsColor: NSColor.systemBrown)
        default: muted
        }
    }
}
