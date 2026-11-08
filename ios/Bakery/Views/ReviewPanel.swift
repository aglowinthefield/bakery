import SwiftUI

struct DiffLine: Identifiable {
    enum Kind { case add, remove, context, hunk, meta }
    let id = UUID()
    let kind: Kind
    let text: String
    let fileLine: Int?   // line number in the new file, for comments
}

enum DiffParser {
    static func parse(_ patch: String) -> [DiffLine] {
        var out: [DiffLine] = []
        var newLine = 0
        for raw in patch.components(separatedBy: "\n") {
            if raw.hasPrefix("@@") {
                if let r = raw.range(of: #"\+(\d+)"#, options: .regularExpression) { newLine = Int(raw[r].dropFirst()) ?? 0 }
                out.append(DiffLine(kind: .hunk, text: raw, fileLine: nil))
            } else if raw.hasPrefix("+++") || raw.hasPrefix("---") || raw.hasPrefix("diff ") || raw.hasPrefix("index ") {
                continue
            } else if raw.hasPrefix("+") {
                out.append(DiffLine(kind: .add, text: String(raw.dropFirst()), fileLine: newLine)); newLine += 1
            } else if raw.hasPrefix("-") {
                out.append(DiffLine(kind: .remove, text: String(raw.dropFirst()), fileLine: nil))
            } else if raw.hasPrefix("\\") {
                out.append(DiffLine(kind: .meta, text: raw, fileLine: nil))
            } else if !raw.isEmpty || newLine > 0 {
                out.append(DiffLine(kind: .context, text: raw.isEmpty ? "" : String(raw.dropFirst()), fileLine: newLine)); newLine += 1
            }
        }
        return out
    }
}

struct ReviewPanel: View {
    @EnvironmentObject private var store: AppStore
    let card: Card
    let boardId: String
    @ObservedObject var model: CardDetailModel
    @State private var composeFor: (path: String, line: Int)?
    @State private var draft = ""
    @State private var collapsed: Set<String> = []

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            if model.diffStale {
                HStack {
                    Text("The branch changed since you opened this diff.").font(.ui(13))
                    Spacer()
                    Button("Reload") { Task { if let api = store.api { await model.reloadDiff(api: api, boardId: boardId, cardId: card.id) } } }
                        .buttonStyle(.pill(.outline))
                }
                .padding(12).background(T.amber.opacity(0.1), in: RoundedRectangle(cornerRadius: 7.5))
                .overlay(RoundedRectangle(cornerRadius: 7.5).stroke(T.amber.opacity(0.4)))
            }
            if let diff = model.diff {
                if diff.files.isEmpty {
                    Text("No file changes — the agent reported findings only.").font(.ui(14)).foregroundStyle(T.mutedFg)
                } else {
                    Text("\(diff.files.count) file\(diff.files.count == 1 ? "" : "s") changed").font(.ui(13)).foregroundStyle(T.mutedFg)
                    ForEach(diff.files, id: \.path) { file in fileView(file, diff.fingerprint) }
                }
                let drafts = model.comments.filter { $0.state == "draft" }
                if !drafts.isEmpty {
                    Text("Draft comments (\(drafts.count))").font(.ui(15, .semibold))
                    ForEach(drafts) { c in commentView(c) }
                }
            } else {
                ProgressView().frame(maxWidth: .infinity)
            }
        }
    }

    private func comments(_ path: String, _ line: Int) -> [ReviewComment] {
        model.comments.filter { $0.path == path && ($0.fileLine ?? $0.line) == line && $0.state != "resolved" }
    }

    private func fileView(_ file: ReviewFile, _ fingerprint: String) -> some View {
        let lines = DiffParser.parse(file.patch)
        let open = !collapsed.contains(file.path)
        return VStack(alignment: .leading, spacing: 0) {
            Button { if open { collapsed.insert(file.path) } else { collapsed.remove(file.path) } } label: {
                HStack {
                    Image(systemName: open ? "chevron.down" : "chevron.right").font(.system(size: 10))
                    Text(file.path).font(.mono(12, .medium)).lineLimit(1).truncationMode(.head)
                    Spacer()
                    Text("+\(lines.filter { $0.kind == .add }.count)").foregroundStyle(T.diffAddFg)
                    Text("−\(lines.filter { $0.kind == .remove }.count)").foregroundStyle(T.diffRemoveFg)
                }
                .font(.mono(11)).padding(10).background(T.muted).contentShape(Rectangle())
            }
            .buttonStyle(.plain).foregroundStyle(T.foreground)
            if open {
                ScrollView(.horizontal, showsIndicators: false) {
                    VStack(alignment: .leading, spacing: 0) {
                        ForEach(lines) { l in
                            lineView(l, file.path)
                            if let n = l.fileLine {
                                ForEach(comments(file.path, n)) { commentView($0).padding(8) }
                                if let c = composeFor, c.path == file.path, c.line == n { composer(file.path, n, fingerprint) }
                            }
                        }
                    }
                    .frame(minWidth: 0, alignment: .leading)
                }
            }
        }
        .background(T.card)
        .clipShape(RoundedRectangle(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).stroke(T.border.opacity(0.8)))
    }

    private func lineView(_ l: DiffLine, _ path: String) -> some View {
        let (bg, fg): (Color, Color) = switch l.kind {
        case .add: (T.diffAdd, T.diffAddFg)
        case .remove: (T.diffRemove, T.diffRemoveFg)
        case .hunk: (T.muted, T.mutedFg)
        default: (.clear, T.foreground.opacity(0.85))
        }
        return HStack(spacing: 8) {
            Text(l.fileLine.map(String.init) ?? "").font(.mono(10)).foregroundStyle(T.mutedFg).frame(width: 32, alignment: .trailing)
            Text(l.text.isEmpty ? " " : l.text).font(.mono(11)).foregroundStyle(fg).fixedSize()
            Spacer(minLength: 0)
        }
        .padding(.vertical, 1).padding(.trailing, 8).frame(minWidth: UIScreen.main.bounds.width - 32, alignment: .leading)
        .background(bg)
        .contentShape(Rectangle())
        .onTapGesture { if let n = l.fileLine, l.kind != .hunk { composeFor = (path, n); draft = "" } }
    }

    private func composer(_ path: String, _ line: Int, _ fingerprint: String) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            TextField("Comment on line \(line)", text: $draft, axis: .vertical).lineLimit(2...5).font(.ui(13))
                .padding(8).overlay(RoundedRectangle(cornerRadius: 6).stroke(T.border))
            HStack {
                Button("Add comment") { Task { await submit(path, line, fingerprint) } }
                    .buttonStyle(.pill).disabled(draft.trimmingCharacters(in: .whitespaces).isEmpty)
                Button("Cancel") { composeFor = nil }.buttonStyle(.pill(.outline))
            }
        }
        .padding(10).frame(width: UIScreen.main.bounds.width - 64).background(T.background)
    }

    private func submit(_ path: String, _ line: Int, _ fingerprint: String) async {
        guard let api = store.api else { return }
        struct Body: Encodable { let fingerprint: String; let path: String; let line: Int; let body: String }
        if await store.act({
            let _: ReviewComment = try await api.post("/boards/\(boardId)/cards/\(card.id)/comments", Body(fingerprint: fingerprint, path: path, line: line, body: draft))
        }) { composeFor = nil; draft = "" }
    }

    private func commentView(_ c: ReviewComment) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("\(c.path):\(c.fileLine ?? c.line)").font(.mono(11)).foregroundStyle(T.mutedFg)
            Text(c.body).font(.ui(13))
        }
        .frame(maxWidth: .infinity, alignment: .leading).padding(10)
        .background(T.primary.opacity(0.08), in: RoundedRectangle(cornerRadius: 6))
        .overlay(RoundedRectangle(cornerRadius: 6).stroke(T.primary.opacity(0.3)))
    }
}

