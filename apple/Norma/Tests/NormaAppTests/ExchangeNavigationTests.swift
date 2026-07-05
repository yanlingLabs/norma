import XCTest
@testable import Norma

final class ExchangeNavigationTests: XCTestCase {
    func testNilPlusOlderGoesToLastIndex() {
        XCTAssertEqual(navigateExchange(nil, direction: .older, count: 5), 4)
    }

    func testZeroPlusOlderClampsAtZero() {
        XCTAssertEqual(navigateExchange(0, direction: .older, count: 5), 0)
    }

    func testMidIndexPlusNewerAdvancesByOne() {
        XCTAssertEqual(navigateExchange(2, direction: .newer, count: 5), 3)
    }

    func testLastIndexPlusNewerReturnsToLive() {
        XCTAssertEqual(navigateExchange(4, direction: .newer, count: 5), nil)
    }

    func testNilPlusNewerStaysLive() {
        XCTAssertEqual(navigateExchange(nil, direction: .newer, count: 5), nil)
    }

    func testEmptyHistoryReturnsNilBothDirections() {
        XCTAssertEqual(navigateExchange(nil, direction: .older, count: 0), nil)
        XCTAssertEqual(navigateExchange(nil, direction: .newer, count: 0), nil)
    }
}
