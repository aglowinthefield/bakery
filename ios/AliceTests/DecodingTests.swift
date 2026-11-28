import XCTest
@testable import Alice

/// Decodes card lists the way APIClient does (a plain JSONDecoder), without a server.
final class DecodingTests: XCTestCase {
    private func cards(reviewActions: [String]) throws -> [Card] {
        let items = reviewActions.enumerated().map { i, action in
            """
            {"id":"c\(i)","title":"Card \(i)","body":"","repo":"/r","status":"review","priority":0,\
            "createdAt":"2025-01-01T00:00:00.000Z","updatedAt":"2025-01-01T00:00:00.000Z","reviewAction":"\(action)"}
            """
        }
        return try JSONDecoder().decode([Card].self, from: Data("[\(items.joined(separator: ","))]".utf8))
    }

    /// Every value server/board.ts sends, with its reviewActionLabels label, plus one this app doesn't know.
    func testReviewActionsDecodeWithoutFailingTheList() throws {
        let expected: [(String, ReviewAction, String?)] = [
            ("pr_ready", .pr_ready, "PR ready"),
            ("accept_findings", .accept_findings, "Accept findings"),
            ("agent_approved", .agent_approved, "Agent approved"),
            ("needs_you", .needs_you, "Needs you"),
            ("some_future_action", .unknown, nil),
        ]
        let decoded = try cards(reviewActions: expected.map(\.0))
        XCTAssertEqual(decoded.count, expected.count)
        for (card, (raw, action, label)) in zip(decoded, expected) {
            XCTAssertEqual(card.reviewAction, action, raw)
            XCTAssertEqual(card.reviewAction?.label, label, raw)
        }
    }
}
