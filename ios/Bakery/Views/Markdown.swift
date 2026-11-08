import SwiftUI

/// Small block parser covering what Bakery text uses (src/markdown.ts): headings, paragraphs, fenced code,
/// quotes, lists with task boxes, rules, tables, and images from card attachment or chat image URLs.
enum MDBlock: Identifiable {
    case heading(Int, String), paragraph(String), code(String, String?), quote(String)
    case list([MDItem], ordered: Bool), rule, table([String], [[String]]), image(alt: String, path: String)
    var id: UUID { UUID() }
}
struct MDItem: Identifiable { let id = UUID(); let text: String; let checked: Bool? }

enum MDParser {
    static func parse(_ source: String) -> [MDBlock] {
        let lines = source.replacingOccurrences(of: "\r\n", with: "\n").components(separatedBy: "\n")
        var blocks: [MDBlock] = []
        var i = 0
        func paragraphBreak(_ s: String) -> Bool {
            let t = s.trimmingCharacters(in: .whitespaces)
            return t.isEmpty || t.hasPrefix("```") || t.hasPrefix("#") || t.hasPrefix(">") || listMarker(t) != nil
        }
        while i < lines.count {
            let line = lines[i]
            let t = line.trimmingCharacters(in: .whitespaces)
            if t.isEmpty { i += 1; continue }
            if t.hasPrefix("```") {
                let lang = String(t.dropFirst(3)).trimmingCharacters(in: .whitespaces)
                var body: [String] = []
                i += 1
                while i < lines.count, !lines[i].trimmingCharacters(in: .whitespaces).hasPrefix("```") { body.append(lines[i]); i += 1 }
                i += 1
                blocks.append(.code(body.joined(separator: "\n"), lang.isEmpty ? nil : lang))
                continue
            }
            if let m = t.range(of: #"^#{1,6}\s+"#, options: .regularExpression) {
                let level = t[m].filter { $0 == "#" }.count
                blocks.append(.heading(level, String(t[m.upperBound...]).trimmingCharacters(in: CharacterSet(charactersIn: "# "))))
                i += 1; continue
            }
            if t.range(of: #"^([-*_]\s*){3,}$"#, options: .regularExpression) != nil { blocks.append(.rule); i += 1; continue }
            if t.hasPrefix(">") {
                var q: [String] = []
                while i < lines.count, lines[i].trimmingCharacters(in: .whitespaces).hasPrefix(">") {
                    q.append(String(lines[i].trimmingCharacters(in: .whitespaces).dropFirst()).trimmingCharacters(in: .init(charactersIn: " ")))
                    i += 1
                }
                blocks.append(.quote(q.joined(separator: "\n"))); continue
            }
            if t.hasPrefix("|"), i + 1 < lines.count, lines[i + 1].range(of: #"^\s*\|?[\s:|-]+\|[\s:|-]*$"#, options: .regularExpression) != nil {
                let header = cells(t)
                i += 2
                var rows: [[String]] = []
                while i < lines.count, lines[i].trimmingCharacters(in: .whitespaces).hasPrefix("|") { rows.append(cells(lines[i])); i += 1 }
                blocks.append(.table(header, rows)); continue
            }
            if let first = listMarker(t) {
                var items: [MDItem] = []
                let ordered = first.ordered
                while i < lines.count, let marker = listMarker(lines[i].trimmingCharacters(in: .whitespaces)) {
                    var text = marker.text
                    var checked: Bool?
                    if text.hasPrefix("[ ] ") { checked = false; text = String(text.dropFirst(4)) }
                    else if text.lowercased().hasPrefix("[x] ") { checked = true; text = String(text.dropFirst(4)) }
                    i += 1
                    while i < lines.count, lines[i].hasPrefix("  "), listMarker(lines[i].trimmingCharacters(in: .whitespaces)) == nil,
                          !lines[i].trimmingCharacters(in: .whitespaces).isEmpty {
                        text += "\n" + lines[i].trimmingCharacters(in: .whitespaces); i += 1
                    }
                    items.append(MDItem(text: text, checked: checked))
                }
                blocks.append(.list(items, ordered: ordered)); continue
            }
            var para: [String] = [t]
            i += 1
            while i < lines.count, !paragraphBreak(lines[i]) { para.append(lines[i].trimmingCharacters(in: .whitespaces)); i += 1 }
            let text = para.joined(separator: "\n")
            if para.count == 1, let m = text.range(of: #"^!\[([^\]]*)\]\((/api/[^)\s]+)\)$"#, options: .regularExpression) {
                let inner = String(text[m])
                if let a = inner.range(of: #"\[[^\]]*\]"#, options: .regularExpression), let p = inner.range(of: #"\(/api/[^)]+\)"#, options: .regularExpression) {
                    blocks.append(.image(alt: String(inner[a].dropFirst().dropLast()), path: String(inner[p].dropFirst().dropLast()))); continue
                }
            }
            blocks.append(.paragraph(text))
        }
        return blocks
    }

    private static func cells(_ row: String) -> [String] {
        var t = row.trimmingCharacters(in: .whitespaces)
        if t.hasPrefix("|") { t.removeFirst() }
        if t.hasSuffix("|") { t.removeLast() }
        return t.components(separatedBy: "|").map { $0.trimmingCharacters(in: .whitespaces) }
    }

    private static func listMarker(_ t: String) -> (text: String, ordered: Bool)? {
        if let r = t.range(of: #"^[-*+]\s+"#, options: .regularExpression) { return (String(t[r.upperBound...]), false) }
        if let r = t.range(of: #"^\d+[.)]\s+"#, options: .regularExpression) { return (String(t[r.upperBound...]), true) }
        return nil
    }
}

struct MarkdownView: View {
    @EnvironmentObject private var store: AppStore
    let source: String
    var size: CGFloat = 14

    var body: some View {
        let blocks = MDParser.parse(source)
        VStack(alignment: .leading, spacing: size * 0.75) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { _, block in render(block) }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    static func inline(_ text: String) -> AttributedString {
        var options = AttributedString.MarkdownParsingOptions()
        options.interpretedSyntax = .inlineOnlyPreservingWhitespace
        return (try? AttributedString(markdown: text, options: options)) ?? AttributedString(text)
    }

    @ViewBuilder private func render(_ block: MDBlock) -> some View {
        switch block {
        case .heading(let level, let text):
            Text(Self.inline(text)).font(.ui(size * (level == 1 ? 1.35 : level == 2 ? 1.2 : 1.05), .semibold)).padding(.top, size * 0.4)
        case .paragraph(let text):
            Text(Self.inline(text)).font(.ui(size)).foregroundStyle(T.foreground.opacity(0.9)).lineSpacing(size * 0.3)
        case .code(let body, _):
            ScrollView(.horizontal, showsIndicators: false) {
                Text(body).font(.mono(size * 0.85)).fixedSize(horizontal: true, vertical: false).padding(.vertical, 10).padding(.horizontal, 12)
            }
            .background(T.code, in: RoundedRectangle(cornerRadius: 6))
            .overlay(RoundedRectangle(cornerRadius: 6).stroke(T.border))
        case .quote(let text):
            HStack(spacing: 10) {
                Rectangle().fill(T.border).frame(width: 3)
                Text(Self.inline(text)).font(.ui(size)).foregroundStyle(T.mutedFg)
            }
        case .list(let items, let ordered):
            VStack(alignment: .leading, spacing: 4) {
                ForEach(Array(items.enumerated()), id: \.offset) { index, item in
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        if let checked = item.checked {
                            Image(systemName: checked ? "checkmark.square" : "square").font(.ui(size)).foregroundStyle(T.mutedFg)
                        } else {
                            Text(ordered ? "\(index + 1)." : "•").font(.ui(size)).foregroundStyle(T.mutedFg).frame(minWidth: 16, alignment: .trailing)
                        }
                        Text(Self.inline(item.text)).font(.ui(size)).foregroundStyle(T.foreground.opacity(0.9))
                    }
                }
            }
            .padding(.leading, 6)
        case .rule: Divider().overlay(T.border)
        case .table(let header, let rows):
            ScrollView(.horizontal, showsIndicators: false) {
                VStack(alignment: .leading, spacing: 0) {
                    row(header, bold: true)
                    ForEach(Array(rows.enumerated()), id: \.offset) { _, r in row(r, bold: false) }
                }
                .overlay(RoundedRectangle(cornerRadius: 4).stroke(T.border))
            }
        case .image(let alt, let path):
            if let api = store.api {
                AsyncImage(url: URL(string: path, relativeTo: api.baseURL)?.absoluteURL) { phase in
                    switch phase {
                    case .success(let image): image.resizable().scaledToFit().clipShape(RoundedRectangle(cornerRadius: 6))
                    case .failure: Text(alt.isEmpty ? "Image" : alt).font(.ui(12)).foregroundStyle(T.mutedFg)
                    default: ProgressView()
                    }
                }
            }
        }
    }

    private func row(_ cells: [String], bold: Bool) -> some View {
        HStack(spacing: 0) {
            ForEach(Array(cells.enumerated()), id: \.offset) { _, c in
                Text(Self.inline(c)).font(.ui(size * 0.9, bold ? .semibold : .regular))
                    .padding(.horizontal, 8).padding(.vertical, 5).frame(width: 140, alignment: .leading)
                    .background(bold ? T.muted : .clear)
                    .overlay(Rectangle().stroke(T.border, lineWidth: 0.5))
            }
        }
    }
}
