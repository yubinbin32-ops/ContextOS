import SwiftUI
import WebKit
import UniformTypeIdentifiers

struct KnowledgeDocument: Identifiable, Sendable {
    let id: String
    let title: String
    let body: String
    let html: String
    let sourcePath: String
    let revision: Int
    let kind: String
    let relations: [String]
}

@MainActor
final class KnowledgeLibrary: ObservableObject {
    @Published private(set) var documents: [KnowledgeDocument] = []
    @Published private(set) var error: String?
    private var fingerprint = ""

    func reload(root: String) async {
        guard !root.isEmpty else { return }
        let previous = fingerprint
        let result = await Task.detached(priority: .utility) { Self.read(root: root, previous: previous) }.value
        guard !Task.isCancelled, let result else { return }
        fingerprint = result.fingerprint
        documents = result.documents
        error = result.error
    }
    nonisolated private static func read(root: String, previous: String) -> (fingerprint: String, documents: [KnowledgeDocument], error: String?)? {
        let directory = URL(fileURLWithPath: root)
        let names = ["README_zh.md", "README.md", ".contextos/graph.json"]
        let fingerprint = root + names.map { name in
            let attributes = try? FileManager.default.attributesOfItem(atPath: directory.appendingPathComponent(name).path)
            return "\(name):\(attributes?[.modificationDate] ?? ""):\(attributes?[.size] ?? "")"
        }.joined()
        guard fingerprint != previous else { return nil }
        var docs: [KnowledgeDocument] = []
        for name in names.prefix(2) {
            if let body = try? String(contentsOf: directory.appendingPathComponent(name), encoding: .utf8) {
                docs.append(.init(id: name, title: name == "README_zh.md" ? "README · 中文" : "README · English", body: body, html: MarkdownPage.render(body), sourcePath: name, revision: 0, kind: "readme", relations: []))
            }
        }
        do {
            let data = try Data(contentsOf: directory.appendingPathComponent(".contextos/graph.json"))
            if let graph = try JSONSerialization.jsonObject(with: data) as? [String: Any], let tables = graph["data"] as? [String: Any], let rows = tables["documents"] as? [[String: Any]] {
                for row in rows where row["status"] as? String != "archived" {
                    guard let id = row["id"] as? String, let title = row["title"] as? String, let body = row["body"] as? String else { continue }
                    let refs = (row["relations_json"] as? String).flatMap { $0.data(using: .utf8) }.flatMap { try? JSONDecoder().decode([String].self, from: $0) } ?? []
                    docs.append(.init(id: id, title: title, body: body, html: MarkdownPage.render(body), sourcePath: row["source_path"] as? String ?? "README.md", revision: row["revision"] as? Int ?? 1, kind: row["kind"] as? String ?? "note", relations: refs))
                }
            }
            return (fingerprint, docs, nil)
        } catch { return (fingerprint, docs, error.localizedDescription) }
    }
}

/// The same right-side inspector pattern as Blocks and Chains. The canvas stays mounted.
struct KnowledgeView: View {
    @ObservedObject var store: GraphStore
    @ObservedObject var library: KnowledgeLibrary
    let documentID: String
    let section: String?
    let close: () -> Void
    let openDocument: (String, String?) -> Void
    private var chinese: Bool { store.activeLocale == "zh-Hans" }
    private var selected: KnowledgeDocument? { library.documents.first { $0.id == documentID } }

