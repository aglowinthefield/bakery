import SwiftUI

struct TodayView: View {
    @EnvironmentObject private var store: AppStore
    @State private var openCard: CardRoute?
    @State private var title = ""
    @State private var boardId = ""
    @State private var adding = false
    @State private var reviewQueue: [CardRoute] = []

    private var cards: [Card] { store.allCards }
    private var needsYou: [Card] {
        cards.filter { $0.needsYourReview || $0.status == .failed || $0.status == .interrupted }.sorted { $0.updatedAt < $1.updatedAt }
    }
    private var inProgress: [Card] { cards.filter { $0.status == .running || ($0.status == .review && $0.reviewWait != nil) } }
    private var merged: [Card] { cards.filter { $0.status == .done && Calendar.current.isDateInToday(ISO.parse($0.updatedAt) ?? .distantPast) } }
    private var cost24h: Double { store.boards.reduce(0) { $0 + ($1.cost24h ?? 0) } }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                Text(Date.now.formatted(.dateTime.weekday(.wide).month(.wide).day()).uppercased())
                    .font(.ui(11, .medium)).tracking(2).foregroundStyle(T.mutedFg)
                Text("Today").font(.ui(32, .bold)).tracking(-1.5).padding(.top, 6)
                Text("\(merged.count) merged · \(needsYou.count) need you · \(Format.cost(cost24h)) in the last 24h")
                    .font(.ui(14)).foregroundStyle(T.mutedFg).padding(.top, 8)

                capture.padding(.top, 24)
                section("Needs you", needsYou, empty: "All caught up. Nothing needs you.") {
                    let reviewable = needsYou.filter(\.needsYourReview)
                    if reviewable.count > 1 {
                        Button {
                            if let first = reviewable.first { openCard = CardRoute(boardId: store.board(forRepo: first.repo)?.id ?? "", cardId: first.id) }
                        } label: { Label("Review \(reviewable.count) cards", systemImage: "eye") }
                        .buttonStyle(.pill(.primary)).padding(.bottom, 12)
                    }
                }
                if !inProgress.isEmpty { section("In progress", inProgress, empty: "") { EmptyView() } }
                if !merged.isEmpty { section("Finished today", merged, empty: "") { EmptyView() } }
            }
            .padding(.horizontal, 20).padding(.top, 24).padding(.bottom, 60)
            .frame(maxWidth: 768).frame(maxWidth: .infinity)
        }
        .screenBackground()
        .navigationBarTitleDisplayMode(.inline)
        .onAppear { store.watchingToday = true; store.watchedBoard = nil; Task { await store.refresh() } }
        .onDisappear { store.watchingToday = false }
        .refreshable { await store.refresh() }
        .sheet(item: $openCard) { route in CardDetailSheet(route: route) }
    }

    private var capture: some View {
        HStack(spacing: 8) {
            TextField("What needs doing?", text: $title)
                .padding(.horizontal, 12).frame(height: 40)
                .overlay(RoundedRectangle(cornerRadius: 7.5).stroke(T.foreground.opacity(0.85), lineWidth: 1.5))
                .submitLabel(.send).onSubmit { Task { await add() } }
            Menu {
                Picker("Repository", selection: $boardId) { ForEach(store.boards) { Text($0.name).tag($0.id) } }
            } label: {
                HStack(spacing: 4) {
                    Text(store.board(boardId)?.name ?? store.boards.first?.name ?? "—").lineLimit(1)
                    Image(systemName: "chevron.down").font(.system(size: 10))
                }
                .font(.ui(14)).foregroundStyle(T.foreground).padding(.horizontal, 10).frame(height: 40)
                .overlay(RoundedRectangle(cornerRadius: 7.5).stroke(T.foreground.opacity(0.85), lineWidth: 1.5))
            }
            Button("Add") { Task { await add() } }
                .buttonStyle(.pill).disabled(title.trimmingCharacters(in: .whitespaces).isEmpty || adding)
        }
    }

    private func add() async {
        guard let api = store.api, let board = store.board(boardId) ?? store.boards.first else { return }
        let text = title.trimmingCharacters(in: .whitespaces)
        guard !text.isEmpty else { return }
        adding = true
        struct Body: Encodable { let title: String; let body: String; let origin: String }
        if await store.act({ let _: Card = try await api.post("/boards/\(board.id)/cards", Body(title: text, body: "", origin: "ui")) }) {
            title = ""; store.show("Added to \(board.name) Triage")
            if let t = store.toast { store.toast = nil; store.toast = t }
        }
        adding = false
    }

    @ViewBuilder private func section<Extra: View>(_ name: String, _ items: [Card], empty: String, @ViewBuilder extra: () -> Extra) -> some View {
        SectionLabel(text: name).padding(.top, 36).padding(.bottom, 12)
        extra()
        if items.isEmpty {
            if !empty.isEmpty { Text(empty).font(.ui(14)).foregroundStyle(T.mutedFg) }
        } else {
            VStack(spacing: 0) {
                ForEach(Array(items.enumerated()), id: \.element.id) { index, card in
                    if index > 0 { Divider().overlay(T.border.opacity(0.7)) }
                    Button { openCard = CardRoute(boardId: store.board(forRepo: card.repo)?.id ?? "", cardId: card.id) } label: {
                        row(card)
                    }
                    .buttonStyle(.plain)
                }
            }
            .background(T.card, in: RoundedRectangle(cornerRadius: 13.5))
            .overlay(RoundedRectangle(cornerRadius: 13.5).stroke(T.border.opacity(0.8)))
        }
    }

    private func row(_ card: Card) -> some View {
        let board = store.board(forRepo: card.repo)
        return HStack(spacing: 12) {
            RepoBadge(icon: board?.icon, color: board?.color, size: 32)
            VStack(alignment: .leading, spacing: 2) {
                Text(card.title).font(.ui(14, .medium)).foregroundStyle(T.foreground).multilineTextAlignment(.leading).lineLimit(2)
                Text("\(card.repoName) · \(card.status.label) \(Format.date(card.updatedAt))").font(.ui(12)).foregroundStyle(T.mutedFg)
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 14).padding(.vertical, 12).contentShape(Rectangle())
    }
}

struct CardRoute: Identifiable, Hashable {
    let boardId: String
    let cardId: String
    var id: String { cardId }
}
