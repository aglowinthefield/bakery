import SwiftUI
import UIKit

// Palette from src/style.css: dark is the web default theme, light its twin. Colours follow the system appearance.
extension Color {
    init(hex: UInt32) {
        self.init(.sRGB, red: Double((hex >> 16) & 0xff) / 255, green: Double((hex >> 8) & 0xff) / 255, blue: Double(hex & 0xff) / 255)
    }
    init(light: UInt32, dark: UInt32) {
        self.init(UIColor { trait in
            let h = trait.userInterfaceStyle == .dark ? dark : light
            return UIColor(red: CGFloat((h >> 16) & 0xff) / 255, green: CGFloat((h >> 8) & 0xff) / 255, blue: CGFloat(h & 0xff) / 255, alpha: 1)
        })
    }
}

enum T {
    static let background = Color(light: 0xf5f3ee, dark: 0x1a1d21)
    static let foreground = Color(light: 0x242a30, dark: 0xf0efeb)
    static let card = Color(light: 0xffffff, dark: 0x22262b)
    static let popover = Color(light: 0xffffff, dark: 0x282c34)
    static let primary = Color(light: 0x554b36, dark: 0xd4ccb4)
    static let primaryFg = Color(light: 0xffffff, dark: 0x1a1d21)
    static let secondary = Color(light: 0xeae7e0, dark: 0x282c34)
    static let muted = Color(light: 0xeae7e0, dark: 0x282c34)
    static let mutedFg = Color(light: 0x555e66, dark: 0x8b919a)
    static let accent = Color(light: 0xded9cf, dark: 0x3d424a)
    static let destructive = Color(light: 0x9d3038, dark: 0xcdacac)
    static let border = Color(light: 0xccc8be, dark: 0x3d424a)
    static let sidebar = Color(light: 0xeeebe4, dark: 0x171a1e)
    static let code = Color(light: 0xeeebe4, dark: 0x171a1e)
    static let diffAdd = Color(light: 0xe1f2e6, dark: 0x193529)
    static let diffAddFg = Color(light: 0x184a30, dark: 0xb6e5c5)
    static let diffRemove = Color(light: 0xfae6e7, dark: 0x3b2528)
    static let diffRemoveFg = Color(light: 0x882b34, dark: 0xf0b5b5)

    static let amber = Color(hex: 0xf59e0b)
    static let amberDeep = Color(hex: 0xd97706)
    static let emerald = Color(hex: 0x10b981)
    static let sky = Color(hex: 0x0ea5e9)
    static let violet = Color(hex: 0x8b5cf6)
    static let red = Color(hex: 0xf87171)
    static let orange = Color(hex: 0xfb923c)
    static let quiet = Color(hex: 0xd99a3a)

    static func status(_ s: CardStatus) -> Color {
        switch s {
        case .triage: Color(light: 0x626b72, dark: 0x8b919a)
        case .ready: Color(light: 0x554b36, dark: 0xd4ccb4)
        case .running: Color(light: 0x45627c, dark: 0xb4bcc4)
        case .review: Color(light: 0x38684a, dark: 0xb8c4b8)
        case .failed: Color(light: 0x9d3038, dark: 0xcdacac)
        case .interrupted: Color(light: 0x926621, dark: 0xc6ad89)
        case .done: Color(light: 0x626b72, dark: 0x9aa59d)
        case .archived: Color(light: 0x5e5675, dark: 0xaba5bd)
        case .unknown: Color(light: 0x626b72, dark: 0x8b919a)
        }
    }

    static func priority(_ p: Int) -> Color {
        p >= 90 ? red : p >= 50 ? orange : p > 0 ? Color(hex: 0xfbbf24) : mutedFg
    }

    /// Board colours (dark / light) from src/style.css:65-74.
    static func repoColor(_ name: String?) -> Color {
        let table: [String: (UInt32, UInt32)] = [
            "violet": (0x7c5cc4, 0xa78bfa), "coral": (0xd2455f, 0xfb7185), "amber": (0xb7791f, 0xfbbf24),
            "lime": (0x5f8a14, 0xa3e635), "mint": (0x1f9d6a, 0x34d399), "teal": (0x0f8f86, 0x2dd4bf),
            "sky": (0x1479b5, 0x38bdf8), "blue": (0x2f66c4, 0x60a5fa), "pink": (0xc2377f, 0xf472b6),
            "slate": (0x5b6778, 0x94a3b8),
        ]
        let v = table[name ?? ""] ?? table["violet"]!
        return Color(light: v.0, dark: v.1)
    }
}

extension Font {
    static func ui(_ size: CGFloat, _ weight: Font.Weight = .regular) -> Font { .system(size: size, weight: weight) }
    static func mono(_ size: CGFloat, _ weight: Font.Weight = .regular) -> Font { .system(size: size, weight: weight, design: .monospaced) }
}

/// The 10 pt uppercase badge the web tiles use.
struct Badge: View {
    let text: String
    var icon: String?
    var color: Color = T.mutedFg
    var filled = false
    var mono = false

    var body: some View {
        HStack(spacing: 4) {
            if let icon { Image(systemName: icon).font(.system(size: 9, weight: .semibold)) }
            Text(text).font(mono ? .mono(10, .medium) : .ui(10, .medium)).tracking(1).textCase(.uppercase)
        }
        .foregroundStyle(filled ? T.background : color)
        .padding(.horizontal, 7).padding(.vertical, 3)
        .background(filled ? color : color.opacity(0.1), in: RoundedRectangle(cornerRadius: 4))
        .overlay(RoundedRectangle(cornerRadius: 4).stroke(filled ? .clear : color.opacity(0.4), lineWidth: 1))
        .lineLimit(1)
    }
}

struct SectionLabel: View {
    let text: String
    var body: some View {
        Text(text).font(.ui(11, .semibold)).tracking(2).textCase(.uppercase).foregroundStyle(T.mutedFg)
    }
}

/// bakery. wordmark with the primary-coloured dot.
struct Wordmark: View {
    var size: CGFloat = 18
    var body: some View {
        (Text("bakery").foregroundStyle(T.foreground) + Text(".").foregroundStyle(T.primary))
            .font(.ui(size, .semibold)).tracking(-size * 0.04)
    }
}

struct PillButtonStyle: ButtonStyle {
    enum Kind { case primary, outline, destructive, ghost }
    var kind: Kind = .primary
    @Environment(\.isEnabled) private var enabled
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.ui(14, .medium))
            .padding(.horizontal, 14).frame(minHeight: 36)
            .foregroundStyle(fg)
            .background(bg, in: RoundedRectangle(cornerRadius: 7.5))
            .overlay(RoundedRectangle(cornerRadius: 7.5).stroke(kind == .outline ? T.border : .clear))
            .opacity(enabled ? (configuration.isPressed ? 0.8 : 1) : 0.45)
    }
    private var fg: Color {
        switch kind {
        case .primary: T.primaryFg
        case .outline, .ghost: T.foreground
        case .destructive: T.background
        }
    }
    private var bg: Color {
        switch kind {
        case .primary: T.primary
        case .outline: T.background
        case .destructive: T.destructive
        case .ghost: .clear
        }
    }
}

extension ButtonStyle where Self == PillButtonStyle {
    static var pill: PillButtonStyle { .init() }
    static func pill(_ k: PillButtonStyle.Kind) -> PillButtonStyle { .init(kind: k) }
}
