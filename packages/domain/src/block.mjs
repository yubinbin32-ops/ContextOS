/**
 * Block domain entity.
 * Invariant: Block MUST correspond to real code. NO Ghost Blocks allowed.
 */

export class ArtifactRef {
  constructor({
    path,
    symbol = null,
    anchorKind = symbol ? 'symbol' : 'file',
    startLine = null,
    endLine = null,
    hash = '',
    role = 'implementation',
    hashMode = null,
    manifest = null,
  }) {
    if (!path || typeof path !== 'string') throw new Error('ArtifactRef requires a valid string path');
    if (!['symbol', 'file', 'tree'].includes(anchorKind)) {
      throw new Error(`ArtifactRef requires a valid anchorKind, received '${anchorKind}'`);
    }
    const resolvedHashMode = anchorKind === 'tree' ? hashMode || (manifest ? 'manifest' : 'content') : null;
    if (resolvedHashMode && !['content', 'manifest'].includes(resolvedHashMode)) {
      throw new Error(`ArtifactRef requires a valid tree hashMode, received '${resolvedHashMode}'`);
    }
    if (anchorKind === 'tree' && resolvedHashMode === 'manifest' && !manifest) {
      throw new Error('ArtifactRef tree manifest anchors require a manifest path');
    }
    this.path = path;
    this.symbol = anchorKind === 'tree' ? null : symbol;
    this.anchorKind = anchorKind;
    this.startLine = anchorKind === 'tree' || startLine === null ? null : Number(startLine);
    this.endLine = anchorKind === 'tree' || endLine === null ? null : Number(endLine);
    this.hash = hash;
    this.role = role;
    this.hashMode = resolvedHashMode;
    this.manifest = anchorKind === 'tree' ? manifest : null;
  }

  toJSON() {
    return {
      path: this.path,
      symbol: this.symbol,
      anchorKind: this.anchorKind,
      startLine: this.startLine,
      endLine: this.endLine,
      hash: this.hash,
      role: this.role,
      hashMode: this.hashMode,
      manifest: this.manifest,
    };
  }
}

export class Block {
  constructor({
    id,
    projectId,
    title,
    kind = 'service',
    summary = '',
    details = '',
    artifactRefs = [],
    history = [],
    createdAt = new Date().toISOString(),
    updatedAt = new Date().toISOString(),
  }) {
    if (!id || typeof id !== 'string') throw new Error('Block requires a valid string id');
    if (!projectId || typeof projectId !== 'string') throw new Error('Block requires projectId');
    if (!title || typeof title !== 'string') throw new Error('Block requires title');

    // Invariant: Reject ghost blocks.
    if (!Array.isArray(artifactRefs) || artifactRefs.length === 0) {
      throw new Error(
        `Ghost Block rejected: Block '${id}' must have at least one valid artifactRef pointing to real code.`
      );
    }

    this.id = id;
    this.projectId = projectId;
    this.title = title;
    this.kind = kind;
    this.summary = summary;
    this.details = details;
    this.artifactRefs = artifactRefs.map((ref) => (ref instanceof ArtifactRef ? ref : new ArtifactRef(ref)));
    this.history = Array.isArray(history) ? [...history] : [];
    this.createdAt = createdAt;
    this.updatedAt = updatedAt;
  }

  updateArtifactRefs(newRefs) {
    if (!Array.isArray(newRefs) || newRefs.length === 0) {
      throw new Error(`Cannot clear all artifactRefs from Block '${this.id}'. Blocks cannot become ghosts.`);
    }
    this.artifactRefs = newRefs.map((ref) => (ref instanceof ArtifactRef ? ref : new ArtifactRef(ref)));
    this.updatedAt = new Date().toISOString();
  }

  recordHistory({ revision, description, author = 'agent' }) {
    this.history.push({
      revision,
      description,
      author,
      changedAt: new Date().toISOString(),
      artifactCount: this.artifactRefs.length,
    });
    this.updatedAt = new Date().toISOString();
  }

  toJSON() {
    return {
      id: this.id,
      projectId: this.projectId,
      title: this.title,
      kind: this.kind,
      summary: this.summary,
      details: this.details,
      artifactRefs: this.artifactRefs.map((ref) => ref.toJSON()),
      history: this.history,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
    };
  }
}
