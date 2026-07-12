import AppKit
import ApplicationServices
import CoreGraphics
import Foundation
import NormaKit
import ScreenCaptureKit

// -----------------------------------------------------------------------------------------------
// Computer use (Phase 5 CU) — the screenshot / ax-read / input-drive capability implementations
// Norma.app serves behind the peripheral lease. Structured (like HardwareBridge) as a PURE core —
// payload parsing, the AX-tree text formatter, the chord parser, the downscale math — plus a thin
// protocol seam (`ComputerCapabilities`) whose LIVE implementation touches CoreGraphics / the
// accessibility APIs / CGEvent. Tests drive the pure functions directly and the dispatch with a
// FAKE capability, so nothing here needs TCC to be unit-tested; the live paths are LIVE-GATE items
// (real screen capture / AX / input synthesis on a granted Mac).
// -----------------------------------------------------------------------------------------------

/// Default longest-side cap for a captured screenshot (spec §4.11 downscale). Overridable per call
/// via the payload's `maxDim` (settings.computerUse.screenshotMaxDim, threaded core-side).
let cuDefaultScreenshotMaxDim = 1280

/// A resolved click/move/scroll target.
enum CUTarget: Equatable {
    case element(Int)
    case point(x: Double, y: Double)
}

/// A parsed computer-use operation (the wire `payloadJson`'s `op` + fields), validated against the
/// lease class it arrived on. Pure — no CoreGraphics/AX types.
enum ComputerOp: Equatable {
    case screenshot(maxDim: Int?)
    case axSnapshot
    case click(target: CUTarget, button: String, clicks: Int)
    case move(target: CUTarget)
    case type(text: String)
    case key(keys: String)
    case scroll(target: CUTarget?, dx: Int, dy: Int)
}

/// A captured screenshot ready to ship to the model (a `data:` URL + source/scaled dims).
struct CUScreenshot: Equatable {
    let dataUrl: String
    let width: Int
    let height: Int
    let scaledWidth: Int
    let scaledHeight: Int
}

/// The result of performing one op — encoded into the `peripheral.respond` resultJson by the
/// provider (screenshot → {dataUrl,…}, text → {text}, detail → {detail}).
enum CUResult: Equatable {
    case screenshot(CUScreenshot)
    case text(String)
    case detail(String)
}

/// A capability failure whose `message` is sent back verbatim as `peripheral.respond`'s `error`
/// (surfaced to the model by the core `computer` tool as the tool_result). Human-readable and
/// actionable (e.g. a missing-TCC hint), not a bare code.
struct ComputerError: Error, Equatable {
    let message: String
}

// -----------------------------------------------------------------------------------------------
// Pure core: payload parsing, AX-tree formatting, chord parsing, downscale math.
// -----------------------------------------------------------------------------------------------

private struct RawTarget: Decodable { let elementId: Int?; let x: Double?; let y: Double? }
private struct RawPayload: Decodable {
    let op: String
    let maxDim: Int?
    let target: RawTarget?
    let button: String?
    let clicks: Int?
    let text: String?
    let keys: String?
    let dx: Double?
    let dy: Double?
}

private func resolveTarget(_ raw: RawTarget?) -> CUTarget? {
    guard let raw else { return nil }
    if let id = raw.elementId { return .element(id) }
    if let x = raw.x, let y = raw.y { return .point(x: x, y: y) }
    return nil
}

/// Parse `payloadJson` and validate its `op` belongs to the lease `class` it arrived on
/// (screenshot→screenshot, ax-read→ax_snapshot, input-drive→click/move/type/key/scroll). Returns a
/// typed `ComputerError` on any malformed/mismatched payload — the provider forwards its `message`
/// as the call's `error`. Pure + fully unit-tested.
func parseComputerPayload(cls: String, payloadJson: String) -> Result<ComputerOp, ComputerError> {
    guard let raw = try? JSONDecoder().decode(RawPayload.self, from: Data(payloadJson.utf8)) else {
        return .failure(ComputerError(message: "invalid computer payload"))
    }
    switch (cls, raw.op) {
    case ("screenshot", "screenshot"):
        return .success(.screenshot(maxDim: raw.maxDim))
    case ("ax-read", "ax_snapshot"):
        return .success(.axSnapshot)
    case ("input-drive", "click"):
        guard let t = resolveTarget(raw.target) else { return .failure(ComputerError(message: "click needs a target (element_id or x,y)")) }
        return .success(.click(target: t, button: raw.button ?? "left", clicks: max(1, raw.clicks ?? 1)))
    case ("input-drive", "move"):
        guard let t = resolveTarget(raw.target) else { return .failure(ComputerError(message: "move needs a target (element_id or x,y)")) }
        return .success(.move(target: t))
    case ("input-drive", "type"):
        guard let text = raw.text else { return .failure(ComputerError(message: "type needs text")) }
        return .success(.type(text: text))
    case ("input-drive", "key"):
        guard let keys = raw.keys, !keys.isEmpty else { return .failure(ComputerError(message: "key needs a chord")) }
        return .success(.key(keys: keys))
    case ("input-drive", "scroll"):
        return .success(.scroll(target: resolveTarget(raw.target), dx: Int(raw.dx ?? 0), dy: Int(raw.dy ?? 0)))
    default:
        return .failure(ComputerError(message: "op '\(raw.op)' is not valid for class '\(cls)'"))
    }
}

