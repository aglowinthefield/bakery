import Foundation

// Mirrors src/model.ts. Every field the server may omit (older records, newer servers) is optional
// or defaulted so one odd card never breaks a whole board.

enum CardStatus: String, Codable, CaseIterable, Hashable {
    case triage, ready, running, review, failed, interrupted, done, archived, unknown

    init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = CardStatus(rawValue: raw) ?? .unknown
    }

    var label: String {
        switch self {
        case .triage: "Triage"
        case .ready: "Ready"
        case .running: "Running"
        case .review: "Review"
        case .failed: "Failed"
        case .interrupted: "Interrupted"
        case .done: "Done"
        case .archived: "Archived"
        case .unknown: "Unknown"
        }
    }
}

enum ReviewWait: String, Codable, Hashable { case agent_review, ci_fix, github }
enum ReviewAction: String, Codable, Hashable { case pr_ready, accept_findings }

struct LiveActivity: Codable, Hashable { let tool: String?; let turn: Int?; let since: String? }
struct ReviewQueuePos: Codable, Hashable { let position: Int; let of: Int }

struct Card: Codable, Identifiable, Hashable {
    let id: String
    var title: String
    var body: String
    let repo: String
    var status: CardStatus
    var priority: Int
    let createdAt: String
    var updatedAt: String
    var turns: Int?
    var turnsIncomplete: Int?
    var attempts: Int?
    var reviewRounds: Int?
    var runAgent: String?
    var reviewAgent: String?
    var planOnly: Bool?
    var idempotencyKey: String?
    var sentinelId: String?
    var dependsOn: [String]?
    var blocked: Bool?
    var prNumber: Int?
    var prUrl: String?
    var prState: String?
    var prChecks: String?
    var prError: String?
    var originMain: String?
    var locallyMerged: Bool?
    var reviewWait: ReviewWait?
    var reviewQueue: ReviewQueuePos?
    var reviewAction: ReviewAction?
    var startQueued: Bool?
    var attachmentCount: Int?
    var lastActivityAt: String?
    var live: LiveActivity?
    var cost: Double?
    var inputTokens: Int?
    var outputTokens: Int?

    var attemptCount: Int { attempts ?? 0 }
    var needsYourReview: Bool { status == .review && reviewWait == nil }
    var isSentinelJob: Bool { sentinelId != nil }
    var repoName: String { Repo.name(repo) }

    enum Activity { case working, waiting, quiet }

    /// src/model.ts cardActivity: drives the animated border on tiles.
    func activity(now: Date = .now) -> Activity? {
        if status == .running {
            if let at = lastActivityAt.flatMap(ISO.parse), now.timeIntervalSince(at) > 5 * 60 { return .quiet }
            return .working
        }
        if status == .review, let wait = reviewWait {
            return wait == .agent_review && reviewQueue == nil ? .working : .waiting
        }
        return nil
    }

    var reviewWaitLabel: String? {
        guard let wait = reviewWait else { return nil }
        if wait == .agent_review, let q = reviewQueue { return "Waiting for agent review (#\(q.position) of \(q.of))" }
        switch wait {
        case .agent_review: return "Agent reviewing"
        case .ci_fix: return "CI fix queued"
        case .github: return "Waiting on GitHub"
        }
    }

    /// src/model.ts dropTargets: where a card may move from its current lane.
    var moveTargets: [CardStatus] {
        let unrun = attemptCount == 0
        switch status {
        case .ready where unrun && blocked == true: return [.triage, .done]
        case .triage: return unrun ? [.ready, .done] : [.ready]
        case .ready: return unrun ? [.triage, .running, .done] : [.running]
        case .failed: return [.ready, .running]
        case .done: return [.archived]
        case .archived: return [.done]
        default: return []
        }
    }

    func waitingOn(_ cards: [Card]) -> [Card] {
        guard blocked == true, let deps = dependsOn else { return [] }
        return cards.filter { deps.contains($0.id) && $0.status != .done && $0.status != .archived }
    }

