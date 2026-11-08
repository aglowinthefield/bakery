import SwiftUI

/// Card tile from src/main.tsx: badge row, two-line title, one-line preview, mono footer.
struct CardTile: View {
    let card: Card
    var waiting = 0
    let onOpen: () -> Void
    @State private var spin = false
    @State private var breathe = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        Button(action: onOpen) {
            VStack(alignment: .leading, spacing: 0) {
                badges
                Text(card.title).font(.ui(13, .medium)).foregroundStyle(T.foreground).lineSpacing(1)
                    .multilineTextAlignment(.leading).lineLimit(2).frame(maxWidth: .infinity, alignment: .leading)
                if let preview = card.preview {
                    Text(preview).font(.ui(12)).foregroundStyle(T.mutedFg).lineLimit(1).padding(.top, 5)
                }
                footer.padding(.top, 14)
            }
            .padding(12)
            .background(T.card, in: RoundedRectangle(cornerRadius: 10))
            .overlay(stripe)
            .overlay(border)
            .contentShape(RoundedRectangle(cornerRadius: 10))
        }
        .buttonStyle(.plain)
        .onAppear {
            guard !reduceMotion else { return }
            withAnimation(.linear(duration: 2.4).repeatForever(autoreverses: false)) { spin = true }
            withAnimation(.easeInOut(duration: 1.6).repeatForever(autoreverses: true)) { breathe = true }
        }
    }

    private var attention: Bool { card.needsYourReview }
    private var failed: Bool { card.status == .failed || card.status == .interrupted }

    @ViewBuilder private var stripe: some View {
        if attention || failed {
            HStack {
                UnevenRoundedRectangle(topLeadingRadius: 10, bottomLeadingRadius: 10)
                    .fill(attention ? T.status(.review) : T.status(.failed)).frame(width: 3)
                Spacer()
            }
        }
    }

    @ViewBuilder private var border: some View {
        let shape = RoundedRectangle(cornerRadius: 10)
        switch card.activity() {
        case .working:
            if reduceMotion { shape.stroke(T.primary, lineWidth: 1.5) } else {
                shape.stroke(T.border.opacity(0.8), lineWidth: 1)
                    .overlay(shape.stroke(AngularGradient(colors: [.clear, .clear, T.primary, .clear], center: .center, angle: .degrees(spin ? 360 : 0)), lineWidth: 2))
            }
        case .waiting:
            shape.stroke(T.status(.review).opacity(reduceMotion ? 0.7 : (breathe ? 0.8 : 0.2)), style: StrokeStyle(lineWidth: 1, dash: reduceMotion ? [3, 3] : []))
        case .quiet: shape.stroke(T.quiet.opacity(0.7), lineWidth: 1)
        case nil:
            shape.stroke(attention ? T.status(.review).opacity(0.7) : T.border.opacity(0.8), lineWidth: 1)
        }
    }

    @ViewBuilder private var badges: some View {
        let items = badgeViews
        if !items.isEmpty { FlowLayout(spacing: 6) { ForEach(items.indices, id: \.self) { items[$0] } }.padding(.bottom, 8) }
    }

    private var badgeViews: [AnyView] {
        var out: [AnyView] = []
        func add(_ v: some View) { out.append(AnyView(v)) }
        if waiting > 0 { add(Badge(text: "Waiting on \(waiting)", color: T.sky)) }
        if let n = card.prNumber {
            let checks = card.prChecks.map { " · \($0)" } ?? ""
            let color: Color = card.prState == "MERGED" ? T.emerald : (card.prState == "CLOSED" || card.prChecks == "failing") ? T.red : T.mutedFg
            add(Badge(text: "PR #\(n)\(checks)", color: color, mono: true))
        }
        if card.status == .done && card.prState != "MERGED" {
            if card.originMain == "pushed" { add(Badge(text: "On origin/main", color: T.emerald)) }
            else if card.locallyMerged == true { add(Badge(text: "Merged locally, not pushed", color: T.amberDeep)) }
        }
        if card.status == .interrupted { add(Badge(text: "Interrupted", icon: "pause.circle", color: T.status(.interrupted))) }
        else if let label = card.reviewWaitLabel {
            add(Badge(text: label, icon: card.activity() == .working ? "arrow.triangle.2.circlepath" : "hourglass", color: T.mutedFg))
        } else if attention {
            let text = card.reviewAction == .pr_ready ? "PR ready" : card.reviewAction == .accept_findings ? "Accept findings" : "Your turn"
            add(Badge(text: text, icon: "eye", color: T.status(.review), filled: true))
        } else if card.activity() == .quiet, let at = card.lastActivityAt.flatMap(ISO.parse) {
            add(Badge(text: "Quiet \(Int(Date.now.timeIntervalSince(at) / 60))m", icon: "pause.circle", color: T.amber))
        }
        if card.attemptCount > 1 { add(Badge(text: "\(card.attemptCount) attempts", icon: "arrow.counterclockwise", color: T.amber)) }
        if card.planOnly == true { add(Badge(text: "Plan", color: T.mutedFg)) }
        if card.startQueued == true { add(Badge(text: "Queued, starts after restart", color: T.amber)) }
        return out
    }

    private var footer: some View {
        HStack(spacing: 10) {
            HStack(spacing: 4) { Image(systemName: "arrow.triangle.branch").font(.system(size: 10)); Text(card.repoName).lineLimit(1) }
            HStack(spacing: 4) {
                Image(systemName: "clock").font(.system(size: 10))
                Text((card.turnsIncomplete ?? 0) == 1 ? "?" : "~\(card.turns ?? 0)")
            }
            if card.priority != 0 {
                Text("\(card.priority > 0 ? "↑" : "↓")\(abs(card.priority))").font(.ui(11)).foregroundStyle(T.priority(card.priority))
            }
            Spacer(minLength: 0)
            Text(Format.ago(card.createdAt))
        }
        .font(.mono(10)).foregroundStyle(T.mutedFg)
    }
}

/// Wrapping row for badges.
struct FlowLayout: Layout {
    var spacing: CGFloat = 6
    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let rows = arrange(proposal.width ?? 300, subviews)
        return CGSize(width: proposal.width ?? rows.maxWidth, height: rows.height)
    }
    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        let rows = arrange(bounds.width, subviews)
        for (i, p) in rows.positions.enumerated() { subviews[i].place(at: CGPoint(x: bounds.minX + p.x, y: bounds.minY + p.y), proposal: .unspecified) }
    }
    private func arrange(_ width: CGFloat, _ subviews: Subviews) -> (positions: [CGPoint], height: CGFloat, maxWidth: CGFloat) {
        var x: CGFloat = 0, y: CGFloat = 0, rowHeight: CGFloat = 0, maxW: CGFloat = 0
        var positions: [CGPoint] = []
        for s in subviews {
            let size = s.sizeThatFits(.unspecified)
            if x + size.width > width, x > 0 { x = 0; y += rowHeight + spacing; rowHeight = 0 }
            positions.append(CGPoint(x: x, y: y))
            x += size.width + spacing; rowHeight = max(rowHeight, size.height); maxW = max(maxW, x - spacing)
        }
        return (positions, y + rowHeight, maxW)
    }
}
