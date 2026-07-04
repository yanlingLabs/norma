import AppKit
import ApplicationServices

enum ScanResult {
    case candidates([ClickableCandidate])
    case emptyTree   // hit test failed or windowless/childless tree (Chromium pre-poke)
    case timedOut    // deadline exceeded — treat like a failure for degrade counting
}

/// Runs ONLY on StickinessEngine's serial queue — never the main thread (D1).
/// @unchecked Sendable: confined to that one serial queue by construction (the engine
/// never touches it from main); the conformance exists for the queue.async capture.
/// AX coordinates are top-left-origin; candidates are converted to AppKit
/// bottom-left screen coordinates before returning.
final class AXScanner: @unchecked Sendable {
    private let clickableRoles: Set<String> = [
        "AXButton", "AXLink", "AXMenuButton", "AXPopUpButton", "AXCheckBox",
        "AXRadioButton", "AXTextField", "AXTextArea", "AXComboBox", "AXMenuItem",
    ]
    private var pokedPids = Set<pid_t>()
    private(set) var lastHitPid: pid_t = 0

    /// Called when the frontmost app changes — pokes may need re-applying after relaunch.
    func resetPokes() { pokedPids.removeAll() }

    func scan(around point: CGPoint, deadline: TimeInterval) -> ScanResult {
        let start = CFAbsoluteTimeGetCurrent()
        let axPoint = toAXCoordinates(point)

        let systemWide = AXUIElementCreateSystemWide()
        var elementRef: AXUIElement?
        let hitError = withUnsafeMutablePointer(to: &elementRef) { ptr -> AXError in
            var cfEl: AXUIElement?
            let err = AXUIElementCopyElementAtPosition(systemWide, Float(axPoint.x), Float(axPoint.y), &cfEl)
            ptr.pointee = cfEl
            return err
        }
        guard hitError == .success, let hit = elementRef else { return .emptyTree }

        var pid: pid_t = 0
        if AXUIElementGetPid(hit, &pid) == .success, pid != 0 {
            lastHitPid = pid
            if !pokedPids.contains(pid) {
                // D2: Chromium/Electron ship a disabled AX tree until an assistive client
                // announces itself (v1 ClickableStickiness.swift:591-616). No-op for native apps.
                let appEl = AXUIElementCreateApplication(pid)
                AXUIElementSetAttributeValue(appEl, "AXManualAccessibility" as CFString, kCFBooleanTrue)
                AXUIElementSetAttributeValue(appEl, "AXEnhancedUserInterface" as CFString, kCFBooleanTrue)
                pokedPids.insert(pid)
            }
        }

        guard let window = walkUpToWindow(from: hit) else { return .emptyTree }
        var found: [ClickableCandidate] = []
        var visited = 0
        var stack: [AXUIElement] = [window]
        var sawAnyChild = false

        while let el = stack.popLast() {
            visited += 1
            if visited % 32 == 0, CFAbsoluteTimeGetCurrent() - start > deadline { return .timedOut }

            if let role = copyString(el, kAXRoleAttribute), clickableRoles.contains(role),
               let frame = copyFrame(el) {
                let center = CGPoint(x: frame.midX, y: frame.midY)
                if hypot(center.x - axPoint.x, center.y - axPoint.y) <= StickinessConstants.scanRadius {
                    let appKitFrame = toAppKitRect(frame)
                    found.append(ClickableCandidate(center: CGPoint(x: appKitFrame.midX, y: appKitFrame.midY), frame: appKitFrame))
                }
            }
            if let kids = copyChildren(el) {
                if !kids.isEmpty { sawAnyChild = true }
                stack.append(contentsOf: kids)
            }
        }
        if found.isEmpty && !sawAnyChild { return .emptyTree }
        return .candidates(found)
    }

    // MARK: AX helpers

    private func copyString(_ el: AXUIElement, _ attr: String) -> String? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(el, attr as CFString, &value) == .success else { return nil }
        return value as? String
    }

    private func copyChildren(_ el: AXUIElement) -> [AXUIElement]? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(el, kAXChildrenAttribute as CFString, &value) == .success else { return nil }
        return value as? [AXUIElement]
    }

    /// Element frame in AX (top-left-origin) screen coordinates.
    private func copyFrame(_ el: AXUIElement) -> CGRect? {
        var posRef: CFTypeRef?
        var sizeRef: CFTypeRef?
        guard AXUIElementCopyAttributeValue(el, kAXPositionAttribute as CFString, &posRef) == .success,
              AXUIElementCopyAttributeValue(el, kAXSizeAttribute as CFString, &sizeRef) == .success else { return nil }
        var pos = CGPoint.zero
        var size = CGSize.zero
        guard AXValueGetValue(posRef as! AXValue, .cgPoint, &pos),
              AXValueGetValue(sizeRef as! AXValue, .cgSize, &size) else { return nil }
        return CGRect(origin: pos, size: size)
    }

    private func walkUpToWindow(from element: AXUIElement) -> AXUIElement? {
        var current = element
        for _ in 0..<25 {
            if copyString(current, kAXRoleAttribute) == kAXWindowRole as String { return current }
            var parentRef: CFTypeRef?
            guard AXUIElementCopyAttributeValue(current, kAXParentAttribute as CFString, &parentRef) == .success,
                  let parent = parentRef else { return nil }
            current = unsafeDowncast(parent, to: AXUIElement.self)
        }
        return nil
    }

    // MARK: coordinate conversion (AX top-left ↔ AppKit bottom-left)

    private func primaryScreenHeight() -> CGFloat {
        NSScreen.screens.first?.frame.maxY ?? 0
    }

    private func toAXCoordinates(_ p: CGPoint) -> CGPoint {
        CGPoint(x: p.x, y: primaryScreenHeight() - p.y)
    }

    private func toAppKitRect(_ axRect: CGRect) -> CGRect {
        CGRect(x: axRect.origin.x,
               y: primaryScreenHeight() - axRect.origin.y - axRect.height,
               width: axRect.width, height: axRect.height)
    }
}
