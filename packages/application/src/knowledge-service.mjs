import path from 'node:path';
import fs from 'node:fs';
import { DecisionDocument, Rule } from '../../../packages/domain/src/index.mjs';

export class KnowledgeService {
  static getDecisionPath(projectRoot) {
    const defaultPath = path.join(projectRoot, 'DECISION.md');
    if (fs.existsSync(defaultPath)) return defaultPath;
    const dotPath = path.join(projectRoot, '.contextos', 'DECISION.md');
    return fs.existsSync(dotPath) ? dotPath : defaultPath;
  }

  static getDecision(projectRoot) {
    const docPath = this.getDecisionPath(projectRoot);
    if (!fs.existsSync(docPath)) {
      return {
        path: docPath,
        document: new DecisionDocument('# Project Decisions\n'),
      };
    }
    const raw = fs.readFileSync(docPath, 'utf8');
    return {
      path: docPath,
      document: new DecisionDocument(raw),
    };
  }

  static patchDecisionSection(projectRoot, { id, title, content }) {
    const { path: docPath, document } = this.getDecision(projectRoot);
    const updatedSection = document.upsertSection({ id, title, content });
    fs.mkdirSync(path.dirname(docPath), { recursive: true });
    fs.writeFileSync(docPath, document.toMarkdown(), 'utf8');
    return {
      docPath,
      section: updatedSection,
    };
  }

  static getRulesDir(projectRoot) {
    const dotDir = path.join(projectRoot, '.contextos', 'rules');
    if (fs.existsSync(dotDir)) return dotDir;
    const standardDir = path.join(projectRoot, 'rules');
    return fs.existsSync(standardDir) ? standardDir : dotDir;
  }

  static listRules(projectRoot) {
    const rulesDir = this.getRulesDir(projectRoot);
    if (!fs.existsSync(rulesDir)) return [];

    const files = fs.readdirSync(rulesDir).filter((f) => f.endsWith('.md'));
    const rules = [];

    for (const file of files) {
      const filePath = path.join(rulesDir, file);
      const raw = fs.readFileSync(filePath, 'utf8');
      const rule = this.parseRuleFile(file, raw);
      rules.push(rule.toSummaryJSON());
    }

    return rules;
  }

  static getRule(projectRoot, ruleId) {
    const rulesDir = this.getRulesDir(projectRoot);
    if (!fs.existsSync(rulesDir)) return null;
    const targetFile = path.join(rulesDir, `${ruleId}.md`);
    if (!fs.existsSync(targetFile)) {
      // Search by id in directory
      const files = fs.readdirSync(rulesDir).filter((f) => f.endsWith('.md'));
      for (const file of files) {
        const filePath = path.join(rulesDir, file);
        const raw = fs.readFileSync(filePath, 'utf8');
        const rule = this.parseRuleFile(file, raw);
        if (rule.id === ruleId) return rule.toJSON();
      }
      return null;
    }
    const raw = fs.readFileSync(targetFile, 'utf8');
    return this.parseRuleFile(`${ruleId}.md`, raw).toJSON();
  }

  static saveRule(projectRoot, { id, title, category, summary, content, priority = 'normal' }) {
    const rule = new Rule({ id, title, category, summary, content, priority });
    const rulesDir = this.getRulesDir(projectRoot);
    fs.mkdirSync(rulesDir, { recursive: true });
    const targetFile = path.join(rulesDir, `${id}.md`);

    const markdown = `---
id: ${rule.id}
title: ${rule.title}
category: ${rule.category}
priority: ${rule.priority}
summary: ${rule.summary}
---

# ${rule.title}

${rule.content}
`;

    fs.writeFileSync(targetFile, markdown, 'utf8');
    return rule.toJSON();
  }

  static parseRuleFile(fileName, rawText) {
    const idFallback = fileName.replace(/\.md$/, '');
    const frontmatterMatch = rawText.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);

    let id = idFallback;
    let title = idFallback;
    let category = 'general';
    let summary = '';
    let priority = 'normal';
    let content = rawText;

    if (frontmatterMatch) {
      const fm = frontmatterMatch[1];
      content = frontmatterMatch[2].trim();

      for (const line of fm.split('\n')) {
        const match = line.match(/^([a-zA-Z0-9_-]+):\s*(.*)$/);
        if (match) {
          const key = match[1].trim();
          const val = match[2].trim();
          if (key === 'id') id = val;
          if (key === 'title') title = val;
          if (key === 'category') category = val;
          if (key === 'summary') summary = val;
          if (key === 'priority') priority = val;
        }
      }
    }

    return new Rule({ id, title, category, summary, content, priority });
  }
}
