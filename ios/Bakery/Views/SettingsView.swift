import SwiftUI

struct SettingsView: View {
    @EnvironmentObject private var store: AppStore
    @State private var address = ""
    @State private var reconnectError: String?
    @State private var reconnecting = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                Text("Settings").font(.ui(32, .bold)).tracking(-1.5)
                Bordered {
                    VStack(alignment: .leading, spacing: 10) {
                        Text("Server").font(.ui(15, .semibold))
                        TextField("host:4317", text: $address).textInputAutocapitalization(.never).autocorrectionDisabled().keyboardType(.URL)
                            .padding(10).overlay(RoundedRectangle(cornerRadius: 7.5).stroke(T.border))
                        HStack {
                            Button("Reconnect") { Task { await reconnect() } }.buttonStyle(.pill)
                                .disabled(address == store.serverURL || reconnecting)
                            Button("Disconnect") { store.serverURL = ""; store.connect() }.buttonStyle(.pill(.outline))
                        }
                        if let e = reconnectError ?? store.connectionError { Text(e).font(.ui(12)).foregroundStyle(T.destructive) }
                    }
                }
                Bordered {
                    VStack(alignment: .leading, spacing: 12) {
                        Text("Behaviour").font(.ui(15, .semibold))
                        Toggle("Confirm before starting a run", isOn: binding(\.confirmRunStart))
                        Toggle("Show agent models on cards", isOn: binding(\.showCardModels))
                    }
                    .font(.ui(14))
                }
            }
            .padding(20).frame(maxWidth: 640).frame(maxWidth: .infinity)
        }
        .screenBackground()
        .onAppear { address = store.serverURL; store.watchedBoard = nil; store.watchingToday = false }
    }

    private func reconnect() async {
        reconnecting = true; reconnectError = nil
        reconnectError = await store.tryConnect(address)
        reconnecting = false
    }

    private func binding(_ key: WritableKeyPath<AppSettings, Bool?>) -> Binding<Bool> {
        Binding(get: { store.settings[keyPath: key] ?? false }, set: { v in
            store.settings[keyPath: key] = v
            Task { await store.act { let _: AppSettings = try await store.api!.patch("/settings", store.settings) } }
        })
    }
}
