import Foundation

/// Talks to a Bakery server's JSON API (`/api/...`), the same endpoints the web board uses.
///
/// The server only answers requests whose Host is loopback or listed in `BAKERY_ALLOWED_HOSTS`,
/// so the base URL must use one of those names (for example `http://mochi:4317`).
/// URLSession sends no Origin header, which the server's mutation check accepts.
struct APIError: LocalizedError {
    let status: Int
    let message: String
    var errorDescription: String? { message }
}

final class APIClient: @unchecked Sendable {
    let baseURL: URL
    private let session: URLSession
    private let decoder: JSONDecoder
    private let encoder = JSONEncoder()

    init(baseURL: URL) {
        self.baseURL = baseURL
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 30
        config.waitsForConnectivity = false
        session = URLSession(configuration: config)
        decoder = JSONDecoder()
    }

    func url(_ path: String) -> URL {
        URL(string: "/api" + path, relativeTo: baseURL)!.absoluteURL
    }

    func get<T: Decodable>(_ path: String, as: T.Type = T.self) async throws -> T {
        try await send(path, method: "GET", body: Optional<Empty>.none)
    }

    @discardableResult
    func post<T: Decodable, B: Encodable>(_ path: String, _ body: B, as: T.Type = T.self) async throws -> T {
        try await send(path, method: "POST", body: body)
    }

    @discardableResult
    func post(_ path: String) async throws -> JSONValue {
        try await send(path, method: "POST", body: Empty())
    }

    @discardableResult
    func patch<T: Decodable, B: Encodable>(_ path: String, _ body: B, as: T.Type = T.self) async throws -> T {
        try await send(path, method: "PATCH", body: body)
    }

    @discardableResult
    func delete(_ path: String) async throws -> JSONValue {
        try await send(path, method: "DELETE", body: Optional<Empty>.none)
    }

    func data(_ path: String) async throws -> Data {
        let (data, response) = try await session.data(from: url(path))
        try check(response, data)
        return data
    }

    private func send<T: Decodable, B: Encodable>(_ path: String, method: String, body: B?) async throws -> T {
        var request = URLRequest(url: url(path))
        request.httpMethod = method
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try encoder.encode(body)
        }
        let (data, response) = try await session.data(for: request)
        try check(response, data)
        do {
            return try decoder.decode(T.self, from: data)
        } catch {
            throw APIError(status: 0, message: "Unexpected response from \(path): \(Self.describe(error))")
        }
    }

    private func check(_ response: URLResponse, _ data: Data) throws {
        guard let http = response as? HTTPURLResponse else { return }
        guard !(200..<300).contains(http.statusCode) else { return }
        let message = (try? JSONDecoder().decode(ErrorBody.self, from: data))?.error
        throw APIError(status: http.statusCode, message: message ?? "Request failed (\(http.statusCode))")
    }

    private static func describe(_ error: Error) -> String {
        guard let error = error as? DecodingError else { return error.localizedDescription }
        switch error {
        case .keyNotFound(let key, let ctx): return "missing \(key.stringValue) at \(ctx.codingPath.map(\.stringValue).joined(separator: "."))"
        case .typeMismatch(_, let ctx), .valueNotFound(_, let ctx), .dataCorrupted(let ctx):
            return "\(ctx.debugDescription) at \(ctx.codingPath.map(\.stringValue).joined(separator: "."))"
        @unknown default: return error.localizedDescription
        }
    }

    private struct ErrorBody: Decodable { let error: String? }
    struct Empty: Codable {}
}

/// Loosely typed JSON for responses the app only needs to acknowledge or peek into.
enum JSONValue: Codable, Hashable {
    case null, bool(Bool), number(Double), string(String), array([JSONValue]), object([String: JSONValue])

    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null }
        else if let v = try? c.decode(Bool.self) { self = .bool(v) }
        else if let v = try? c.decode(Double.self) { self = .number(v) }
        else if let v = try? c.decode(String.self) { self = .string(v) }
        else if let v = try? c.decode([JSONValue].self) { self = .array(v) }
        else { self = .object(try c.decode([String: JSONValue].self)) }
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .null: try c.encodeNil()
        case .bool(let v): try c.encode(v)
        case .number(let v): try c.encode(v)
        case .string(let v): try c.encode(v)
        case .array(let v): try c.encode(v)
        case .object(let v): try c.encode(v)
        }
    }

    subscript(key: String) -> JSONValue? {
        if case .object(let o) = self { return o[key] }
        return nil
    }
    var string: String? { if case .string(let s) = self { return s }; return nil }
    var number: Double? { if case .number(let n) = self { return n }; return nil }
    var bool: Bool? { if case .bool(let b) = self { return b }; return nil }
    var array: [JSONValue]? { if case .array(let a) = self { return a }; return nil }
}
