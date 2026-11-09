import SwiftUI

/// App-wide state: server connection, polled boards/cards/settings, and toast errors.
/// The web board re-polls every 2 s (src/main.tsx:1152); this does the same while the app is active.
@MainActor
final class AppStore: ObservableObject {
    @AppStorage("serverURL") var serverURL = ""
    @Published private(set) var api: APIClient?
    @Published var boards: [Board] = []
    @Published var cardsByBoard: [String: [Card]] = [:]
    @Published var allCards: [Card] = []
    @Published var conflicts: [String: [MergeConflict]] = [:]
    @Published var settings = AppSettings()
    @Published var hostname = ""
    @Published var connectionError: String?
    @Published var loaded = false
    @Published var toast: String?
    /// Boards the current screen wants card lists for.
    var watchedBoard: String?
    var watchingToday = false
    private var pollTask: Task<Void, Never>?

    init() { connect() }

    var isConnected: Bool { api != nil }

    static func normalizedURL(_ raw: String) -> URL? {
        var text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return nil }
        if !text.contains("://") { text = "http://" + text }
        guard let url = URL(string: text), url.host != nil else { return nil }
        return url
    }

    /// Probes the address without touching the saved connection; saves it only if the server answers.
    /// Returns an error message, or nil on success.
    func tryConnect(_ address: String) async -> String? {
        guard let url = Self.normalizedURL(address) else { return "That doesn't look like an address. Try host:4317." }
        do {
            let _: ServerStatus = try await APIClient(baseURL: url).get("/status")
        } catch { return Self.friendly(error) }
        serverURL = address
        connect()
        await refresh()
        return nil
    }

    func connect() {
        if let url = Self.normalizedURL(serverURL) {
            api = APIClient(baseURL: url)
            loaded = false
            restartPolling()
        } else { api = nil }
    }

    func restartPolling() {
        pollTask?.cancel()
        pollTask = Task { [weak self] in
            while !Task.isCancelled {
                await self?.refresh()
                try? await Task.sleep(for: .seconds(2))
            }
        }
    }

    func stopPolling() { pollTask?.cancel() }

    func refresh() async {
        guard let api else { return }
        do {
            let boards: [Board] = try await api.get("/boards")
            self.boards = boards
            if hostname.isEmpty, let s: ServerStatus = try? await api.get("/status") { hostname = s.hostname ?? "" }
            if let s: AppSettings = try? await api.get("/settings") { settings = s }
            if let id = watchedBoard {
                async let cards: [Card] = api.get("/boards/\(id)/cards")
                async let found: [MergeConflict] = api.get("/boards/\(id)/conflicts")
                let (c, f) = try await (cards, (try? await found) ?? [])
                if cardsByBoard[id] != c { cardsByBoard[id] = c }
                if conflicts[id] != f { conflicts[id] = f }
            }
            if watchingToday {
                let cards: [Card] = try await api.get("/cards")
                if allCards != cards { allCards = cards }
            }
            connectionError = nil
            loaded = true
        } catch {
            connectionError = Self.friendly(error)
            loaded = true
        }
    }

    static func friendly(_ error: Error) -> String {
        if let e = error as? APIError { return e.status == 403 ? "The server refused this address. Add it to BAKERY_ALLOWED_HOSTS on the server." : e.message }
        let ns = error as NSError
        if ns.domain == NSURLErrorDomain { return "Can't reach the server (\(ns.localizedDescription))" }
        return error.localizedDescription
    }

    func board(_ id: String) -> Board? { boards.first { $0.id == id } }
    func cards(_ boardId: String) -> [Card] { (cardsByBoard[boardId] ?? []).filter { !$0.isSentinelJob } }
    func card(_ boardId: String, _ id: String) -> Card? { cardsByBoard[boardId]?.first { $0.id == id } }
    func board(forRepo repo: String) -> Board? { boards.first { $0.repo == repo } }

    var needsYouTotal: Int { boards.reduce(0) { $0 + $1.reviewCount + $1.failedCount } }

    /// Runs a mutation, refreshes, and shows failures as a toast like the web "Action failed" box.
    @discardableResult
    func act(_ work: () async throws -> Void) async -> Bool {
        do {
            try await work()
            await refresh()
            return true
        } catch {
            show(Self.friendly(error))
            return false
        }
    }

    func show(_ message: String) {
        toast = message
        Task {
            try? await Task.sleep(for: .seconds(4))
            if toast == message { toast = nil }
        }
    }
}
