import AppKit
import SwiftUI

enum MdflowTheme {
    // AppKit semantic colors resolve against the window's light/dark
    // appearance, so the Canvas keeps one canonical project projection.
    static let canvas = Color(nsColor: NSColor.controlBackgroundColor)
    static let surface = Color(nsColor: NSColor.windowBackgroundColor)
    static let ink = Color(nsColor: NSColor.labelColor)
    static let muted = Color(nsColor: NSColor.secondaryLabelColor)
    static let hairline = Color(nsColor: NSColor.separatorColor)
    static let focus = Color(nsColor: NSColor.controlAccentColor)
    static let success = Color(nsColor: NSColor.systemGreen)
    static let pending = Color(nsColor: NSColor.systemOrange)
    static let failure = Color(nsColor: NSColor.systemRed)
    static let unstable = Color(nsColor: NSColor.systemPurple)

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

    static let chainPalette: [Color] = [
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
