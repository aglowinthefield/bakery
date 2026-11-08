import SwiftUI

struct Lane: Identifiable {
    let id: String
    let title: String
    let icon: String
    let color: Color
    let cards: [Card]
    let status: CardStatus
}

struct BoardScreen: View {
    @EnvironmentObject private var store: AppStore
    let boardId: String
    @State private var tab = 0
    @State private var query = ""
    @State private var sort = CardSort.priority
    @State private var open: CardRoute?
    @State private var composing = false
    @State private var manual: [String: Bool] = [:]

    private var board: Board? { store.board(boardId) }

    var body: some View {
        VStack(spacing: 0) {
            if let board {
                header(board)
                Picker("", selection: $tab) {
                    Text("Kanban").tag(0); Text("Chat").tag(1)
                }
                .pickerStyle(.segmented).padding(.horizontal, 16).padding(.bottom, 8)
                if tab == 0 { kanban(board) } else { ChatScreen(board: board) }
            } else {
                ProgressView().frame(maxHeight: .infinity)
            }
        }
        .screenBackground()
        .navigationBarTitleDisplayMode(.inline)
        .toolbar(.hidden, for: .navigationBar)
        .onAppear { store.watchedBoard = boardId; store.watchingToday = false; Task { await store.refresh() }; launchCard() }
        .onChange(of: boardId) { _, id in store.watchedBoard = id }
        .sheet(item: $open) { CardDetailSheet(route: $0) }
        .sheet(isPresented: $composing) { if let board { NewCardSheet(board: board) } }
    }

    private func launchCard() {
        if let id = UserDefaults.standard.string(forKey: "startCard"), open == nil {
            UserDefaults.standard.removeObject(forKey: "startCard")
            open = CardRoute(boardId: boardId, cardId: id)
        }
    }

