/**
 * Decision and Rule domain specifications.
 * Rules:
 * 1. Decision is a SINGLE project-wide narrative document with sections.
 * 2. Rules can be multiple files, categorized (api, ui, security, test, etc.).
 */

export const RULE_CATEGORIES = [
  'api',
  'ui',
  'security',
  'test',
  'release',
  'data',
  'performance',
  'architecture',
  'code',
  'general',
];

export class DecisionDocument {
  constructor(rawMarkdown = '') {
    this.rawMarkdown = rawMarkdown;
    this.sections = this.parseSections(rawMarkdown);
  }

  parseSections(markdown) {
    const lines = markdown.split(/\r?\n/);
    const sections = [];
    let currentSection = null;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const match = line.match(/^##\s+\[([a-zA-Z0-9_-]+)\]\s+(.*)$/);
      if (match) {
        if (currentSection) {
          currentSection.content = currentSection.lines.join('\n').trim();
          sections.push(currentSection);
        }
        currentSection = {
          id: match[1],
          title: match[2].trim(),
          startLine: i + 1,
          lines: [],
          content: '',
        };
      } else if (currentSection) {
        currentSection.lines.push(line);
      }
    }

    if (currentSection) {
      currentSection.content = currentSection.lines.join('\n').trim();
      sections.push(currentSection);
    }

    return sections;
  }

  getSection(sectionId) {
    return this.sections.find((s) => s.id === sectionId) || null;
  }

  listSections() {
    return this.sections.map((s) => ({
      id: s.id,
      title: s.title,
      startLine: s.startLine,
    }));
  }

  upsertSection({ id, title, content }) {
    const existingIndex = this.sections.findIndex((s) => s.id === id);
    const formattedContent = `## [${id}] ${title}\n\n${content.trim()}\n`;

    if (existingIndex >= 0) {
      // Replace section in rawMarkdown
      const section = this.sections[existingIndex];
      const regex = new RegExp(`##\\s+\\[${id}\\][\\s\\S]*?(?=(##\\s+\\[|$))`);
      this.rawMarkdown = this.rawMarkdown.replace(regex, formattedContent);
    } else {
      // Append to the end
      this.rawMarkdown = `${this.rawMarkdown.trim()}\n\n${formattedContent}`.trim() + '\n';
    }

    this.sections = this.parseSections(this.rawMarkdown);
    return this.getSection(id);
  }

  toMarkdown() {
    return this.rawMarkdown;
  }
}

export class Rule {
  constructor({
    id,
    title,
    category = 'general',
    summary = '',
    content = '',
    priority = 'normal',
    updatedAt = new Date().toISOString(),
  }) {
    if (!id || typeof id !== 'string') throw new Error('Rule requires id');
    if (!title || typeof title !== 'string') throw new Error('Rule requires title');
    if (!RULE_CATEGORIES.includes(category)) {
      throw new Error(`Invalid rule category: ${category}. Must be one of ${RULE_CATEGORIES.join(', ')}`);
    }

    this.id = id;
    this.title = title;
    this.category = category;
    this.summary = summary;
    this.content = content;
    this.priority = priority;
    this.updatedAt = updatedAt;
  }

  toSummaryJSON() {
    return {
      id: this.id,
      title: this.title,
      category: this.category,
      summary: this.summary,
      priority: this.priority,
    };
  }

  toJSON() {
    return {
      id: this.id,
      title: this.title,
      category: this.category,
      summary: this.summary,
      content: this.content,
      priority: this.priority,
      updatedAt: this.updatedAt,
    };
  }
}
