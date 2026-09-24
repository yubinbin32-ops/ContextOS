// 1:1 Port of apps/desktop/Sources/ContextOSDesktop/MarkdownPage.swift

export class MarkdownPage {
  static escape(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  static replace(pattern: RegExp, text: string, transform: (groups: string[]) => string): string {
    return text.replace(pattern, (...args) => {
      const match = args[0];
      const groups = args.slice(0, -2);
      return transform(groups);
    });
  }

  static safeURL(value: string): string | null {
    const decoded = value.trim();
    if (decoded.includes(':')) {
      try {
        const url = new URL(decoded);
        const scheme = url.protocol.replace(':', '').toLowerCase();
        if (!['https', 'http', 'contextos', 'block', 'chain', 'decision', 'plan'].includes(scheme)) {
          return null;
        }
      } catch {
        return null;
      }
    }
    return this.escape(decoded);
  }

  static inline(value: string): string {
    const protectedList: string[] = [];
    const token = (html: string) => {
      protectedList.push(html);
      return `\uE000${protectedList.length - 1}\uE001`;
    };

    let text = value.replace(/`([^`]+)`/g, (_, code) => token(`<code>${this.escape(code)}</code>`));

    text = text.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_, alt, url) => {
      const safe = this.safeURL(url);
      if (!safe) return this.escape(alt);
      return token(`<img loading="lazy" src="${safe}" alt="${this.escape(alt)}"> `);
    });

    text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, url) => {
      const safe = this.safeURL(url);
      if (!safe) return this.escape(label);
      return token(`<a href="${safe}">${this.escape(label)}</a>`);
    });

    text = this.escape(text);
    text = text.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    text = text.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '<em>$1</em>');
    text = text.replace(/~~(.+?)~~/g, '<del>$1</del>');

    for (let i = 0; i < protectedList.length; i++) {
      text = text.replace(`\uE000${i}\uE001`, protectedList[i]);
    }

    return text;
  }

  static slug(text: string): string {
    const value = text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, '-')
      .replace(/^-+|-+$/g, '');
    return value.length === 0 ? 'section' : value;
  }

  static render(markdown: string, section?: string | null): string {
    const fences: string[] = [];
    const protectedText = markdown.replace(/(?:^|\n)(```|~~~)[^\n]*\n[\s\S]*?\n\1[^\n]*(?:\n|$)/g, (match) => {
      fences.push(match);
      return `\nFENCEDCONTENTTOKEN${fences.length - 1}ENDTOKEN\n`;
    });

    let clean = protectedText.replace(/<(script|style|iframe|object)[^>]*>[\s\S]*?<\/\1>/gi, '');
    clean = clean.replace(/<img[^>]*src=["']([^"']+)["'][^>]*>/gi, '![]($1)');
    clean = clean.replace(/<h([1-6])[^>]*>(.*?)<\/h\1>/gi, (_, lvl, content) => '#'.repeat(parseInt(lvl)) + ' ' + content);
    clean = clean.replace(/<a[^>]*href=["']([^"']+)["'][^>]*>(.*?)<\/a>/gi, '[$2]($1)');

    for (let i = 0; i < fences.length; i++) {
      clean = clean.replace(`FENCEDCONTENTTOKEN${i}ENDTOKEN`, fences[i].trim());
    }

    const lines = clean.split(/\r?\n/);
    const html: string[] = [];
    const toc: string[] = [];
    const counts: Record<string, number> = {};
    let index = 0;

    while (index < lines.length) {
      const raw = lines[index];
      const line = raw.trim();

      const anchorMatch = line.match(/^<a id=["']([^"']+)["']><\/a>$/);
      if (anchorMatch) {
        html.push(`<span id="${this.escape(anchorMatch[1])}"></span>`);
      } else if (line.startsWith('```') || line.startsWith('~~~')) {
        const fence = line.substring(0, 3);
        const language = line.substring(3).trim();
        const code: string[] = [];
        index += 1;
        while (index < lines.length && !lines[index].trim().startsWith(fence)) {
          code.push(lines[index]);
          index += 1;
        }
        html.push(`<pre><span class="language">${this.escape(language)}</span><code>${this.escape(code.join('\n'))}</code></pre>`);
      } else if (/^#{1,6}\s/.test(line)) {
        const match = line.match(/^(#{1,6})\s+(.*)$/);
        if (match) {
          const level = match[1].length;
          const title = match[2];
          const base = this.slug(title);
          const count = (counts[base] || 0) + 1;
          counts[base] = count;
          const id = count === 1 ? base : `${base}-${count}`;
          toc.push(`<a class="level-${level}" href="#${this.escape(id)}">${this.escape(title)}</a>`);
          html.push(`<h${level} id="${this.escape(id)}" class="${id === section ? 'selected' : ''}">${this.inline(title)}</h${level}>`);
        }
      } else if (line.startsWith('|') && index + 1 < lines.length && /^\s*\|?\s*:?-{3,}/.test(lines[index + 1])) {
        const cells = (value: string) => value.replace(/^\||\|$/g, '').split('|').map((s) => s.trim());
        html.push('<div class="table"><table><thead><tr>' + cells(line).map((c) => `<th>${this.inline(c)}</th>`).join('') + '</tr></thead><tbody>');
        index += 2;
        while (index < lines.length && lines[index].trim().startsWith('|')) {
          html.push('<tr>' + cells(lines[index]).map((c) => `<td>${this.inline(c)}</td>`).join('') + '</tr>');
          index += 1;
        }
        html.push('</tbody></table></div>');
        index -= 1;
      } else if (line === '---' || line === '***') {
        html.push('<hr>');
      } else if (line.startsWith('>')) {
        html.push(`<blockquote>${this.inline(line.substring(1).trim())}</blockquote>`);
      } else if (/^([-*+] |\d+\. )/.test(line)) {
        const item = line.replace(/^([-*+] |\d+\. )/, '');
        const markerMatch = line.match(/^(\d+\.)/);
        const marker = markerMatch ? markerMatch[1] : '•';
        const indent = Math.min(8, Math.floor((raw.length - raw.trimStart().length) / 2)) * 16;
        html.push(`<div class="list-item" style="margin-left:${indent}px">${marker} ${this.inline(item)}</div>`);
      } else if (line.length > 0) {
        const plain = line.replace(/<[^>]+>/g, '');
        if (plain.length > 0) {
          html.push(`<p>${this.inline(plain)}</p>`);
        }
      }
      index += 1;
    }

    return `
      <details><summary>目录 / Contents</summary><nav>${toc.join('')}</nav></details>
      ${html.join('\n')}
    `;
  }
}