    var body: some View {
        VStack(spacing: 0) {
            if let doc = selected {
                VStack(alignment: .leading, spacing: 12) {
                    HStack(alignment: .top) {
                        Text(doc.title).font(.system(size: 17, weight: .semibold, design: .rounded)).lineLimit(3)
                        Spacer()
                        Button(action: close) { Image(systemName: "xmark").font(.system(size: 11, weight: .semibold)) }
                            .buttonStyle(.plain).help(chinese ? "关闭详情" : "Close details")
                    }
                    Text(doc.kind == "readme" ? (chinese ? "仓库原文件 · 只读" : "Repository file · Read only") : "OS · \(doc.kind) · r\(doc.revision)")
                        .font(.caption).foregroundStyle(.secondary)
                    HStack {
                        Button(chinese ? "复制全文" : "Copy Markdown") { NSPasteboard.general.clearContents(); NSPasteboard.general.setString(doc.body, forType: .string) }
                        if doc.kind == "readme" {
                            Button(chinese ? "在编辑器打开" : "Open in editor") { NSWorkspace.shared.open(URL(fileURLWithPath: store.projectRoot).appendingPathComponent(doc.sourcePath)) }
                        }
                    }.controlSize(.small)
                    if !doc.relations.isEmpty {
                        ScrollView(.horizontal) {
                            HStack {
                                ForEach(doc.relations, id: \.self) { ref in
                                    Button(referenceTitle(ref)) { openReference(ref) }.buttonStyle(.bordered).controlSize(.small)
                                }
                            }
                        }
                    }
                }.padding(18)
                Divider()
                MarkdownWebView(html: doc.html, root: store.projectRoot, sourcePath: doc.sourcePath, section: section, openLink: openLink)
                    .id(store.projectRoot)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .layoutPriority(1)
            } else {
                HStack { Spacer(); Button(action: close) { Image(systemName: "xmark") }.buttonStyle(.plain) }.padding(18)
                ContentUnavailableView(chinese ? "正在读取文档" : "Loading document", systemImage: "doc.text", description: Text(library.error ?? (chinese ? "请从左侧知识栏目选择文档。" : "Select a document in the Knowledge section.")))
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(ContextOSTheme.surface)
    }
    private func referenceTitle(_ ref: String) -> String {
        let parts = ref.split(separator: ":", maxSplits: 1).map(String.init)
        guard parts.count == 2, let type = GraphSelection.EntityType(rawValue: parts[0]) else { return ref }
        return store.title(for: GraphSelection(type: type, id: parts[1]))
    }
    private func openReference(_ ref: String) {
        let parts = ref.split(separator: ":", maxSplits: 1).map(String.init)
        guard parts.count == 2, let type = GraphSelection.EntityType(rawValue: parts[0]) else { return }
        close(); store.select(GraphSelection(type: type, id: parts[1]))
    }
    private func openLink(_ url: URL) {
        if url.scheme == "contextos", let parts = URLComponents(url: url, resolvingAgainstBaseURL: false), let id = parts.queryItems?.first(where: { $0.name == "document" })?.value {
            openDocument(id, parts.queryItems?.first { $0.name == "section" }?.value)
        } else if ["block", "chain", "decision", "plan"].contains(url.scheme ?? "") {
            openReference(url.absoluteString)
        } else if url.scheme == "contextos-asset" {
            let root = URL(fileURLWithPath: store.projectRoot)
            let target = root.appendingPathComponent(url.path).standardizedFileURL
            if let doc = library.documents.first(where: { root.appendingPathComponent($0.sourcePath).standardizedFileURL == target }) { openDocument(doc.id, url.fragment?.removingPercentEncoding) }
            else if target.resolvingSymlinksInPath().path.hasPrefix(root.resolvingSymlinksInPath().path + "/") { NSWorkspace.shared.open(target) }
        } else if ["https", "http"].contains(url.scheme ?? "") { NSWorkspace.shared.open(url) }
    }
}

struct MarkdownWebView: NSViewRepresentable {
    let html: String
    let root: String
    let sourcePath: String
    let section: String?
    let openLink: (URL) -> Void
    func makeCoordinator() -> Coordinator { Coordinator(root: root, openLink: openLink) }
    func makeNSView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.setURLSchemeHandler(context.coordinator, forURLScheme: "contextos-asset")
        config.defaultWebpagePreferences.allowsContentJavaScript = false
        let view = WKWebView(frame: .zero, configuration: config)
        view.navigationDelegate = context.coordinator
        return view
    }
    func updateNSView(_ view: WKWebView, context: Context) {
        context.coordinator.openLink = openLink
        let key = html + sourcePath + (section ?? "")
        guard context.coordinator.key != key else { return }
        context.coordinator.key = key
        let base = URL(string: "contextos-asset://project/")!.appendingPathComponent(sourcePath).deletingLastPathComponent()
        context.coordinator.section = section
        context.coordinator.basePath = base.path
        view.loadHTMLString(html, baseURL: base)
    }
    final class Coordinator: NSObject, WKNavigationDelegate, WKURLSchemeHandler {
        let root: URL
        var openLink: (URL) -> Void
        var key = ""
        var section: String?
        var basePath = ""
        init(root: String, openLink: @escaping (URL) -> Void) { self.root = URL(fileURLWithPath: root).resolvingSymlinksInPath(); self.openLink = openLink }
        func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            if action.navigationType == .linkActivated, let url = action.request.url {
                if let fragment = url.fragment, url.scheme == "about" || (url.scheme == "contextos-asset" && url.path == basePath) {
                    scroll(webView, to: fragment); decisionHandler(.cancel); return
                }
                openLink(url); decisionHandler(.cancel)
            } else { decisionHandler(.allow) }
        }
        func scroll(_ webView: WKWebView, to id: String) {
            guard let data = try? JSONSerialization.data(withJSONObject: [id.removingPercentEncoding ?? id]), let json = String(data: data, encoding: .utf8) else { return }
            webView.evaluateJavaScript("document.getElementById((" + json + ")[0])?.scrollIntoView()", in: nil, in: .defaultClient, completionHandler: { _ in })
        }
        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            if let section { scroll(webView, to: section) }
        }
        func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
            guard let url = task.request.url else { return }
            let file = root.appendingPathComponent(url.path).standardizedFileURL.resolvingSymlinksInPath()
            guard file.path.hasPrefix(root.path + "/"), let data = try? Data(contentsOf: file) else { task.didFailWithError(URLError(.noPermissionsToReadFile)); return }
            let mime = UTType(filenameExtension: file.pathExtension)?.preferredMIMEType ?? "application/octet-stream"
            task.didReceive(URLResponse(url: url, mimeType: mime, expectedContentLength: data.count, textEncodingName: nil))
            task.didReceive(data); task.didFinish()
        }
        func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {}
    }
}
