import path from "node:path";
import fs from "node:fs";
import { createService } from "./service.mjs";
import { registerProject, resolveProjectPaths } from "./paths.mjs";

function databaseFileIdentity(databasePath) {
  try {
    const stat = fs.statSync(databasePath);
    return `${stat.dev}:${stat.ino}`;
  } catch {
    return null;
  }
}

export class ProjectServiceRouter {
  constructor(options = {}) {
    this.defaultProjectRoot = options.projectRoot ?? process.env.MDFLOW_PROJECT_ROOT;
    this.activeProjectRoot = this.defaultProjectRoot;
    this.dataRoot = options.dataRoot ?? process.env.MDFLOW_DATA_DIR;
    // Keep at most three live SQLite services.  The MCP projectRoot is the
    // source of truth; evicted services are reopened on demand, so this bound
    // limits file descriptors and watcher-like state without losing projects.
    this.maxEntries = options.maxEntries ?? 3;
    this.services = new Map();
    this.serviceIdentities = new Map();
  }

  projectRoot(input = {}) {
    return input.projectRoot ?? this.activeProjectRoot ?? this.defaultProjectRoot ?? process.cwd();
  }

  serviceFor(input = {}) {
    const paths = resolveProjectPaths({ projectRoot: this.projectRoot(input), dataRoot: this.dataRoot });
    const key = path.resolve(paths.projectRoot);
    this.activeProjectRoot = key;
    const cached = this.services.get(key);
    if (cached) {
      const currentIdentity = databaseFileIdentity(paths.databasePath);
      const cachedIdentity = this.serviceIdentities.get(key);
      // Git checkout replaces mdflow.sqlite by rename.  A cached
      // better-sqlite3/DatabaseSync handle can keep reading the unlinked old
      // inode, so never route a new MCP call through it after the file changes.
      if (currentIdentity !== cachedIdentity) {
        cached.close();
        this.services.delete(key);
        this.serviceIdentities.delete(key);
      } else {
        cached.ensureSynced();
        this.services.delete(key);
        this.services.set(key, cached);
        return cached;
      }
    }
    const service = createService({ projectRoot: key, dataRoot: this.dataRoot });
    this.services.set(key, service);
    this.serviceIdentities.set(key, databaseFileIdentity(paths.databasePath));
    while (this.services.size > this.maxEntries) {
      const [oldestKey, oldestService] = this.services.entries().next().value;
      this.services.delete(oldestKey);
      this.serviceIdentities.delete(oldestKey);
      oldestService.close();
    }
    return service;
  }

  register(input = {}) {
    const registered = registerProject(input);
    this.activeProjectRoot = registered.projectRoot;
    return registered;
  }

  close() {
    for (const service of this.services.values()) service.close();
    this.services.clear();
    this.serviceIdentities.clear();
  }
}
