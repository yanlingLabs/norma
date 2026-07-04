import SwiftUI

@main
struct NormaApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate

    var body: some Scene {
        // LSUIElement app: no windows from the Scene graph in 2b. The orb panel and
        // menu bar are AppKit-owned (AppDelegate). Settings scene keeps SwiftUI happy
        // without showing anything.
        Settings { EmptyView() }
    }
}