    /// The first line of the body as plain text, for the tile preview.
    var preview: String? {
        let line = body.split(separator: "\n").map { $0.trimmingCharacters(in: .whitespaces) }
            .first { !$0.isEmpty && !$0.hasPrefix("```") && !$0.hasPrefix("---") }
        guard var text = line else { return nil }
        text = text.replacingOccurrences(of: #"^(#+|[-*+]|\d+\.|>)\s*"#, with: "", options: .regularExpression)
        text = text.replacingOccurrences(of: #"[*_`~]|\[([^\]]*)\]\([^)]*\)"#, with: "$1", options: .regularExpression)
        text = text.trimmingCharacters(in: .whitespaces)
        if text.isEmpty || text.caseInsensitiveCompare(title) == .orderedSame { return nil }
        return text
    }

    func matches(_ query: String) -> Bool {
        let q = query.trimmingCharacters(in: .whitespaces).lowercased()
        if q.isEmpty { return true }
        return id.hasPrefix(q) || title.lowercased().contains(q) || body.lowercased().contains(q)
    }
}

struct AgentModelChoice: Codable, Hashable { var model: String?; var thinking: String? }

struct Board: Codable, Identifiable, Hashable {
    let id: String
    var repo: String
    var icon: String?
    var color: String?
    var remoteUrl: String?
    var integration: String?
    var integrationError: String?
    var integrationWarning: String?
    var autoCollapseEmptySwimlanes: Bool?
    var autoReviewEnabled: Bool?
    var verificationCommand: String?
    var autoReviewMergeLimit: Int?
    var autoPickupEnabled: Bool?
    var pickupConcurrency: Int?
    var pickupDailyLimit: Int?
    var autoPickupStarts: Int?
    var autoPickupError: String?
    var pickupCostBudget: Double?
    var cost24h: Double?
    var autoPickupBudgetReached: Bool?
    var cardCounts: [String: Int]?
    var newCards: Int?
    var chatUnread: Int?

    var name: String { Repo.name(repo) }
    var isGitHubPR: Bool { integration == "github-pr" }
    func count(_ key: String) -> Int { cardCounts?[key] ?? 0 }
    var backlogCount: Int { count("triage") + count("ready") }
    var inProgressCount: Int { count("running") + count("reviewWaiting") }
    var reviewCount: Int { count("review") }
    var failedCount: Int { count("failed") + count("interrupted") }
}

struct Run: Codable, Identifiable, Hashable {
    let id: String
    let attempt: Int
    var status: CardStatus
    var output: String?
    var error: String?
    var worktree: String?
    let startedAt: String
    var finishedAt: String?
    var startedBy: String?
    var agent: String?
    var report: String?
    var failureKind: String?
    var cost: Double?
    var inputTokens: Int?
    var outputTokens: Int?
}

struct AutoReviewJob: Codable, Hashable {
    let runId: String
    let state: String
    var details: String?
    var startedAt: String?
    var finishedAt: String?
    var agent: String?
    var cost: Double?
}

struct ReviewFile: Codable, Hashable { let path: String; let patch: String }
struct ReviewDiff: Codable, Hashable { let fingerprint: String; let files: [ReviewFile] }
struct Fingerprint: Codable { let fingerprint: String }

struct ReviewComment: Codable, Identifiable, Hashable {
    let id: String
    let runId: String?
    let fingerprint: String
    let path: String
    let line: Int
    let fileLine: Int?
    let kind: String?
    let code: String?
    let body: String
    var state: String
    let createdAt: String
}

struct Attachment: Codable, Identifiable, Hashable {
    let id: String
    let cardId: String
    let name: String
    let type: String
    let size: Int
    let createdAt: String
    var isImage: Bool { ["image/png", "image/jpeg", "image/gif", "image/webp"].contains(type) }
}

struct DiscussionMessage: Codable, Identifiable, Hashable {
    let id: String
    let role: String
    let body: String
    let createdAt: String
    var attachments: [Attachment]?
}
struct DiscussionState: Codable { let messages: [DiscussionMessage]; let pending: Bool }

struct HistoryEntry: Codable, Hashable {
    let at: String
    let from: CardStatus?
    let to: CardStatus?
    let text: String
    let detail: String?
}

struct CardRef: Codable, Hashable, Identifiable { let id: String; let title: String; let status: CardStatus }
struct Dependencies: Codable { let dependsOn: [CardRef]; let dependents: [CardRef] }
struct MergeConflict: Codable, Hashable { let cardId: String; let files: [String]; let details: String? }
struct ApprovalState: Codable { let pending: Bool }
struct PushProgress: Codable, Hashable { let step: String?; let log: [String]?; let error: String?; let finishedAt: String? }

struct Chat: Codable, Identifiable, Hashable {
    let id: String
    let boardId: String
    var title: String
    var model: String?
    var thinking: String?
    var topic: String?
    var unread: Int?
    let createdAt: String
    var updatedAt: String
    var pending: Bool?

    /// src/chat-format.ts chatLabel.
    var label: String {
        if let topic, !topic.isEmpty { return Self.clip(topic, words: 6) }
        if !title.isEmpty { return Self.clip(title, words: 5) }
        return "New chat"
    }
    private static func clip(_ s: String, words: Int) -> String {
        let w = s.split(whereSeparator: \.isWhitespace).prefix(words).joined(separator: " ")
        return w.count > 40 ? String(w.prefix(39)) + "…" : w
    }
}

enum ChatPart: Codable, Hashable {
    case text(String)
    case tool(id: String, name: String, input: String, output: String, status: String)

    private enum K: String, CodingKey { case type, text, id, name, input, output, status }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: K.self)
        if try c.decode(String.self, forKey: .type) == "tool" {
            self = .tool(
                id: (try? c.decode(String.self, forKey: .id)) ?? UUID().uuidString,
                name: (try? c.decode(String.self, forKey: .name)) ?? "tool",
                input: Self.stringish(c, .input), output: Self.stringish(c, .output),
                status: (try? c.decode(String.self, forKey: .status)) ?? "done")
        } else {
            self = .text((try? c.decode(String.self, forKey: .text)) ?? "")
        }
    }
    private static func stringish(_ c: KeyedDecodingContainer<K>, _ k: K) -> String {
        if let s = try? c.decode(String.self, forKey: k) { return s }
        if let v = try? c.decode(JSONValue.self, forKey: k),
           let d = try? JSONEncoder().encode(v), let s = String(data: d, encoding: .utf8) { return s }
        return ""
    }
    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: K.self)
        switch self {
        case .text(let t): try c.encode("text", forKey: .type); try c.encode(t, forKey: .text)
        case let .tool(id, name, input, output, status):
            try c.encode("tool", forKey: .type); try c.encode(id, forKey: .id); try c.encode(name, forKey: .name)
            try c.encode(input, forKey: .input); try c.encode(output, forKey: .output); try c.encode(status, forKey: .status)
        }
    }
}

