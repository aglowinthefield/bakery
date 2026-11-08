import SwiftUI

@main
struct BakeryApp: App {
    @StateObject private var store = AppStore()
    @Environment(\.scenePhase) private var phase

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(store)
                .tint(T.primary)
                .onChange(of: phase) { _, new in
                    if new == .active { store.restartPolling() } else { store.stopPolling() }
                }
        }
    }
}
