/**
 * Link domain entity.
 * Represents a typed, directed relationship between Blocks or Chains.
 */

export const LINK_KINDS = [
  'flows_to',
  'depends_on',
  'calls',
  'imports',
  'implements',
  'tests',
  'produces',
  'consumes',
  'feedback',
];

export const LINK_PROVENANCES = ['authored', 'inferred'];

export class Link {
  constructor({
    id,
    projectId,
    from,
    to,
    kind = 'depends_on',
    provenance = 'authored',
    confidence = 1.0,
    reason = '',
    revision = 1,
    createdAt = new Date().toISOString(),
    updatedAt = new Date().toISOString(),
  }) {
    if (!id || typeof id !== 'string') throw new Error('Link requires a valid string id');
    if (!projectId || typeof projectId !== 'string') throw new Error('Link requires projectId');
    if (!from || typeof from !== 'string') throw new Error('Link requires `from` endpoint');
    if (!to || typeof to !== 'string') throw new Error('Link requires `to` endpoint');
    if (!LINK_KINDS.includes(kind)) {
      throw new Error(`Invalid link kind: ${kind}. Must be one of ${LINK_KINDS.join(', ')}`);
    }
    if (!LINK_PROVENANCES.includes(provenance)) {
      throw new Error(`Invalid link provenance: ${provenance}. Must be one of ${LINK_PROVENANCES.join(', ')}`);
    }

    this.id = id;
    this.projectId = projectId;
    this.from = from;
    this.to = to;
    this.kind = kind;
    this.provenance = provenance;
    this.confidence = Math.max(0, Math.min(1, Number(confidence) || 1.0));
    this.reason = reason;
    this.revision = revision;
    this.createdAt = createdAt;
    this.updatedAt = updatedAt;
  }

  toJSON() {
    return {
      id: this.id,
      projectId: this.projectId,
      from: this.from,
      to: this.to,
      kind: this.kind,
      provenance: this.provenance,
      confidence: this.confidence,
      reason: this.reason,
      revision: this.revision,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
    };
  }
}
