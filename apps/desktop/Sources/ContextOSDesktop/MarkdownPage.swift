import Foundation

/// Offline Markdown rendering. Raw document HTML is reduced to text and images;
/// scripts, event handlers and arbitrary HTML attributes never enter the page.
enum MarkdownPage {
    static func escape(_ text: String) -> String {
        text.replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "<", with: "&lt;").replacingOccurrences(of: ">", with: "&gt;").replacingOccurrences(of: "\"", with: "&quot;")
    }
    static func replace(_ pattern: String, in text: String, transform: ([String]) -> String) -> String {
        guard let regex = try? NSRegularExpression(pattern: pattern, options: []) else { return text }
        let ns = text as NSString
        var result = text
        for match in regex.matches(in: text, range: NSRange(location: 0, length: ns.length)).reversed() {
            let groups = (0..<match.numberOfRanges).map { match.range(at: $0).location == NSNotFound ? "" : ns.substring(with: match.range(at: $0)) }
            if let range = Range(match.range, in: result) { result.replaceSubrange(range, with: transform(groups)) }
        }
        return result
    }
    static func safeURL(_ value: String) -> String? {
        let decoded = value.trimmingCharacters(in: .whitespacesAndNewlines)
        if decoded.contains(":") {
            guard let scheme = URL(string: decoded)?.scheme?.lowercased(), ["https", "http", "contextos", "block", "chain", "decision", "plan"].contains(scheme) else { return nil }
        }
        return escape(decoded)
    }
    static func inline(_ value: String) -> String {
        var protected: [String] = []
        func token(_ html: String) -> String { protected.append(html); return "\u{E000}\(protected.count - 1)\u{E001}" }
        var text = replace("`([^`]+)`", in: value) { token("<code>\(escape($0[1]))</code>") }
        text = replace("!\\[([^\\]]*)\\]\\(([^)]+)\\)", in: text) { match in
            guard let url = safeURL(match[2]) else { return escape(match[1]) }
            return token("<img loading=\"lazy\" src=\"\(url)\" alt=\"\(escape(match[1]))\"> ")
        }
        text = replace("\\[([^\\]]+)\\]\\(([^)]+)\\)", in: text) { match in
            guard let url = safeURL(match[2]) else { return escape(match[1]) }
            return token("<a href=\"\(url)\">\(escape(match[1]))</a>")
        }
        text = escape(text)
        text = replace("\\*\\*(.+?)\\*\\*", in: text) { "<strong>\($0[1])</strong>" }
        text = replace("(?<!\\*)\\*([^*]+)\\*(?!\\*)", in: text) { "<em>\($0[1])</em>" }
        text = replace("~~(.+?)~~", in: text) { "<del>\($0[1])</del>" }
        for (i, html) in protected.enumerated() { text = text.replacingOccurrences(of: "\u{E000}\(i)\u{E001}", with: html) }
        return text
    }
    static func slug(_ text: String) -> String {
        let value = replace("[^\\p{L}\\p{N}]+", in: text.lowercased()) { _ in "-" }.trimmingCharacters(in: CharacterSet(charactersIn: "-"))
        return value.isEmpty ? "section" : value
    }
    static func render(_ markdown: String, section: String? = nil) -> String {
        var fences: [String] = []
        let protected = replace("(?ms)^(```|~~~)[^\\n]*\\n.*?^\\1[^\\n]*$", in: markdown) { match in
            fences.append(match[0]); return "FENCEDCONTENTTOKEN\(fences.count - 1)ENDTOKEN"
        }
        var clean = replace("(?is)<(script|style|iframe|object)[^>]*>.*?</\\1>", in: protected) { _ in "" }
        clean = replace("(?i)<img[^>]*src=[\"']([^\"']+)[\"'][^>]*>", in: clean) { "![](\($0[1]))" }
        clean = replace("(?i)<h([1-6])[^>]*>(.*?)</h[1-6]>", in: clean) { String(repeating: "#", count: Int($0[1]) ?? 1) + " " + $0[2] }
        // Preserve prose and links from the simple HTML used by repository READMEs.
        clean = replace("(?i)<a[^>]*href=[\"']([^\"']+)[\"'][^>]*>(.*?)</a>", in: clean) { "[\($0[2])](\($0[1]))" }
        for (i, fence) in fences.enumerated() { clean = clean.replacingOccurrences(of: "FENCEDCONTENTTOKEN\(i)ENDTOKEN", with: fence) }
        let lines = clean.components(separatedBy: .newlines)
        var html: [String] = []; var toc: [String] = []; var counts: [String:Int] = [:]
        var index = 0
        while index < lines.count {
            let raw = lines[index]; let line = raw.trimmingCharacters(in: .whitespaces)
            if line.range(of: "^<a id=[\"']([^\"']+)[\"']></a>$", options: .regularExpression) != nil {
                html.append(replace("^<a id=[\"']([^\"']+)[\"']></a>$", in: line) { "<span id=\"\(escape($0[1]))\"></span>" })
            } else if line.hasPrefix("```") || line.hasPrefix("~~~") {
                let fence = String(line.prefix(3)); let language = String(line.dropFirst(3)); var code: [String] = []; index += 1
                while index < lines.count && !lines[index].trimmingCharacters(in: .whitespaces).hasPrefix(fence) { code.append(lines[index]); index += 1 }
                html.append("<pre><span class=\"language\">\(escape(language))</span><code>\(escape(code.joined(separator: "\n")))</code></pre>")
            } else if let match = line.range(of: "^#{1,6} ", options: .regularExpression) {
                let level = line.distance(from: line.startIndex, to: match.upperBound) - 1
                let title = String(line[match.upperBound...]); let base = slug(title); let count = (counts[base] ?? 0) + 1; counts[base] = count
                let id = count == 1 ? base : "\(base)-\(count)"
                toc.append("<a class=\"level-\(level)\" href=\"#\(escape(id))\">\(escape(title))</a>")
                html.append("<h\(level) id=\"\(escape(id))\" class=\"\(id == section ? "selected" : "")\">\(inline(title))</h\(level)>")
            } else if line.hasPrefix("|") && index + 1 < lines.count && lines[index + 1].range(of: "^\\s*\\|?\\s*:?-{3,}", options: .regularExpression) != nil {
                func cells(_ value: String) -> [String] { value.trimmingCharacters(in: CharacterSet(charactersIn: " |\t")).components(separatedBy: "|") }
                html.append("<div class=\"table\"><table><thead><tr>" + cells(line).map { "<th>\(inline($0))</th>" }.joined() + "</tr></thead><tbody>")
                index += 2
                while index < lines.count && lines[index].trimmingCharacters(in: .whitespaces).hasPrefix("|") {
                    html.append("<tr>" + cells(lines[index]).map { "<td>\(inline($0))</td>" }.joined() + "</tr>"); index += 1
                }
                html.append("</tbody></table></div>"); index -= 1
            } else if line == "---" || line == "***" { html.append("<hr>")
            } else if line.hasPrefix(">") { html.append("<blockquote>\(inline(String(line.dropFirst()).trimmingCharacters(in: .whitespaces)))</blockquote>")
            } else if line.range(of: "^([-*+] |[0-9]+[.] )", options: .regularExpression) != nil {
                let item = replace("^([-*+] |[0-9]+[.] )", in: line) { _ in "" }
                let prefix = line.prefix(while: { $0.isNumber || $0 == "." })
                let marker = prefix.isEmpty ? "•" : String(prefix)
                let indent = min(8, raw.prefix(while: { $0 == " " }).count / 2) * 16
                html.append("<div class=\"list-item\" style=\"margin-left:\(indent)px\">\(marker) \(inline(item))</div>")
            } else if !line.isEmpty {
                let plain = replace("<[^>]+>", in: line) { _ in "" }
                if !plain.isEmpty { html.append("<p>\(inline(plain))</p>") }
            }
            index += 1
        }
        return """
        <!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
        <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src contextos-asset: https: http: data:; style-src 'unsafe-inline'; script-src 'none'">
        <style>
        :root{color-scheme:light dark}body{margin:0;font:15px/1.8 -apple-system,BlinkMacSystemFont,sans-serif;color:light-dark(#24292f,#e6edf3);background:light-dark(#fff,#1c1c1e)}
        main{max-width:840px;margin:auto;padding:22px 22px 70px}nav{border-bottom:1px solid #8883;padding:14px 0;margin-bottom:28px}nav a{display:block;font-size:12px;padding:2px 0}.level-2{margin-left:12px}.level-3{margin-left:24px}
        h1{font-size:24px;line-height:1.3}h2{font-size:20px;margin-top:38px}h3{font-size:18px;margin-top:28px}h1,h2,h3,h4{scroll-margin-top:20px}a{color:light-dark(#1769aa,#79b8ff);text-decoration:none}a:hover{text-decoration:underline}
        img{max-width:100%;height:auto;border-radius:8px}pre{position:relative;background:#8881;padding:20px;overflow:auto;border:1px solid #8882;border-radius:8px;line-height:1.5}code{font:12px/1.6 ui-monospace,SFMono-Regular,monospace;background:#8881;border-radius:3px;padding:2px 4px}pre code{background:none;padding:0}.language{display:block;color:#888;font-size:10px;margin-bottom:9px}
        .table{overflow:auto}table{border-collapse:collapse;width:100%;font-size:13px}th,td{text-align:left;border:1px solid #8883;padding:10px 12px}th{background:#8881}blockquote{margin:20px 0;padding:12px 18px;border-left:3px solid #4385bb;background:#4385bb0d}.list-item{padding-left:12px;margin:7px 0}hr{border:0;border-top:1px solid #8883;margin:30px 0}.selected{background:#4385bb22}
        </style></head><body><main><details><summary>目录 / Contents</summary><nav>\(toc.joined())</nav></details>\(html.joined(separator: "\n"))</main></body></html>
        """
    }
}
