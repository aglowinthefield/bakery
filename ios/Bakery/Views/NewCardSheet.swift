import SwiftUI

struct NewCardSheet: View {
    @EnvironmentObject private var store: AppStore
    @Environment(\.dismiss) private var dismiss
    let board: Board?
    var editing: Card?
    @State private var title = ""
    @State private var text = ""
    @State private var priority = 0
    @State private var saving = false

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    field("Title") { TextField("What needs doing?", text: $title).padding(.horizontal, 12).frame(height: 40) }
                    field("Description (Markdown)") {
                        TextField("Details, links, acceptance criteria…", text: $text, axis: .vertical).lineLimit(6...16).padding(12)
                    }
                    Stepper(value: $priority, in: -100...100, step: 10) {
                        HStack { Text("Priority").font(.ui(14)); Text("\(priority)").font(.mono(14)).foregroundStyle(T.priority(priority)) }
                    }
                }
                .padding(16)
            }
            .screenBackground()
            .navigationTitle(editing == nil ? "New card" : "Edit card")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .topBarTrailing) {
                    Button(editing == nil ? "Create" : "Save") { Task { await save() } }
                        .disabled(title.trimmingCharacters(in: .whitespaces).isEmpty || saving)
                }
            }
        }
        .onAppear {
            if let c = editing { title = c.title; text = c.body; priority = c.priority }
        }
    }

    private func field<C: View>(_ label: String, @ViewBuilder _ content: () -> C) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(label).font(.ui(13, .medium)).foregroundStyle(T.mutedFg)
            content().overlay(RoundedRectangle(cornerRadius: 7.5).stroke(T.foreground.opacity(0.85), lineWidth: 1.5))
        }
    }

    private func save() async {
        guard let api = store.api, let boardId = board?.id ?? store.boards.first?.id else { return }
        saving = true
        struct Create: Encodable { let title: String; let body: String; let priority: Int; let origin = "ui" }
        struct Edit: Encodable { let title: String; let body: String; let priority: Int }
        let ok = await store.act {
            if let c = editing { let _: Card = try await api.patch("/boards/\(boardId)/cards/\(c.id)", Edit(title: title, body: text, priority: priority)) }
            else { let _: Card = try await api.post("/boards/\(boardId)/cards", Create(title: title, body: text, priority: priority)) }
        }
        saving = false
        if ok { dismiss() }
    }
}