/// One element in an AX snapshot (top-left-origin screen coords, matching CGEvent's global mouse
/// coordinate space, so a center is directly clickable — no Retina/point conversion needed).
struct CUAXElement: Equatable {
    let id: Int
    let role: String
    let label: String?
    let value: String?
    let x: Double
    let y: Double
    let width: Double
    let height: Double
    var centerX: Double { x + width / 2 }
    var centerY: Double { y + height / 2 }
}

/// Format an AX snapshot as a compact numbered text tree the model grounds on. Pure + unit-tested.
/// Example line: `#3 AXButton "Save" @ (840,620)`  (value appended for fields).
func formatAXElements(_ elements: [CUAXElement]) -> String {
    if elements.isEmpty { return "(no accessible elements found in the frontmost window)" }
    return elements.map { el in
        var line = "#\(el.id) \(el.role)"
        if let label = el.label, !label.isEmpty { line += " \"\(label)\"" }
        if let value = el.value, !value.isEmpty { line += " = \"\(value)\"" }
        line += " @ (\(Int(el.centerX.rounded())),\(Int(el.centerY.rounded())))"
        return line
    }.joined(separator: "\n")
}

/// The scaled longest-side-capped dimensions for a source image (spec §4.11 downscale). Never
/// upscales (a source already within `maxDim` is returned unchanged). Pure + unit-tested.
func cuDownscaledSize(width: Int, height: Int, maxDim: Int) -> (width: Int, height: Int) {
    let longest = max(width, height)
    guard longest > maxDim, longest > 0 else { return (width, height) }
    let scale = Double(maxDim) / Double(longest)
    return (max(1, Int((Double(width) * scale).rounded())), max(1, Int((Double(height) * scale).rounded())))
}

/// A parsed key chord: modifier flags + the virtual keycode of the non-modifier key.
struct CUChord: Equatable {
    let flags: CGEventFlags
    let keyCode: CGKeyCode
}

/// Parse a chord like "cmd+shift+4" / "return" / "a" into modifier flags + a virtual keycode. Pure
/// + unit-tested (no CGEvent posting — just the mapping). Returns nil for an unknown key token.
func parseChord(_ chord: String) -> CUChord? {
    let tokens = chord.lowercased().split(separator: "+").map { String($0).trimmingCharacters(in: .whitespaces) }
    guard !tokens.isEmpty else { return nil }
    var flags: CGEventFlags = []
    var keyCode: CGKeyCode?
    for token in tokens {
        switch token {
        case "cmd", "command", "⌘": flags.insert(.maskCommand)
        case "shift", "⇧": flags.insert(.maskShift)
        case "ctrl", "control", "⌃": flags.insert(.maskControl)
        case "opt", "option", "alt", "⌥": flags.insert(.maskAlternate)
        case "fn": flags.insert(.maskSecondaryFn)
        default:
            guard let code = cuKeyCode(for: token) else { return nil }
            keyCode = code
        }
    }
    guard let keyCode else { return nil }
    return CUChord(flags: flags, keyCode: keyCode)
}