struct DiscussionPanel: View {
    @EnvironmentObject private var store: AppStore
    let card: Card
    let boardId: String
    @State private var state = DiscussionState(messages: [], pending: false)
    @State private var text = ""
    @State private var task: Task<Void, Never>?

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Ask Pi about this card. Nothing here changes the card.").font(.ui(13)).foregroundStyle(T.mutedFg)
            ForEach(state.messages) { m in
                VStack(alignment: .leading, spacing: 4) {
                    Text(m.role == "user" ? "You" : "Pi").font(.ui(11, .medium)).tracking(1).textCase(.uppercase).foregroundStyle(T.mutedFg)
                    MarkdownView(source: m.body)
                }
                .padding(12).frame(maxWidth: .infinity, alignment: .leading)
                .background(m.role == "user" ? T.muted : T.card, in: RoundedRectangle(cornerRadius: 10))
                .overlay(RoundedRectangle(cornerRadius: 10).stroke(T.border.opacity(0.8)))
            }
            if state.pending { HStack { ProgressView().scaleEffect(0.7); Text("Thinking…").font(.ui(13)).foregroundStyle(T.mutedFg) } }
            HStack(alignment: .bottom, spacing: 8) {
                TextField("Ask a question", text: $text, axis: .vertical).lineLimit(1...5)
                    .padding(10).overlay(RoundedRectangle(cornerRadius: 7.5).stroke(T.foreground.opacity(0.85), lineWidth: 1.5))
                Button("Send") { Task { await send() } }.buttonStyle(.pill).disabled(text.trimmingCharacters(in: .whitespaces).isEmpty || state.pending)
            }
        }
        .onAppear {
            task = Task {
                while !Task.isCancelled {
                    if let api = store.api, let s: DiscussionState = try? await api.get("/boards/\(boardId)/cards/\(card.id)/discussion"), s.messages != state.messages || s.pending != state.pending { state = s }
                    try? await Task.sleep(for: .milliseconds(1500))
                }
            }
        }
        .onDisappear { task?.cancel() }
    }

    private func send() async {
        guard let api = store.api else { return }
        struct Body: Encodable { let message: String }
        let message = text
        text = ""
        if !(await store.act({ let _: JSONValue = try await api.post("/boards/\(boardId)/cards/\(card.id)/discussion", Body(message: message)) })) { text = message }
    }
}