    private func header(_ board: Board) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 12) {
                RepoBadge(icon: board.icon, color: board.color, size: 36)
                Text(board.name).font(.ui(26, .semibold)).tracking(-1.2).lineLimit(1)
                Spacer(minLength: 0)
                Button { composing = true } label: { Label("New card", systemImage: "plus") }.buttonStyle(.pill)
            }
            HStack(spacing: 10) {
                if let remote = board.remoteUrl, let url = URL(string: remote) {
                    Link(destination: url) {
                        HStack(spacing: 6) {
                            Image(systemName: "chevron.left.forwardslash.chevron.right").font(.system(size: 11))
                            Text(remote.replacingOccurrences(of: "https://github.com/", with: "")).font(.mono(12)).lineLimit(1)
                            Image(systemName: "arrow.up.right.square").font(.system(size: 11))
                        }
                        .foregroundStyle(T.foreground).padding(.horizontal, 10).padding(.vertical, 5)
                        .overlay(Capsule().stroke(T.border))
                    }
                }
                Label(board.isGitHubPR ? "GitHub pull requests" : "Local main", systemImage: board.isGitHubPR ? "arrow.triangle.pull" : "arrow.triangle.merge")
                    .font(.ui(12)).foregroundStyle(T.mutedFg).lineLimit(1)
            }
            if tab == 0 {
                HStack(spacing: 8) {
                    Image(systemName: "magnifyingglass").font(.system(size: 14)).foregroundStyle(T.mutedFg)
                    TextField("Search cards", text: $query).textInputAutocapitalization(.never).autocorrectionDisabled()
                    if !query.isEmpty {
                        Button { query = "" } label: { Image(systemName: "xmark.circle.fill").foregroundStyle(T.mutedFg) }
                    }
                }
                .padding(.horizontal, 12).frame(height: 38)
                .overlay(RoundedRectangle(cornerRadius: 7.5).stroke(T.foreground.opacity(0.85), lineWidth: 1.5))
            }
        }
        .padding(.horizontal, 16).padding(.top, 8).padding(.bottom, 12)
    }

    // MARK: Kanban

    private func lanes(_ board: Board, _ cards: [Card]) -> [Lane] {
        func pick(_ f: (Card) -> Bool) -> [Card] { sort.sorted(cards.filter(f)) }
        let split = board.isGitHubPR
        var result: [Lane] = [
            Lane(id: "triage", title: "Triage", icon: "tray", color: T.status(.triage), cards: pick { $0.status == .triage }, status: .triage),
            Lane(id: "ready", title: "Ready", icon: "checklist", color: T.status(.ready), cards: pick { $0.status == .ready }, status: .ready),
            Lane(id: "running", title: "Running", icon: "circle.dotted", color: T.status(.running), cards: pick { $0.status == .running }, status: .running),
            Lane(id: "review", title: "Review", icon: "eye", color: T.status(.review),
                 cards: pick { $0.status == .review && (!split || $0.reviewWait == nil) }, status: .review),
        ]
        if split {
            result.append(Lane(id: "agent", title: "Agent reviewing", icon: "cpu", color: T.status(.review),
                               cards: pick { $0.status == .review && ($0.reviewWait == .agent_review || $0.reviewWait == .ci_fix) }, status: .review))
            result.append(Lane(id: "github", title: "Waiting on GitHub", icon: "arrow.triangle.pull", color: T.status(.review),
                               cards: pick { $0.status == .review && $0.reviewWait == .github }, status: .review))
        }
        result += [
            Lane(id: "failed", title: "Failed", icon: "xmark.circle", color: T.status(.failed), cards: pick { $0.status == .failed || $0.status == .interrupted }, status: .failed),
            Lane(id: "done", title: "Done", icon: "checkmark.circle", color: T.status(.done), cards: pick { $0.status == .done }, status: .done),
            Lane(id: "archived", title: "Archive", icon: "archivebox", color: T.status(.archived), cards: pick { $0.status == .archived }, status: .archived),
        ]
        return result
    }

    private func collapsed(_ lane: Lane, _ board: Board) -> Bool {
        if let m = manual[lane.id] { return m }
        let idle = lane.cards.allSatisfy { $0.status == .done || $0.status == .archived }
        if lane.id == "archived" { return idle }
        return (board.autoCollapseEmptySwimlanes ?? true) && idle && lane.id != "done"
            && lane.cards.isEmpty
    }

    private func kanban(_ board: Board) -> some View {
        let all = store.cards(boardId)
        let visible = all.filter { $0.matches(query) }
        let count = { (s: CardStatus) in all.filter { $0.status == s }.count }
        return VStack(spacing: 0) {
            statsBar(board, total: all.count, triage: count(.triage), ready: count(.ready), running: count(.running), review: board.reviewCount)
            if !query.isEmpty { Text("\(visible.count) of \(all.count) cards").font(.ui(12)).foregroundStyle(T.mutedFg).padding(.bottom, 4) }
            alerts(board)
            GeometryReader { geo in
                let width = min(300, geo.size.width - 56)
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(alignment: .top, spacing: 12) {
                        ForEach(lanes(board, visible)) { lane in
                            if collapsed(lane, board) {
                                CollapsedLane(lane: lane) { manual[lane.id] = false }
                            } else {
                                LaneView(lane: lane, width: width, allCards: all, board: board,
                                         onCollapse: { manual[lane.id] = true }, onOpen: { open = CardRoute(boardId: boardId, cardId: $0.id) })
                            }
                        }
                    }
                    .padding(.horizontal, 16).padding(.bottom, 24)
                    .scrollTargetLayout()
                }
                .scrollTargetBehavior(.viewAligned)
            }
        }
    }

    private func statsBar(_ board: Board, total: Int, triage: Int, ready: Int, running: Int, review: Int) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 14) {
                    stat(total, "cards"); stat(triage, "in triage"); stat(ready, "ready"); stat(running, "running"); stat(review, "awaiting review")
                }
            }
            HStack(spacing: 12) {
                Menu {
                    Picker("Sort", selection: $sort) { ForEach(CardSort.allCases) { Text($0.label).tag($0) } }
                } label: {
                    HStack(spacing: 6) { Text("Sort: \(sort.label)"); Image(systemName: "chevron.down").font(.system(size: 9)) }
                        .font(.ui(12)).foregroundStyle(T.foreground).padding(.horizontal, 10).padding(.vertical, 6)
                        .overlay(RoundedRectangle(cornerRadius: 6).stroke(T.foreground.opacity(0.7)))
                }
                if board.autoPickupEnabled == true {
                    Text("Auto pickup · \(board.pickupConcurrency ?? 1) at a time").font(.ui(12)).foregroundStyle(T.primary)
                }
                Text("Last 24h: \(Format.cost(board.cost24h ?? 0))").font(.ui(12)).foregroundStyle(T.mutedFg)
                Spacer(minLength: 0)
            }
        }
        .padding(.horizontal, 16).padding(.bottom, 10)
    }

    private func stat(_ n: Int, _ label: String) -> some View {
        HStack(spacing: 4) { Text("\(n)").font(.mono(12, .bold)).foregroundStyle(T.foreground); Text(label).font(.ui(12)).foregroundStyle(T.mutedFg) }
    }

    @ViewBuilder private func alerts(_ board: Board) -> some View {
        let found = store.conflicts[boardId] ?? []
        VStack(spacing: 8) {
            if !found.isEmpty {
                ErrorBox(title: "\(found.count) card\(found.count == 1 ? " has" : "s have") merge conflicts.", message: "The card worktrees are still available.")
            }
            if let e = board.autoPickupError, !e.isEmpty { ErrorBox(title: "Auto pickup paused", message: e, color: T.amberDeep) }
            if let e = board.integrationError, !e.isEmpty { ErrorBox(title: "GitHub sync problem", message: e, color: T.amberDeep) }
        }
        .padding(.horizontal, 16).padding(.bottom, found.isEmpty ? 0 : 10)
    }
}

