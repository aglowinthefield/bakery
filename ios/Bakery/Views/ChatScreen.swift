import SwiftUI

@MainActor
final class ChatModel: ObservableObject {
    @Published var chats: [Chat] = []
    @Published var current: ChatDetail?
    private var stream: Task<Void, Never>?
    private let viewer = UUID().uuidString
    var boardId = ""
    func path(_ id: String, _ rest: String = "") -> String { "/boards/\(boardId)/chats/\(id)\(rest)" }

    func loadList(api: APIClient, boardId: String) async {
        self.boardId = boardId
        if let v: [Chat] = try? await api.get("/boards/\(boardId)/chats") { chats = v }
    }

    func open(api: APIClient, id: String) async {
        stream?.cancel()
        current = try? await api.get(path(id))
        stream = Task { [weak self] in
            guard let self else { return }
            while !Task.isCancelled {
                // SSE: the server pushes live/message/chat events; refetch on any of them.
                var request = URLRequest(url: api.url(path(id, "/events?viewer=\(viewer)&looking=1")))
                request.timeoutInterval = 3600
                if let (bytes, _) = try? await URLSession.shared.bytes(for: request) {
                    do {
                        for try await line in bytes.lines where line.hasPrefix("data:") {
                            if let d: ChatDetail = try? await api.get(path(id)) { current = d }
                        }
                    } catch {}
                }
                try? await Task.sleep(for: .seconds(2))
            }
        }
    }
    func close() { stream?.cancel(); current = nil }
}

struct ChatScreen: View {
    @EnvironmentObject private var store: AppStore
    let board: Board
    @StateObject private var model = ChatModel()
    @State private var text = ""
    @State private var showList = false

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Button { showList = true } label: {
                    HStack(spacing: 6) {
                        Text(model.current?.chat.label ?? "Chats").font(.ui(14, .medium)).lineLimit(1)
                        Image(systemName: "chevron.down").font(.system(size: 10))
                    }
                    .foregroundStyle(T.foreground).padding(.horizontal, 12).padding(.vertical, 7).overlay(RoundedRectangle(cornerRadius: 7.5).stroke(T.border))
                }
                Spacer()
                Button { Task { await newChat() } } label: { Label("New chat", systemImage: "plus") }.buttonStyle(.pill(.outline))
            }
            .padding(.horizontal, 16).padding(.bottom, 8)
            Divider().overlay(T.border)
            if let detail = model.current {
                ScrollViewReader { proxy in
                    ScrollView {
                        VStack(alignment: .leading, spacing: 14) {
                            ForEach(detail.messages) { m in bubble(m.role, (m.parts ?? []).isEmpty ? [.text(m.body)] : m.parts!) }
                            if let live = detail.live { bubble("assistant", live.parts.isEmpty ? [.text("Thinking…")] : live.parts) }
                            Color.clear.frame(height: 1).id("end")
                        }
                        .padding(16)
                    }
                    .onChange(of: detail.messages.count) { _, _ in proxy.scrollTo("end") }
                    .onChange(of: detail.live?.parts.count) { _, _ in proxy.scrollTo("end") }
                }
                composer(detail)
            } else {
                ContentUnavailableView("No chat open", systemImage: "bubble.left.and.bubble.right", description: Text("Start a chat about this repository."))
                    .frame(maxHeight: .infinity)
            }
        }
        .task {
            guard let api = store.api else { return }
            await model.loadList(api: api, boardId: board.id)
            if let first = model.chats.first { await model.open(api: api, id: first.id) }
        }
        .onDisappear { model.close() }
        .sheet(isPresented: $showList) {
            NavigationStack {
                List(model.chats) { chat in
                    Button {
                        showList = false
                        Task { if let api = store.api { await model.open(api: api, id: chat.id) } }
                    } label: {
                        HStack { Text(chat.label).foregroundStyle(T.foreground); Spacer(); Text(Format.ago(chat.updatedAt)).font(.mono(11)).foregroundStyle(T.mutedFg) }
                    }
                }
                .navigationTitle("Chats").navigationBarTitleDisplayMode(.inline)
            }
            .presentationDetents([.medium])
        }
    }

    private func bubble(_ role: String, _ parts: [ChatPart]) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(Array(parts.enumerated()), id: \.offset) { _, part in
                switch part {
                case .text(let t): MarkdownView(source: t)
                case .tool(_, let name, let input, let output, let status):
                    DisclosureGroup {
                        Text(String((input + "\n" + output).prefix(3000))).font(.mono(11)).foregroundStyle(T.mutedFg)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    } label: {
                        HStack(spacing: 6) {
                            Image(systemName: status == "running" ? "gearshape" : "wrench.and.screwdriver").font(.system(size: 11))
                            Text(name).font(.mono(12))
                        }
                        .foregroundStyle(T.mutedFg)
                    }
                    .tint(T.mutedFg)
                }
            }
        }
        .padding(12).frame(maxWidth: .infinity, alignment: .leading)
        .background(role == "user" ? T.muted : T.card, in: RoundedRectangle(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).stroke(T.border.opacity(0.8)))
        .padding(.leading, role == "user" ? 32 : 0).padding(.trailing, role == "user" ? 0 : 16)
    }

    private func composer(_ detail: ChatDetail) -> some View {
        HStack(alignment: .bottom, spacing: 8) {
            TextField("Message", text: $text, axis: .vertical).lineLimit(1...6)
                .padding(10).overlay(RoundedRectangle(cornerRadius: 7.5).stroke(T.foreground.opacity(0.85), lineWidth: 1.5))
            if detail.live != nil {
                Button("Stop") { Task { _ = await store.act { _ = try await store.api!.post(model.path(detail.chat.id, "/stop")) } } }.buttonStyle(.pill(.outline))
            } else {
                Button("Send") { Task { await send(detail.chat.id) } }.buttonStyle(.pill).disabled(text.trimmingCharacters(in: .whitespaces).isEmpty)
            }
        }
        .padding(12).background(T.background)
        .overlay(alignment: .top) { Divider().overlay(T.border) }
    }

    private func send(_ id: String) async {
        guard let api = store.api else { return }
        struct Body: Encodable { let message: String }
        let message = text
        text = ""
        if await store.act({ let _: JSONValue = try await api.post(model.path(id, "/messages"), Body(message: message)) }) {
            if let d: ChatDetail = try? await api.get(model.path(id)) { model.current = d }
        } else { text = message }
    }

    private func newChat() async {
        guard let api = store.api else { return }
        struct Body: Encodable {}
        var created: Chat?
        await store.act { created = try await api.post("/boards/\(board.id)/chats", Body()) }
        if let created { await model.loadList(api: api, boardId: board.id); await model.open(api: api, id: created.id) }
    }
}
