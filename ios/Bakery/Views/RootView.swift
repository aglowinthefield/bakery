import SwiftUI

enum Route: Hashable {
    case today, settings
    case board(String)
}

struct RootView: View {
    @EnvironmentObject private var store: AppStore
    @State private var route: Route? = Self.launchRoute()
    @State private var visibility: NavigationSplitViewVisibility = .automatic

    /// `-startRoute today|settings|board:<id>` lets a simulator run open a screen directly.
    static func launchRoute() -> Route? {
        let value = UserDefaults.standard.string(forKey: "startRoute") ?? ""
        if value == "settings" { return .settings }
        if value.hasPrefix("board:") { return .board(String(value.dropFirst(6))) }
        return value == "today" ? .today : (UIDevice.current.userInterfaceIdiom == .pad ? .today : nil)
    }

    var body: some View {
        Group {
            if !store.isConnected {
                ConnectView()
            } else {
                NavigationSplitView(columnVisibility: $visibility) {
                    SidebarView(route: $route)
                } detail: {
                    NavigationStack {
                        switch route {
                        case .today: TodayView()
                        case .settings: SettingsView()
                        case .board(let id): BoardScreen(boardId: id)
                        case nil: ContentUnavailableView("Pick a screen", systemImage: "sidebar.left")
                        }
                    }
                    .id(route)
                }
                .navigationSplitViewStyle(.balanced)
            }
        }
        .screenBackground()
        .overlay(alignment: .bottom) {
            if let message = store.toast { Toast(message: message).transition(.move(edge: .bottom).combined(with: .opacity)) }
        }
        .animation(.easeOut(duration: 0.2), value: store.toast)
    }
}

struct ConnectView: View {
    @EnvironmentObject private var store: AppStore
    @State private var address = ""
    @State private var testing = false
    @State private var error: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            HStack(spacing: 12) { BrandIcon(size: 44); Wordmark(size: 26) }
            Text("Connect to your Bakery server").font(.ui(22, .semibold))
            Text("Enter the address the server is reachable at, for example mochi (port 4317 is assumed unless you add one). The server must list that hostname in BAKERY_ALLOWED_HOSTS.")
                .font(.ui(14)).foregroundStyle(T.mutedFg)
            TextField("host:4317", text: $address)
                .textInputAutocapitalization(.never).autocorrectionDisabled().keyboardType(.URL)
                .padding(12).background(T.background, in: RoundedRectangle(cornerRadius: 7.5))
                .overlay(RoundedRectangle(cornerRadius: 7.5).stroke(T.border))
            if let error { ErrorBox(title: "Can't connect", message: error) }
            Button { Task { await test() } } label: {
                HStack { if testing { ProgressView().tint(T.primaryFg) }; Text("Connect") }.frame(maxWidth: .infinity)
            }
            .buttonStyle(.pill).disabled(address.trimmingCharacters(in: .whitespaces).isEmpty || testing)
            Spacer()
        }
        .padding(24).frame(maxWidth: 520).frame(maxWidth: .infinity)
        .screenBackground()
        .onAppear { if address.isEmpty { address = store.serverURL } }
    }

    private func test() async {
        testing = true; error = nil
        error = await store.tryConnect(address)
        testing = false
    }
}

struct SidebarView: View {
    @EnvironmentObject private var store: AppStore
    @Binding var route: Route?
    @State private var reposOpen = true

    var body: some View {
        List(selection: $route) {
            HStack(spacing: 10) { BrandIcon(); Wordmark(); Spacer() }
                .listRowBackground(Color.clear).padding(.vertical, 6).selectionDisabled()
            NavigationLink(value: Route.today) {
                Label { Text("Today").font(.ui(15)) } icon: { Image(systemName: "sun.max") }
                    .badge(store.needsYouTotal)
            }
            Section {
                if reposOpen {
                    ForEach(store.boards) { board in
                        NavigationLink(value: Route.board(board.id)) {
                            HStack(spacing: 10) {
                                RepoBadge(icon: board.icon, color: board.color)
                                VStack(alignment: .leading, spacing: 3) {
                                    Text(board.name).font(.ui(15, .medium))
                                    BoardCounts(board: board)
                                }
                                Spacer(minLength: 0)
                                if (board.chatUnread ?? 0) > 0 {
                                    Text("\(board.chatUnread!)").font(.mono(10)).foregroundStyle(T.primaryFg)
                                        .padding(.horizontal, 6).padding(.vertical, 2).background(T.primary, in: Capsule())
                                }
                            }
                        }
                    }
                }
            } header: {
                Button { withAnimation { reposOpen.toggle() } } label: {
                    HStack {
                        Text("Repositories").font(.ui(12, .medium)).textCase(nil)
                        Spacer()
                        Image(systemName: reposOpen ? "chevron.down" : "chevron.right").font(.system(size: 10))
                    }
                }
                .foregroundStyle(T.mutedFg)
            }
            Section {
                NavigationLink(value: Route.settings) { Label("Settings", systemImage: "slider.horizontal.3").font(.ui(15)) }
            }
            if let error = store.connectionError {
                Section { Label(error, systemImage: "wifi.exclamationmark").font(.ui(12)).foregroundStyle(T.destructive) }
            }
        }
        .listStyle(.sidebar)
        .scrollContentBackground(.hidden)
        .background(T.sidebar.ignoresSafeArea())
        .safeAreaInset(edge: .bottom) {
            HStack(spacing: 6) {
                StatusDot(color: store.connectionError == nil ? T.status(.review) : T.destructive, size: 6)
                Text(store.hostname.isEmpty ? "connecting…" : store.hostname).font(.ui(11)).foregroundStyle(T.mutedFg)
                Spacer()
                Text("v0.1").font(.mono(11)).foregroundStyle(T.mutedFg)
            }
            .padding(.horizontal, 16).padding(.vertical, 10)
            .background(T.sidebar)
        }
        .navigationTitle("")
        .navigationBarHidden(true)
    }
}