struct CollapsedLane: View {
    let lane: Lane
    let expand: () -> Void
    var body: some View {
        Button(action: expand) {
            VStack(spacing: 10) {
                Image(systemName: "chevron.right").font(.system(size: 11)).foregroundStyle(T.mutedFg)
                StatusDot(color: lane.color, size: 8)
                Text(lane.title).font(.ui(13, .medium)).foregroundStyle(T.foreground).fixedSize()
                    .rotationEffect(.degrees(90)).frame(width: 18, height: CGFloat(lane.title.count) * 8 + 8)
                Text("\(lane.cards.count)").font(.mono(11)).foregroundStyle(T.mutedFg)
            }
            .padding(.vertical, 12).frame(width: 44)
            .overlay(RoundedRectangle(cornerRadius: 13.5).strokeBorder(T.border.opacity(0.7), style: StrokeStyle(lineWidth: 1, dash: [4, 4])))
        }
        .buttonStyle(.plain)
    }
}

struct LaneView: View {
    @EnvironmentObject private var store: AppStore
    let lane: Lane
    let width: CGFloat
    let allCards: [Card]
    let board: Board
    let onCollapse: () -> Void
    let onOpen: (Card) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                StatusDot(color: lane.color)
                Text(lane.title).font(.ui(14, .semibold)).lineLimit(1)
                Spacer(minLength: 0)
                Text("\(lane.cards.count)").font(.mono(12)).foregroundStyle(T.foreground)
                    .padding(.horizontal, 8).padding(.vertical, 1).background(T.secondary, in: RoundedRectangle(cornerRadius: 6))
                Button(action: onCollapse) { Image(systemName: "chevron.down").font(.system(size: 11)).foregroundStyle(T.mutedFg) }
            }
            .padding(.horizontal, 4)
            ScrollView(.vertical, showsIndicators: false) {
                LazyVStack(spacing: 10) {
                    if lane.cards.isEmpty {
                        Text("Nothing here yet.").font(.ui(13)).foregroundStyle(T.mutedFg)
                            .frame(maxWidth: .infinity).padding(.vertical, 28)
                            .overlay(RoundedRectangle(cornerRadius: 13.5).strokeBorder(T.border.opacity(0.7), style: StrokeStyle(lineWidth: 1, dash: [4, 4])))
                    }
                    if lane.id == "review" && !lane.cards.isEmpty && !board.isGitHubPR {
                        split
                    } else {
                        ForEach(lane.cards) { tile($0) }
                    }
                }
                .padding(.bottom, 20)
            }
        }
        .frame(width: width)
    }

    @ViewBuilder private var split: some View {
        let mine = lane.cards.filter(\.needsYourReview), rest = lane.cards.filter { !$0.needsYourReview }
        if !mine.isEmpty { divider("Your turn", T.status(.review), mine.count); ForEach(mine) { tile($0) } }
        if !rest.isEmpty { divider("Not your turn yet", T.border, rest.count); ForEach(rest) { tile($0) } }
    }

    private func divider(_ text: String, _ color: Color, _ n: Int) -> some View {
        HStack(spacing: 8) {
            Text("\(text) · \(n)").font(.ui(10, .medium)).tracking(1.2).textCase(.uppercase).foregroundStyle(T.mutedFg)
            Rectangle().fill(color.opacity(0.7)).frame(height: 1)
        }
    }

    private func tile(_ card: Card) -> some View {
        CardTile(card: card, waiting: card.waitingOn(allCards).count, onOpen: { onOpen(card) })
            .contextMenu {
                ForEach(card.moveTargets, id: \.self) { target in
                    Button("Move to \(target == .archived ? "Archive" : target.label)") { Task { await move(card, to: target) } }
                }
            }
    }

    private func move(_ card: Card, to target: CardStatus) async {
        guard let api = store.api else { return }
        struct Status: Encodable { let status: String }
        struct Ids: Encodable { let cardIds: [String] }
        await store.act {
            switch target {
            case .running: try await api.post("/boards/\(board.id)/cards/\(card.id)/start")
            case .archived: let _: JSONValue = try await api.post("/boards/\(board.id)/cards/archive", Ids(cardIds: [card.id]))
            case .done where card.status == .archived: let _: JSONValue = try await api.post("/boards/\(board.id)/cards/unarchive", Ids(cardIds: [card.id]))
            default: let _: JSONValue = try await api.post("/boards/\(board.id)/cards/\(card.id)/status", Status(status: target.rawValue))
            }
        }
    }
}
