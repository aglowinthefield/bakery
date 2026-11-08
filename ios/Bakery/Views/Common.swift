import SwiftUI

/// 32 pt tile with the board's pixel icon on a tint of its colour (src/repo-badge.tsx).
struct RepoBadge: View {
    let icon: String?
    let color: String?
    var size: CGFloat = 32

    var body: some View {
        let name = icon ?? "sprinkle_donut"
        ZStack {
            RoundedRectangle(cornerRadius: size * 0.31).fill(T.repoColor(color).opacity(0.16))
            if let image = Self.image(name) {
                Image(uiImage: image).interpolation(.none).resizable().scaledToFit().padding(size * 0.15)
            }
        }
        .frame(width: size, height: size)
    }

    static func image(_ name: String) -> UIImage? {
        for n in [name, "sprinkle_donut"] {
            if let path = Bundle.main.path(forResource: n, ofType: "png", inDirectory: "Icons") { return UIImage(contentsOfFile: path) }
        }
        return nil
    }
}

struct BrandIcon: View {
    var size: CGFloat = 36
    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: size * 0.28).fill(T.card)
            RoundedRectangle(cornerRadius: size * 0.28).stroke(T.border)
            if let image = RepoBadge.image("sprinkle_donut") {
                Image(uiImage: image).interpolation(.none).resizable().scaledToFit().padding(size * 0.15)
            }
        }
        .frame(width: size, height: size)
    }
}

struct StatusDot: View {
    let color: Color
    var size: CGFloat = 10
    var body: some View { Circle().fill(color).frame(width: size, height: size) }
}

/// Counts strip under a board name: backlog, in progress, review, failed.
struct BoardCounts: View {
    let board: Board
    var body: some View {
        HStack(spacing: 12) {
            item("checklist", board.backlogCount, T.status(.ready))
            item("circle.dotted", board.inProgressCount, T.status(.running))
            item("eye", board.reviewCount, T.status(.review))
            if board.failedCount > 0 { item("xmark.circle", board.failedCount, T.status(.failed)) }
        }
    }
    private func item(_ icon: String, _ n: Int, _ color: Color) -> some View {
        HStack(spacing: 3) {
            Image(systemName: icon).font(.system(size: 10))
            Text("\(n)").font(.mono(12))
        }
        .foregroundStyle(n == 0 ? T.mutedFg.opacity(0.6) : color)
    }
}

struct Toast: View {
    let message: String
    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: "xmark.circle").foregroundStyle(T.destructive)
            VStack(alignment: .leading, spacing: 2) {
                Text("Action failed").font(.ui(14, .semibold))
                Text(message).font(.ui(13)).foregroundStyle(T.mutedFg)
            }
            Spacer(minLength: 0)
        }
        .padding(12)
        .frame(maxWidth: 420, alignment: .leading)
        .background(T.popover, in: RoundedRectangle(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).stroke(T.border))
        .shadow(color: .black.opacity(0.25), radius: 12, y: 4)
        .padding(.horizontal, 16).padding(.bottom, 12)
    }
}

struct ErrorBox: View {
    let title: String
    var message: String?
    var color: Color = T.destructive
    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title).font(.ui(14, .semibold)).foregroundStyle(color)
            if let message, !message.isEmpty { Text(message).font(.ui(13)).foregroundStyle(T.foreground.opacity(0.85)) }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12)
        .background(color.opacity(0.1), in: RoundedRectangle(cornerRadius: 7.5))
        .overlay(RoundedRectangle(cornerRadius: 7.5).stroke(color.opacity(0.4)))
    }
}

struct Bordered<Content: View>: View {
    var padding: CGFloat = 12
    var fill: Color = T.card
    @ViewBuilder var content: Content
    var body: some View {
        content.padding(padding)
            .background(fill, in: RoundedRectangle(cornerRadius: 10))
            .overlay(RoundedRectangle(cornerRadius: 10).stroke(T.border.opacity(0.8)))
    }
}

extension View {
    func screenBackground() -> some View { background(T.background.ignoresSafeArea()) }
}
