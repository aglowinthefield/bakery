import SwiftUI

struct Empty: Encodable {}

@MainActor
final class CardDetailModel: ObservableObject {
    @Published var runs: [Run] = []
    @Published var comments: [ReviewComment] = []
    @Published var autoReview: [AutoReviewJob] = []
    @Published var approvalPending = false
    @Published var history: [HistoryEntry] = []
    @Published var attachments: [Attachment] = []
    @Published var deps: Dependencies?
    @Published var diff: ReviewDiff?
    @Published var diffStale = false
    private var task: Task<Void, Never>?

    func start(api: APIClient, boardId: String, card: @escaping () -> Card?) {
        task?.cancel()
        task = Task { [weak self] in
            var tick = 0
            while !Task.isCancelled {
                guard let self else { return }
                let base = "/boards/\(boardId)/cards/\(card()?.id ?? "")"
                if let c = card() {
                    if let v: [Run] = try? await api.get(base + "/runs"), v != runs { runs = v }
                    if let v: [ReviewComment] = try? await api.get(base + "/comments"), v != comments { comments = v }
                    if let v: [AutoReviewJob] = try? await api.get(base + "/auto-review") { autoReview = v }
                    if let v: ApprovalState = try? await api.get(base + "/approval") { approvalPending = v.pending }
                    if tick % 3 == 0 {
                        if let v: [HistoryEntry] = try? await api.get(base + "/history") { history = v }
                        if let v: Dependencies = try? await api.get(base + "/dependencies") { deps = v }
                        if (c.attachmentCount ?? 0) > 0, let v: [Attachment] = try? await api.get(base + "/attachments") { attachments = v }
                    }
                    if c.status == .review {
                        if diff == nil { diff = try? await api.get(base + "/review") }
                        else if let f: Fingerprint = try? await api.get(base + "/review?fingerprint=1") { diffStale = f.fingerprint != diff?.fingerprint }
                    }
                }
                tick += 1
                try? await Task.sleep(for: .seconds(2))
            }
        }
    }
    func stop() { task?.cancel() }
    func reloadDiff(api: APIClient, boardId: String, cardId: String) async {
        diff = try? await api.get("/boards/\(boardId)/cards/\(cardId)/review"); diffStale = false
    }
}

struct CardDetailSheet: View {
    @EnvironmentObject private var store: AppStore
    @Environment(\.dismiss) private var dismiss
    let route: CardRoute
    @StateObject private var model = CardDetailModel()
    @State private var tab = "Overview"
    @State private var editing = false
    @State private var confirm: Confirmation?
    @State private var replying = false

    struct Confirmation: Identifiable { let id = UUID(); let title: String; let message: String; let action: () async -> Void }

    private var card: Card? { store.card(route.boardId, route.cardId) ?? store.allCards.first { $0.id == route.cardId } }
    private var board: Board? { store.board(route.boardId) }