/// Virtual keycode for a single (non-modifier) key token. Covers letters, digits, and the common
/// named keys a CU loop uses. Pure + unit-tested.
func cuKeyCode(for token: String) -> CGKeyCode? {
    let letters: [String: Int] = [
        "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9,
        "b": 11, "q": 12, "w": 13, "e": 14, "r": 15, "y": 16, "t": 17, "o": 31, "u": 32,
        "i": 34, "p": 35, "l": 37, "j": 38, "k": 40, "n": 45, "m": 46,
    ]
    let digits: [String: Int] = [
        "1": 18, "2": 19, "3": 20, "4": 21, "5": 23, "6": 22, "7": 26, "8": 28, "9": 25, "0": 29,
    ]
    let named: [String: Int] = [
        "return": 36, "enter": 36, "tab": 48, "space": 49, " ": 49,
        "delete": 51, "backspace": 51, "escape": 53, "esc": 53,
        "left": 123, "right": 124, "down": 125, "up": 126,
        "home": 115, "end": 119, "pageup": 116, "pagedown": 121, "forwarddelete": 117,
        "f1": 122, "f2": 120, "f3": 99, "f4": 118, "f5": 96, "f6": 97,
        "f7": 98, "f8": 100, "f9": 101, "f10": 109, "f11": 103, "f12": 111,
        "minus": 27, "equal": 24, "comma": 43, "period": 47, "slash": 44,
    ]
    if let c = letters[token] ?? digits[token] ?? named[token] { return CGKeyCode(c) }
    return nil
}

// -----------------------------------------------------------------------------------------------
// The capability seam (protocol) + the LIVE implementation.
// -----------------------------------------------------------------------------------------------

/// The slice PeripheralProvider consumes to serve computer-use ops — a seam, like HardwareBridge's
/// `HelperCalling`, so the provider's dispatch is unit-testable with a fake (no TCC). `perform`
/// throws `ComputerError` (its `message` becomes the call's `error`); `clearElementCache` drops the
/// AX handle cache on lease loss/panic.
@MainActor
protocol ComputerCapabilities: AnyObject {
    func perform(_ op: ComputerOp) async throws -> CUResult
    func clearElementCache()
}

/// LIVE — CoreGraphics screen capture, accessibility tree walk, and CGEvent input synthesis. Every
/// method here is a LIVE-GATE item (needs a granted, running Mac); the pure helpers above carry the
/// unit tests. Runs on the main actor (bounded work: a capped AX walk, a one-shot capture, a few
/// CGEvents).
@MainActor
final class LiveComputerCapabilities: ComputerCapabilities {
    /// Max AX elements returned by a snapshot (bounds the walk + the text size).
    private let maxElements = 200
    /// Roles worth surfacing to the model (interactive + a few structural anchors).
    private let interestingRoles: Set<String> = [
        "AXButton", "AXLink", "AXMenuButton", "AXPopUpButton", "AXCheckBox", "AXRadioButton",
        "AXTextField", "AXTextArea", "AXComboBox", "AXMenuItem", "AXTab", "AXTabGroup",
        "AXStaticText", "AXImage", "AXSlider", "AXStepper", "AXDisclosureTriangle", "AXCell",
    ]
    /// elementId → live AXUIElement, rebuilt on each `axSnapshot` and used by element-target clicks.
    private var elementCache: [Int: AXUIElement] = [:]

    func clearElementCache() { elementCache.removeAll() }

    func perform(_ op: ComputerOp) async throws -> CUResult {
        switch op {
        case .screenshot(let maxDim):
            return .screenshot(try await captureScreen(maxDim: maxDim ?? cuDefaultScreenshotMaxDim))
        case .axSnapshot:
            return .text(try snapshotAX())
        case .click(let target, let button, let clicks):
            return .detail(try click(target: target, button: button, clicks: clicks))
        case .move(let target):
            let p = try point(for: target)
            postMouse(type: .mouseMoved, at: p, button: .left)
            return .detail("moved to (\(Int(p.x)),\(Int(p.y)))")
        case .type(let text):
            try typeText(text)
            return .detail("typed \(text.count) character(s)")
        case .key(let keys):
            try pressChord(keys)
            return .detail("pressed \(keys)")
        case .scroll(let target, let dx, let dy):
            if let target { _ = CGWarpMouseCursorPosition(try point(for: target)) }
            postScroll(dx: dx, dy: dy)
            return .detail("scrolled dx=\(dx) dy=\(dy)")
        }
    }

    // MARK: screenshot

