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
}