    var body: some View {
        NavigationStack {
            Group {
                if let card {
                    content(card)
                } else {
                    ProgressView().frame(maxHeight: .infinity)
                }
            }
            .screenBackground()
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) { Button { dismiss() } label: { Image(systemName: "xmark") } }
            }
            .navigationBarTitleDisplayMode(.inline)
        }
        .onAppear {
            if let api = store.api {
                if store.watchedBoard != route.boardId, !route.boardId.isEmpty { store.watchedBoard = route.boardId }
                model.start(api: api, boardId: route.boardId) { card }
            }
        }
        .onDisappear { model.stop() }
        .sheet(isPresented: $editing) { if let card { NewCardSheet(board: board, editing: card) } }
        .alert(item: $confirm) { c in
            Alert(title: Text(c.title), message: Text(c.message), primaryButton: .default(Text("Continue")) { Task { await c.action() } }, secondaryButton: .cancel())
        }
    }

    private func content(_ card: Card) -> some View {
        let tabs = tabsFor(card)
        return VStack(spacing: 0) {
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    HStack(alignment: .top) {
                        Text(card.title).font(.ui(22, .semibold)).tracking(-0.4)
                        Spacer(minLength: 8)
                        if card.status != .running { Button { editing = true } label: { Image(systemName: "pencil").foregroundStyle(T.mutedFg) } }
                    }
                    HStack(spacing: 8) {
                        Text(card.status.label).font(.ui(12, .medium)).tracking(1).textCase(.uppercase)
                            .padding(.horizontal, 8).padding(.vertical, 3).foregroundStyle(T.primary)
                            .background(T.primary.opacity(0.1), in: RoundedRectangle(cornerRadius: 4))
                        Text(card.repoName).font(.ui(12)).foregroundStyle(T.mutedFg)
                    }
                    if let conflict = (store.conflicts[route.boardId] ?? []).first(where: { $0.cardId == card.id }) { conflictBox(conflict) }
                    priorityRow(card)
                    tabBar(tabs)
                    switch tab {
                    case "Review", "Reviews": ReviewPanel(card: card, boardId: route.boardId, model: model)
                    case "Attempts": attempts(card)
                    case "Discuss": DiscussionPanel(card: card, boardId: route.boardId)
                    case "Details": details(card)
                    default: overview(card)
                    }
                }
                .padding(16).padding(.bottom, 24)
            }
            Divider().overlay(T.border)
            footer(card).padding(12)
        }
    }

    private func tabsFor(_ card: Card) -> [String] {
        var t = ["Overview"]
        if card.status == .review { t.append("Review") }
        if !model.runs.isEmpty { t.append("Attempts (\(model.runs.count))") }
        t += ["Discuss", "Details"]
        return t
    }

    private func tabBar(_ tabs: [String]) -> some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 22) {
                ForEach(tabs, id: \.self) { name in
                    let key = name.components(separatedBy: " (").first!
                    Button { tab = key } label: {
                        Text(name).font(.ui(14, tab == key ? .semibold : .regular))
                            .foregroundStyle(tab == key ? T.foreground : T.mutedFg).padding(.vertical, 8)
                            .overlay(alignment: .bottom) { if tab == key { Rectangle().fill(T.primary).frame(height: 2) } }
                    }
                }
            }
        }
        .overlay(alignment: .bottom) { Rectangle().fill(T.border).frame(height: 1) }
    }

    private func priorityRow(_ card: Card) -> some View {
        HStack {
            Text("Priority").font(.ui(13)).foregroundStyle(T.mutedFg)
            Stepper(value: Binding(get: { card.priority }, set: { v in Task { await setPriority(card, v) } }), in: -100...100, step: 10) {
                Text("\(card.priority)").font(.mono(14))
            }
            .disabled(card.status == .running)
        }
    }

    private func setPriority(_ card: Card, _ value: Int) async {
        guard let api = store.api else { return }
        struct Body: Encodable { let title: String; let body: String; let priority: Int }
        await store.act { let _: Card = try await api.patch("/boards/\(route.boardId)/cards/\(card.id)", Body(title: card.title, body: card.body, priority: value)) }
    }

    // MARK: Tabs

    private func overview(_ card: Card) -> some View {
        VStack(alignment: .leading, spacing: 18) {
            if card.status == .running { workingNow(card) }
            if let job = model.autoReview.first(where: { $0.state == "running" }) {
                Bordered { VStack(alignment: .leading, spacing: 4) { Text("Agent review").font(.ui(14, .semibold)); Text(job.details ?? "Reviewing…").font(.ui(13)).foregroundStyle(T.mutedFg) } }
            }
            VStack(alignment: .leading, spacing: 8) {
                Text("Description").font(.ui(15, .semibold))
                if card.body.isEmpty { Text("No description.").font(.ui(14)).foregroundStyle(T.mutedFg) } else { MarkdownView(source: card.body) }
            }
            if !model.attachments.isEmpty { attachments }
            if let run = model.runs.first(where: { $0.report != nil && !($0.report ?? "").isEmpty }) {
                Bordered(padding: 14, fill: T.accent.opacity(0.1)) {
                    VStack(alignment: .leading, spacing: 10) {
                        HStack {
                            Text("Agent report").font(.ui(15, .semibold))
                            Spacer()
                            Button { UIPasteboard.general.string = run.report } label: { Label("Copy markdown", systemImage: "doc.on.doc").font(.ui(12)) }.foregroundStyle(T.mutedFg)
                        }
                        MarkdownView(source: run.report ?? "")
                    }
                }
            }
            if card.status == .failed, let run = model.runs.first {
                ErrorBox(title: run.failureKind == "provider" ? "Provider request failed" : "Run failed", message: run.error)
            }
            if card.status == .interrupted {
                ErrorBox(title: "The server restarted during this run.", message: "Release the card to retry it.", color: T.status(.interrupted))
            }
            if card.status == .review, let run = model.runs.first, run.report != nil { replyForm(card) }
        }
    }

    @State private var reply = ""
    private func replyForm(_ card: Card) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Reply to the agent").font(.ui(14, .semibold))
            TextField("What should change?", text: $reply, axis: .vertical).lineLimit(3...6)
                .padding(10).overlay(RoundedRectangle(cornerRadius: 7.5).stroke(T.border))
            Button("Send reply and run again") { Task { await sendReply(card) } }
                .buttonStyle(.pill(.outline)).disabled(reply.trimmingCharacters(in: .whitespaces).isEmpty || replying)
        }
    }

    private func sendReply(_ card: Card) async {
        guard let api = store.api, let fingerprint = model.diff?.fingerprint else { return }
        struct Comment: Encodable { let fingerprint: String; let path: String; let line: Int; let body: String }
        struct Fp: Encodable { let fingerprint: String }
        replying = true
        if await store.act({
            let _: ReviewComment = try await api.post("/boards/\(route.boardId)/cards/\(card.id)/comments", Comment(fingerprint: fingerprint, path: "", line: 0, body: reply))
            let _: JSONValue = try await api.post("/boards/\(route.boardId)/cards/\(card.id)/request-changes", Fp(fingerprint: fingerprint))
        }) { reply = "" }
        replying = false
    }

    private func workingNow(_ card: Card) -> some View {
        TimelineView(.periodic(from: .now, by: 1)) { ctx in
            let run = model.runs.first
            let sentence = run?.report.flatMap { $0.split(separator: ".").last.map(String.init) }?.trimmingCharacters(in: .whitespacesAndNewlines)
            Bordered(fill: T.status(.running).opacity(0.08)) {
                VStack(alignment: .leading, spacing: 4) {
                    HStack { ProgressView().scaleEffect(0.7); Text("Working now").font(.ui(14, .semibold)) }
                    Text("\(Format.elapsed(since: run?.startedAt, now: ctx.date)) · \(card.turns ?? 0) turns").font(.mono(12)).foregroundStyle(T.mutedFg)
                    Text(sentence.map { String($0.prefix(180)) } ?? "Starting up…").font(.ui(13)).foregroundStyle(T.mutedFg)
                }
            }
        }
    }

    private var attachments: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Attachments").font(.ui(15, .semibold))
            LazyVGrid(columns: [GridItem(.adaptive(minimum: 110), spacing: 8)], spacing: 8) {
                ForEach(model.attachments) { a in
                    if let api = store.api {
                        let url = api.url("/boards/\(route.boardId)/cards/\(a.cardId)/attachments/\(a.id)")
                        Link(destination: url) {
                            if a.isImage {
                                AsyncImage(url: url) { $0.resizable().scaledToFill() } placeholder: { T.muted }
                                    .frame(height: 90).clipShape(RoundedRectangle(cornerRadius: 6))
                            } else {
                                Label(a.name, systemImage: "paperclip").font(.ui(12)).lineLimit(2)
                                    .padding(8).frame(maxWidth: .infinity, minHeight: 90).background(T.muted, in: RoundedRectangle(cornerRadius: 6))
                            }
                        }
                    }
                }
            }
        }
    }

    private func attempts(_ card: Card) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                SectionLabel(text: "Attempts")
                Spacer()
                Text("Card total: \(Format.cost(card.cost))").font(.ui(12)).foregroundStyle(T.mutedFg)
            }
            Text("\(model.runs.count) attempts · \(card.reviewRounds ?? 0) review rounds").font(.ui(12)).foregroundStyle(T.mutedFg)
            ForEach(model.runs) { run in AttemptRow(run: run, expanded: run.id == model.runs.first?.id) }
        }
    }

    private func details(_ card: Card) -> some View {
        VStack(alignment: .leading, spacing: 18) {
            VStack(alignment: .leading, spacing: 8) {
                Text("Dependencies").font(.ui(15, .semibold))
                if let deps = model.deps, !deps.dependsOn.isEmpty {
                    Text("Depends on:").font(.ui(13)).foregroundStyle(T.mutedFg)
                    ForEach(deps.dependsOn) { depRow($0) }
                } else { Text("No dependencies").font(.ui(13)).foregroundStyle(T.mutedFg) }
                if let deps = model.deps, !deps.dependents.isEmpty {
                    Text("Needed by:").font(.ui(13)).foregroundStyle(T.mutedFg).padding(.top, 4)
                    ForEach(deps.dependents) { depRow($0) }
                }
            }
            if let url = card.prUrl.flatMap(URL.init) {
                Link(destination: url) { Label("PR #\(card.prNumber ?? 0)", systemImage: "arrow.triangle.pull") }.font(.ui(14))
            }
            VStack(alignment: .leading, spacing: 6) {
                Text("Card ID").font(.ui(15, .semibold))
                HStack {
                    Text(card.id).font(.mono(12)).textSelection(.enabled)
                    Button { UIPasteboard.general.string = card.id } label: { Image(systemName: "doc.on.doc") }.foregroundStyle(T.mutedFg)
                }
            }
            VStack(alignment: .leading, spacing: 10) {
                Text("History").font(.ui(15, .semibold))
                ForEach(Array(model.history.enumerated()), id: \.offset) { _, e in
                    HStack(alignment: .top, spacing: 12) {
                        Rectangle().fill(T.border).frame(width: 2)
                        VStack(alignment: .leading, spacing: 3) {
                            Text(Format.date(e.at) + (e.from.map { " · \($0.label) → \(e.to?.label ?? "")" } ?? "")).font(.ui(12)).foregroundStyle(T.mutedFg)
                            Text(e.text).font(.ui(14))
                            if let d = e.detail, !d.isEmpty { Text(d).font(.ui(12)).foregroundStyle(T.mutedFg) }
                        }
                    }
                }
            }
        }
    }

    private func depRow(_ ref: CardRef) -> some View {
        HStack(spacing: 8) {
            StatusDot(color: T.status(ref.status), size: 8)
            Text(ref.title).font(.ui(14)).lineLimit(2)
            Spacer()
            Text(ref.status == .done || ref.status == .archived ? "finished" : ref.status.rawValue).font(.mono(10)).textCase(.uppercase).foregroundStyle(T.mutedFg)
        }
    }

    private func conflictBox(_ c: MergeConflict) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            ErrorBox(title: "Merge blocked by conflicts", message: c.files.joined(separator: "\n"))
        }
    }

    // MARK: Footer

    @ViewBuilder private func footer(_ card: Card) -> some View {
        let base = "/boards/\(route.boardId)/cards/\(card.id)"
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                switch card.status {
                case .triage:
                    button("Move to Ready", .primary) { try await post(base + "/status", Status(status: "ready")) }
                    if model.runs.isEmpty { button("Mark done", .outline) { try await post(base + "/status", Status(status: "done")) } }
                case .ready:
                    startButton(card, base)
                    if model.runs.isEmpty { button("Move to Triage", .outline) { try await post(base + "/status", Status(status: "triage")) } }
                case .running:
                    button("Stop run", .destructive) { try await postEmpty(base + "/stop") }
                case .review:
                    if let fp = model.diff?.fingerprint {
                        if model.diff?.files.isEmpty == true {
                            button("Accept findings", .primary) { try await post(base + "/accept-findings", Fp(fingerprint: fp)) }
                        } else {
                            button(board?.isGitHubPR == true ? "Approve and open PR" : "Approve and merge", .primary, confirm: "Approve this card and merge it into local main?") {
                                try await post(base + "/approve", Fp(fingerprint: fp))
                            }
                        }
                        let drafts = model.comments.filter { $0.state == "draft" }
                        if !drafts.isEmpty { button("Request changes (\(drafts.count))", .outline) { try await post(base + "/request-changes", Fp(fingerprint: fp)) } }
                    }
                    if model.approvalPending { button("Withdraw approval", .outline) { try await postEmpty(base + "/withdraw") } }
                    startButton(card, base, outline: true)
                    button("Close", .outline, confirm: "Close this card without merging? Its worktree and branch stay.") { try await post(base + "/close", Empty()) }
                case .failed, .interrupted:
                    if card.status == .interrupted {
                        button("Release for retry", .primary) { try await post(base + "/resolve", Ack(acknowledged: true)) }
                    } else { startButton(card, base) }
                    button("Move to Ready", .outline) { try await post(base + "/status", Status(status: "ready")) }
                case .done:
                    button("Reopen", .outline) { try await post(base + "/status", Status(status: "ready")) }
                    button("Archive", .outline) { try await post("/boards/\(route.boardId)/cards/archive", Ids(cardIds: [card.id])) }
                case .archived:
                    button("Restore to Done", .outline) { try await post("/boards/\(route.boardId)/cards/unarchive", Ids(cardIds: [card.id])) }
                case .unknown: EmptyView()
                }
            }
        }
    }

    struct Status: Encodable { let status: String }
    struct Fp: Encodable { let fingerprint: String }
    struct Ids: Encodable { let cardIds: [String] }
    struct Ack: Encodable { let acknowledged: Bool }

    private func post<B: Encodable>(_ path: String, _ body: B) async throws { let _: JSONValue = try await store.api!.post(path, body) }
    private func postEmpty(_ path: String) async throws { _ = try await store.api!.post(path) }

    private func startButton(_ card: Card, _ base: String, outline: Bool = false) -> some View {
        let blocked = card.blocked == true && card.attemptCount == 0
        let ask = store.settings.confirmRunStart == true
        return button(card.attemptCount > 0 ? "Run again" : "Start Pi run", outline ? .outline : .primary, icon: "sparkle",
                      confirm: ask ? "Start Pi on this card? This run may use paid model tokens and can edit its Git worktree." : nil) {
            try await postEmpty(base + "/start")
        }
        .disabled(blocked)
    }

    private func button(_ title: String, _ kind: PillButtonStyle.Kind, icon: String? = nil, confirm message: String? = nil, _ work: @escaping () async throws -> Void) -> some View {
        Button {
            let run = { Task { await store.act(work) } }
            if let message { confirm = Confirmation(title: title, message: message) { _ = run() } } else { _ = run() }
        } label: {
            HStack(spacing: 6) { if let icon { Image(systemName: icon).font(.system(size: 12)) }; Text(title) }.fixedSize()
        }
        .buttonStyle(.pill(kind))
    }
}

