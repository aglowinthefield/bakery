import XCTest

/// Drives the app against a live server. Launch environment:
///   BAKERY_URL    server address (default http://mochi:4317)
///   BAKERY_BOARD  board id to open (use a scratch board; these tests create and move cards)
/// Screenshots are written to /tmp/bakery-uitest-<name>.png.
final class FlowTests: XCTestCase {
    var app: XCUIApplication!

    override func setUp() {
        continueAfterFailure = false
        app = XCUIApplication()
        let env = ProcessInfo.processInfo.environment
        let board = env["BAKERY_BOARD"] ?? env["SIMCTL_CHILD_BAKERY_BOARD"] ?? ""
        let url = env["BAKERY_URL"] ?? "http://mochi:4317"
        app.launchArguments = ["-serverURL", url, "-startRoute", "board:\(board)"]
        if name.contains("Review"), let card = env["BAKERY_CARD"], !card.isEmpty { app.launchArguments += ["-startCard", card] }
        app.launch()
    }

    func shot(_ name: String) {
        let data = XCUIScreen.main.screenshot().pngRepresentation
        try? data.write(to: URL(fileURLWithPath: "/tmp/bakery-uitest-\(name).png"))
    }

    func testCreateAndMoveCard() {
        let title = "UI test card \(Int(Date().timeIntervalSince1970) % 100000)"
        let new = app.buttons["New card"]
        XCTAssertTrue(new.waitForExistence(timeout: 15))
        new.tap()
        let titleField = app.textFields["What needs doing?"]
        XCTAssertTrue(titleField.waitForExistence(timeout: 5))
        titleField.tap()
        titleField.typeText(title)
        shot("1-new-card-sheet")
        app.buttons["Create"].tap()

        let tile = app.buttons.containing(NSPredicate(format: "label CONTAINS %@", title)).firstMatch
        XCTAssertTrue(tile.waitForExistence(timeout: 10), "created card appears on the board")
        shot("2-board-with-new-card")
        tile.tap()

        XCTAssertTrue(app.staticTexts[title].waitForExistence(timeout: 5))
        let ready = app.buttons["Move to Ready"]
        XCTAssertTrue(ready.waitForExistence(timeout: 5))
        shot("3-card-detail")
        ready.tap()
        XCTAssertTrue(app.staticTexts["Ready"].waitForExistence(timeout: 10), "status becomes Ready")
        shot("4-card-ready")
        app.buttons["Move to Triage"].tap()
        XCTAssertTrue(app.staticTexts["Triage"].waitForExistence(timeout: 10))
    }

    func testChatTab() {
        XCTAssertTrue(app.buttons["Chat"].waitForExistence(timeout: 15))
        app.buttons["Chat"].tap()
        sleep(2)
        shot("5-chat")
    }

    func testSearch() {
        let search = app.buttons["Search"]
        XCTAssertTrue(search.waitForExistence(timeout: 15))
        search.tap()
        let field = app.textFields["Search cards"]
        XCTAssertTrue(field.waitForExistence(timeout: 5))
        field.tap(); field.typeText("onboarding")
        sleep(1)
        shot("6-search")
        XCTAssertTrue(app.staticTexts["Write onboarding copy"].exists)
    }

    /// Needs BAKERY_CARD: a card in Review whose diff adds a line containing "Hello from Bakery iOS".
    func testReviewCommentAndApprove() throws {
        try XCTSkipIf((ProcessInfo.processInfo.environment["BAKERY_CARD"] ?? "").isEmpty, "BAKERY_CARD not set")
        let reviewTab = app.buttons["Review"]
        XCTAssertTrue(reviewTab.waitForExistence(timeout: 15))
        reviewTab.tap()
        let line = app.staticTexts["Hello from Bakery iOS"]
        _ = line.waitForExistence(timeout: 10)
        shot("7-review-diff")
        XCTAssertTrue(line.exists, "diff shows the added line")
        line.tap()
        let box = app.textFields.matching(NSPredicate(format: "placeholderValue BEGINSWITH %@", "Comment on line")).firstMatch
        XCTAssertTrue(box.waitForExistence(timeout: 5))
        box.tap(); box.typeText("Looks good")
        app.buttons["Add comment"].tap()
        XCTAssertTrue(app.staticTexts["Looks good"].waitForExistence(timeout: 10), "comment appears")
        shot("8-review-comment")
        app.buttons["Approve and merge"].tap()
        app.alerts.buttons["Continue"].tap()
        XCTAssertTrue(app.staticTexts["Done"].waitForExistence(timeout: 30), "card is merged and Done")
        shot("9-merged")
    }
}