    private func captureScreen(maxDim: Int) async throws -> CUScreenshot {
        guard CGPreflightScreenCaptureAccess() else {
            _ = CGRequestScreenCaptureAccess() // triggers the system prompt for next time
            throw ComputerError(message: "screen recording permission not granted — grant Norma in System Settings › Privacy & Security › Screen Recording, then retry")
        }
        // CGDisplayCreateImage is unavailable in the current SDK — capture via ScreenCaptureKit's
        // one-shot SCScreenshotManager (macOS 14+). A point-resolution capture of the main display
        // is plenty for grounding and keeps the base64 well under the NDJSON line cap.
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
        guard let display = content.displays.first else {
            throw ComputerError(message: "no display available to capture")
        }
        let filter = SCContentFilter(display: display, excludingWindows: [])
        let config = SCStreamConfiguration()
        config.width = display.width
        config.height = display.height
        let image: CGImage
        do {
            image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
        } catch {
            throw ComputerError(message: "screen capture failed (\(error.localizedDescription)) — is screen recording permission granted?")
        }
        let srcW = image.width, srcH = image.height
        let (dstW, dstH) = cuDownscaledSize(width: srcW, height: srcH, maxDim: maxDim)
        guard let png = pngData(from: image, width: dstW, height: dstH) else {
            throw ComputerError(message: "screenshot encode failed")
        }
        let dataUrl = "data:image/png;base64,\(png.base64EncodedString())"
        return CUScreenshot(dataUrl: dataUrl, width: srcW, height: srcH, scaledWidth: dstW, scaledHeight: dstH)
    }

    private func pngData(from image: CGImage, width: Int, height: Int) -> Data? {
        let colorSpace = CGColorSpaceCreateDeviceRGB()
        guard let ctx = CGContext(
            data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
            space: colorSpace, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        ) else { return nil }
        ctx.interpolationQuality = .medium
        ctx.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
        guard let scaled = ctx.makeImage() else { return nil }
        let rep = NSBitmapImageRep(cgImage: scaled)
        return rep.representation(using: .png, properties: [:])
    }

    // MARK: ax snapshot (port of AXScanner's tree walk, whole-frontmost-window)

    private func snapshotAX() throws -> String {
        guard AXIsProcessTrusted() else {
            throw ComputerError(message: "accessibility permission not granted — grant Norma in System Settings › Privacy & Security › Accessibility, then retry")
        }
        guard let app = NSWorkspace.shared.frontmostApplication else {
            throw ComputerError(message: "no frontmost application to inspect")
        }
        let appEl = AXUIElementCreateApplication(app.processIdentifier)
        // Poke Chromium/Electron trees awake (same as AXScanner).
        AXUIElementSetAttributeValue(appEl, "AXManualAccessibility" as CFString, kCFBooleanTrue)
        AXUIElementSetAttributeValue(appEl, "AXEnhancedUserInterface" as CFString, kCFBooleanTrue)

        var roots: [AXUIElement] = []
        var focused: CFTypeRef?
        if AXUIElementCopyAttributeValue(appEl, kAXFocusedWindowAttribute as CFString, &focused) == .success, let win = focused {
            roots = [unsafeDowncast(win, to: AXUIElement.self)]
        } else {
            var list: CFTypeRef?
            if AXUIElementCopyAttributeValue(appEl, kAXWindowsAttribute as CFString, &list) == .success,
               let windows = list as? [AXUIElement] { roots = windows }
        }

        elementCache.removeAll()
        var elements: [CUAXElement] = []
        var queue = roots
        var head = 0
        var nextId = 0
        while head < queue.count, elements.count < maxElements {
            let el = queue[head]; head += 1
            if let role = copyString(el, kAXRoleAttribute as String), interestingRoles.contains(role), let frame = copyFrame(el) {
                let id = nextId; nextId += 1
                elementCache[id] = el
                elements.append(CUAXElement(
                    id: id, role: role,
                    label: copyString(el, kAXTitleAttribute as String) ?? copyString(el, kAXDescriptionAttribute as String),
                    value: copyString(el, kAXValueAttribute as String),
                    x: frame.origin.x, y: frame.origin.y, width: frame.size.width, height: frame.size.height))
            }
            if let kids = copyChildren(el) { queue.append(contentsOf: kids) }
        }
        return "\(app.localizedName ?? "app") — \(elements.count) element(s):\n" + formatAXElements(elements)
    }