struct AttemptRow: View {
    let run: Run
    @State var expanded: Bool
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button { withAnimation(.easeOut(duration: 0.15)) { expanded.toggle() } } label: {
                HStack(spacing: 8) {
                    Image(systemName: expanded ? "chevron.down" : "chevron.right").font(.system(size: 10)).foregroundStyle(T.mutedFg)
                    Text("Attempt #\(run.attempt)").font(.mono(12, .medium)).foregroundStyle(T.primary)
                    Text(run.status.label).font(.ui(12)).foregroundStyle(T.mutedFg)
                    if run.startedBy == "auto" { Badge(text: "Auto pickup", color: T.mutedFg) }
                    Spacer(minLength: 0)
                    Text("Cost: \(Format.cost(run.cost))").font(.mono(10)).padding(.horizontal, 6).padding(.vertical, 2).background(T.muted, in: Capsule())
                }
                .padding(12).contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            if expanded {
                VStack(alignment: .leading, spacing: 8) {
                    Text(Format.date(run.startedAt)).font(.ui(12)).foregroundStyle(T.mutedFg)
                    if let w = run.worktree { Text(w).font(.mono(11)).foregroundStyle(T.mutedFg).textSelection(.enabled) }
                    if let e = run.error, !e.isEmpty { Text(e).font(.ui(13)).foregroundStyle(T.destructive) }
                    ScrollView {
                        Text((run.output ?? "").isEmpty ? "Waiting for Pi output…" : String((run.output ?? "").suffix(12000))).font(.mono(11))
                            .frame(maxWidth: .infinity, alignment: .leading).textSelection(.enabled)
                    }
                    .frame(maxHeight: 288).padding(8).background(T.code, in: RoundedRectangle(cornerRadius: 6))
                }
                .padding([.horizontal, .bottom], 12)
            }
        }
        .background(T.card, in: RoundedRectangle(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).stroke(T.border.opacity(0.8)))
    }
}
