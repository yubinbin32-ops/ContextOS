import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const localDataIgnore = [
  "*",
  "!.gitignore",
  "!project.json",
  "!graph.json",
  "*.sqlite",
  "*.sqlite-*",
  "*.sqlite3",
  "*.sqlite3-*",
  "",
].join("\n");

const DATA_DIRECTORY = ".contextos";
const DATABASE_FILE = "contextos.sqlite";

function resolveDescriptorDirectory(projectRoot) {
  return path.join(projectRoot, DATA_DIRECTORY);
}

function databaseFile(projectDataDirectory) {
  return path.join(projectDataDirectory, DATABASE_FILE);
}

function ensureLocalDataIgnore(descriptorDirectory) {
  const ignorePath = path.join(descriptorDirectory, ".gitignore");
  if (!fs.existsSync(ignorePath)) fs.writeFileSync(ignorePath, localDataIgnore, { flag: "wx" });
}

export function findProjectRoot(startDirectory = process.cwd()) {
  let current = path.resolve(startDirectory);
  while (true) {
    if (fs.existsSync(path.join(current, DATA_DIRECTORY, "project.json"))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      throw new Error(`No ${DATA_DIRECTORY}/project.json found above ${startDirectory}`);
    }
    current = parent;
  }
}

export function findTargetProjectRoot(startDirectory = process.cwd()) {
  let current = path.resolve(startDirectory);
  let gitRoot = null;
  while (true) {
    if (fs.existsSync(path.join(current, DATA_DIRECTORY, "project.json"))) {
      return current;
    }
    if (!gitRoot && fs.existsSync(path.join(current, ".git"))) {
      gitRoot = current;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return gitRoot ?? path.resolve(startDirectory);
}

export function readProjectDescriptor(projectRoot) {
  const descriptorPath = path.join(resolveDescriptorDirectory(projectRoot), "project.json");
  const descriptor = JSON.parse(fs.readFileSync(descriptorPath, "utf8"));
  if (!descriptor.id || !descriptor.name) {
    throw new Error(`${descriptorPath} must contain id and name`);
  }
  return descriptor;
}

export function registerProject(options = {}) {
  if (!options.projectRoot) throw new Error("projectRoot is required to register an contextos project");
  const projectRoot = fs.realpathSync(path.resolve(options.projectRoot));
  if (!fs.statSync(projectRoot).isDirectory()) throw new Error(`${projectRoot} is not a directory`);

  const existingDirectory = resolveDescriptorDirectory(projectRoot);
  const descriptorDir = fs.existsSync(path.join(existingDirectory, "project.json"))
    ? existingDirectory
    : path.join(projectRoot, DATA_DIRECTORY);
  const descriptorPath = path.join(descriptorDir, "project.json");
  if (fs.existsSync(descriptorPath)) {
    ensureLocalDataIgnore(descriptorDir);
    return { projectRoot, descriptor: readProjectDescriptor(projectRoot), created: false };
  }

  const name = String(options.name ?? path.basename(projectRoot)).trim();
  if (!name) throw new Error("Project name must not be empty");
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "project";
  const descriptor = {
    id: String(options.id ?? `${slug}-${crypto.randomUUID().slice(0, 8)}`),
    name,
    schemaVersion: 1,
  };
  fs.mkdirSync(descriptorDir, { recursive: true });
  ensureLocalDataIgnore(descriptorDir);
  const temporaryPath = `${descriptorPath}.tmp-${process.pid}-${crypto.randomUUID()}`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(descriptor, null, 2)}\n`, { flag: "wx" });
  fs.renameSync(temporaryPath, descriptorPath);
  return { projectRoot, descriptor, created: true };
}

export function resolveProjectPaths(options = {}) {
  const projectRoot = findProjectRoot(
    options.projectRoot ??
      process.env.CONTEXTOS_PROJECT_ROOT ??
      process.cwd(),
  );
  const descriptor = readProjectDescriptor(projectRoot);
  const configuredDataRoot = options.dataRoot ?? process.env.CONTEXTOS_DATA_DIR;
  const dataRoot = configuredDataRoot
    ? path.resolve(configuredDataRoot)
    : resolveDescriptorDirectory(projectRoot);
  const projectDataDirectory = configuredDataRoot ? path.join(dataRoot, descriptor.id) : dataRoot;
  fs.mkdirSync(projectDataDirectory, { recursive: true });

  return {
    projectRoot,
    descriptor,
    dataRoot,
    projectDataDirectory,
    databasePath: databaseFile(projectDataDirectory),
    graphJsonPath: path.join(projectDataDirectory, "graph.json"),
  };
}