    private func copyString(_ el: AXUIElement, _ attr: String) -> String? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(el, attr as CFString, &value) == .success else { return nil }
        if let s = value as? String { return s }
        return nil
    }
    private func copyChildren(_ el: AXUIElement) -> [AXUIElement]? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(el, kAXChildrenAttribute as CFString, &value) == .success else { return nil }
        return value as? [AXUIElement]
    }
    private func copyFrame(_ el: AXUIElement) -> CGRect? {
        var posRef: CFTypeRef?; var sizeRef: CFTypeRef?
        guard AXUIElementCopyAttributeValue(el, kAXPositionAttribute as CFString, &posRef) == .success,
              AXUIElementCopyAttributeValue(el, kAXSizeAttribute as CFString, &sizeRef) == .success else { return nil }
        var pos = CGPoint.zero; var size = CGSize.zero
        guard AXValueGetValue(posRef as! AXValue, .cgPoint, &pos), AXValueGetValue(sizeRef as! AXValue, .cgSize, &size) else { return nil }
        return CGRect(origin: pos, size: size)
    }

    // MARK: input synthesis

    private func point(for target: CUTarget) throws -> CGPoint {
        switch target {
        case .point(let x, let y):
            return CGPoint(x: x, y: y)
        case .element(let id):
            guard let el = elementCache[id] else { throw ComputerError(message: "element #\(id) is unknown — run ax_snapshot again to refresh element ids") }
            guard let frame = copyFrame(el) else { throw ComputerError(message: "element #\(id) has no location") }
            return CGPoint(x: frame.midX, y: frame.midY)
        }
    }

    private func click(target: CUTarget, button: String, clicks: Int) throws -> String {
        // AX-PRIMARY: for an element target, try the native press action first (targets the element,
        // not a pixel). Fall back to a synthesized click at the element's center on any failure.
        if case .element(let id) = target, let el = elementCache[id], clicks == 1, button == "left" {
            if AXUIElementPerformAction(el, kAXPressAction as CFString) == .success { return "pressed element #\(id)" }
        }
        let p = try point(for: target)
        let cgButton: CGMouseButton = button == "right" ? .right : .left
        let down: CGEventType = cgButton == .right ? .rightMouseDown : .leftMouseDown
        let up: CGEventType = cgButton == .right ? .rightMouseUp : .leftMouseUp
        for i in 1...max(1, clicks) {
            postMouse(type: down, at: p, button: cgButton, clickCount: i)
            postMouse(type: up, at: p, button: cgButton, clickCount: i)
        }
        return "clicked (\(Int(p.x)),\(Int(p.y)))"
    }

    private func postMouse(type: CGEventType, at point: CGPoint, button: CGMouseButton, clickCount: Int = 1) {
        guard let event = CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: point, mouseButton: button) else { return }
        if clickCount > 1 { event.setIntegerValueField(.mouseEventClickState, value: Int64(clickCount)) }
        event.post(tap: .cghidEventTap)
    }

    private func typeText(_ text: String) throws {
        guard AXIsProcessTrusted() else { throw ComputerError(message: "accessibility permission required to type") }
        for scalar in text.unicodeScalars {
            var utf16 = Array(String(scalar).utf16)
            guard let down = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true),
                  let up = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: false) else { continue }
            down.keyboardSetUnicodeString(stringLength: utf16.count, unicodeString: &utf16)
            up.keyboardSetUnicodeString(stringLength: utf16.count, unicodeString: &utf16)
            down.post(tap: .cghidEventTap)
            up.post(tap: .cghidEventTap)
        }
    }

    private func pressChord(_ keys: String) throws {
        guard AXIsProcessTrusted() else { throw ComputerError(message: "accessibility permission required to press keys") }
        guard let chord = parseChord(keys) else { throw ComputerError(message: "unknown key chord '\(keys)'") }
        guard let down = CGEvent(keyboardEventSource: nil, virtualKey: chord.keyCode, keyDown: true),
              let up = CGEvent(keyboardEventSource: nil, virtualKey: chord.keyCode, keyDown: false) else {
            throw ComputerError(message: "failed to synthesize key event")
        }
        down.flags = chord.flags
        up.flags = chord.flags
        down.post(tap: .cghidEventTap)
        up.post(tap: .cghidEventTap)
    }

    private func postScroll(dx: Int, dy: Int) {
        guard let event = CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 2, wheel1: Int32(dy), wheel2: Int32(dx), wheel3: 0) else { return }
        event.post(tap: .cghidEventTap)
    }
}

/// Encode a `CUResult` into the `peripheral.respond` resultJson shape the core `computer` tool
/// expects. Pure + unit-tested. Uses NormaKit's `JSONValue` (same as `serveNoop`'s echo path).
func encodeCUResult(_ result: CUResult) -> String? {
    let value: JSONValue
    switch result {
    case .screenshot(let s):
        value = .object([
            "dataUrl": .string(s.dataUrl),
            "width": .number(Double(s.width)),
            "height": .number(Double(s.height)),
            "scaledWidth": .number(Double(s.scaledWidth)),
            "scaledHeight": .number(Double(s.scaledHeight)),
        ])
    case .text(let t):
        value = .object(["text": .string(t)])
    case .detail(let d):
        value = .object(["detail": .string(d)])
    }
    guard let data = try? JSONEncoder().encode(value), let json = String(data: data, encoding: .utf8) else { return nil }
    return json
}
