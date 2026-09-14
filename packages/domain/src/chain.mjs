/**
 * Chain domain entity.
 * Represents an aggregated abstract feature (leaf or composite).
 * Invariant: Chain semantic order is defined by typed Links, not by arbitrary list indexing.
 */

export const CHAIN_KINDS = ['leaf', 'composite'];

export class Chain {
  constructor({
    id,
    projectId,
    title,
    summary = '',
    kind = 'leaf',
    memberIds = [],
    metadata = {},
    createdAt = new Date().toISOString(),
    updatedAt = new Date().toISOString(),
  }) {
    if (!id || typeof id !== 'string') throw new Error('Chain requires a valid string id');
    if (!projectId || typeof projectId !== 'string') throw new Error('Chain requires projectId');
    if (!title || typeof title !== 'string') throw new Error('Chain requires title');
    if (!CHAIN_KINDS.includes(kind)) {
      throw new Error(`Invalid chain kind: ${kind}. Must be one of ${CHAIN_KINDS.join(', ')}`);
    }

    this.id = id;
    this.projectId = projectId;
    this.title = title;
    this.summary = summary;
    this.kind = kind;
    this.memberIds = Array.isArray(memberIds) ? [...memberIds] : [];
    this.metadata = metadata;
    this.createdAt = createdAt;
    this.updatedAt = updatedAt;
  }

  addMember(memberId) {
    if (!memberId || typeof memberId !== 'string') throw new Error('Invalid memberId');
    if (!this.memberIds.includes(memberId)) {
      this.memberIds.push(memberId);
      this.updatedAt = new Date().toISOString();
    }
  }

  removeMember(memberId) {
    const index = this.memberIds.indexOf(memberId);
    if (index !== -1) {
      this.memberIds.splice(index, 1);
      this.updatedAt = new Date().toISOString();
    }
  }

  toJSON() {
    return {
      id: this.id,
      projectId: this.projectId,
      title: this.title,
      summary: this.summary,
      kind: this.kind,
      memberIds: this.memberIds,
      metadata: this.metadata,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
    };
  }
}