struct ChatMessage: Codable, Identifiable, Hashable {
    let id: String
    let role: String
    let body: String
    var parts: [ChatPart]?
    let createdAt: String
}
struct ChatLive: Codable, Hashable { let startedAt: String?; let parts: [ChatPart] }
struct ChatDetail: Codable { let chat: Chat; let messages: [ChatMessage]; let live: ChatLive? }

struct AppSettings: Codable, Hashable {
    var confirmRunStart: Bool?
    var notifyOnReview: Bool?
    var theme: String?
    var density: String?
    var showCardModels: Bool?
}

struct ServerStatus: Codable { let hostname: String?; let draining: Bool?; let activeRuns: Int? }

// MARK: - Helpers

enum Repo {
    static func name(_ path: String) -> String {
        path.split(separator: "/").last.map(String.init) ?? path
    }
}

enum ISO {
    private static let fractional: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter(); f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]; return f
    }()
    private static let plain = ISO8601DateFormatter()
    static func parse(_ s: String) -> Date? { fractional.date(from: s) ?? plain.date(from: s) }
}

enum Format {
    /// src/api.ts ago: "5m", "3h", "2d".
    static func ago(_ iso: String, now: Date = .now) -> String {
        guard let d = ISO.parse(iso) else { return "" }
        let minutes = max(0, now.timeIntervalSince(d) / 60)
        if minutes < 60 { return "\(Int(minutes))m" }
        if minutes < 1440 { return "\(Int(minutes / 60))h" }
        return "\(Int(minutes / 1440))d"
    }

    private static let dateFormatter: DateFormatter = {
        let f = DateFormatter(); f.setLocalizedDateFormatFromTemplate("MMMd h:mm"); return f
    }()
    /// src/api.ts date: "Nov 8, 9:42 PM".
    static func date(_ iso: String?) -> String {
        guard let iso, let d = ISO.parse(iso) else { return "" }
        return dateFormatter.string(from: d)
    }

    static func cost(_ c: Double?) -> String {
        guard let c else { return "—" }
        if c > 0 && c < 0.01 { return "<$0.01" }
        return String(format: "$%.2f", c)
    }

    static func elapsed(since iso: String?, now: Date = .now) -> String {
        guard let iso, let d = ISO.parse(iso) else { return "" }
        let s = max(0, Int(now.timeIntervalSince(d)))
        return "\(s / 60)m \(s % 60)s"
    }
}

enum CardSort: String, CaseIterable, Identifiable {
    case priority, updated, newest, oldest, title
    var id: String { rawValue }
    var label: String { rawValue.capitalized }

    func sorted(_ cards: [Card]) -> [Card] {
        cards.sorted { a, b in
            if a.priority != b.priority { return a.priority > b.priority }
            switch self {
            case .priority, .updated: return a.updatedAt > b.updatedAt
            case .newest: return a.createdAt > b.createdAt
            case .oldest: return a.createdAt < b.createdAt
            case .title: return a.title.localizedCaseInsensitiveCompare(b.title) == .orderedAscending
            }
        }
    }
}
