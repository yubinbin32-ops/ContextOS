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

    // Modern crisp canvas: clean subtle slate in light mode, deep sleek slate in dark mode
    static var canvas: Color {
        dynamicColor(
            light: NSColor(srgbRed: 0.965, green: 0.970, blue: 0.978, alpha: 1.0), // #F6F7FA
            dark: NSColor(srgbRed: 0.055, green: 0.063, blue: 0.082, alpha: 1.0)   // #0E1015
        )
    }

    // Modern surface (sidebar, headers, drawers): clean elevated background
    static var surface: Color {
        dynamicColor(
            light: NSColor(srgbRed: 0.945, green: 0.952, blue: 0.962, alpha: 1.0), // #F1F3F6
            dark: NSColor(srgbRed: 0.082, green: 0.094, blue: 0.122, alpha: 1.0)   // #15181F
        )
    }

    // Card background: pure crisp white in light mode, rich elevated card in dark mode
    static var cardBackground: Color {
        dynamicColor(
            light: NSColor.white,                                                  // #FFFFFF
            dark: NSColor(srgbRed: 0.114, green: 0.129, blue: 0.165, alpha: 1.0)   // #1D212A
        )
    }

    static var cardGhostBackground: Color {
        dynamicColor(
            light: NSColor(srgbRed: 0.98, green: 0.98, blue: 0.99, alpha: 0.72),
            dark: NSColor(srgbRed: 0.09, green: 0.10, blue: 0.13, alpha: 0.72)
        )
    }

    static var ink: Color { Color(nsColor: NSColor.labelColor) }
    static var muted: Color { Color(nsColor: NSColor.secondaryLabelColor) }

    static var hairline: Color {
        dynamicColor(
            light: NSColor(srgbRed: 0.880, green: 0.895, blue: 0.915, alpha: 1.0), // #E0E4EA
            dark: NSColor(srgbRed: 0.170, green: 0.190, blue: 0.240, alpha: 1.0)   // #2B303D
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
