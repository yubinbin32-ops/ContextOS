// 1:1 Port of apps/desktop/Sources/ContextOSDesktop/Models.swift

export interface ProjectDescriptor {
  id: string;
  name: string;
  schemaVersion: number;
  isCloud?: boolean;
  cloudUrl?: string;
}

export interface RecentProject {
  id: string; // path
  path: string;
  name: string;
  isCloud?: boolean;
  cloudUrl?: string;
  lastOpened?: string;
}

export interface ProjectInfo {
  id: string;
  name: string;
  root: string;
  graphRevision: number;
}

export interface BlockItem {
  id: string;
  kind: string;
  title: string;
  summary: string;
  body: string;
  contract: string;
  scope: string;
  architectureLayer: string;
  localOrder: number;
  deliveryState: string;
  healthState: string;
  priority: string;
  revision: number;
  isGhost?: boolean; // computed: deliveryState === "proposed" || deliveryState === "planned"
}

export function isBlockGhost(block: BlockItem): boolean {
  return block.deliveryState === 'proposed' || block.deliveryState === 'planned';
}

export interface ChainItem {
  id: string;
  title: string;
  chainType: string;
  purpose: string;
  summary?: string;
  intent: string;
  inputContract: string;
  outputContract: string;
  deliveryState: string;
  healthState: string;
  priority: string;
  revision: number;
  memberIds?: string[];
}

export interface ChainMemberItem {
  chainId: string;
  memberType: string;
  memberId: string;
  position: number;
  role: string;
  required: boolean;
}

export interface LinkItem {
  id: string;
  sourceType: string;
  sourceId: string;
  targetType: string;
  targetId: string;
  kind: string;
  label: string;
  contract: string;
  healthState: string;
  revision: number;
  reason?: string;
}

export interface ChainNode {
  chainId: string;
  blockId: string;
  position: number;
  role: string;
}

export interface ChainEdge {
  chainId: string;
  linkId: string;
  position: number;
}

export interface WorkProgress {
  completed: number;
  total: number;
}

export interface GateProgress {
  passed: number;
  total: number;
}

export interface PlanProgress {
  completedSteps: number;
  totalSteps: number;
  passedRequiredCheckpoints: number;
  totalRequiredCheckpoints: number;
  directBlockChanges: WorkProgress;
  chainChanges: WorkProgress;
  linkChanges: WorkProgress;
  chainIntegrationGates: GateProgress;
  planAcceptanceGates: GateProgress;
}

export interface PlanItem {
  id: string;
  title: string;
  summary: string;
  goal: string;
  status: string;
  derivedStatus: string;
  statusReason: string;
  priority: string;
  phase: string;
  order: number;
  proposedDelta: string;
  completionPolicy: string;
  nextAction: string;
  blockers: string;
  startedAt?: string | null;
  completedAt?: string | null;
  invalidatedAt?: string | null;
  progress: PlanProgress;
  revision: number;
  ruleRefs: string[];
}

export interface BlockCoverage {
  blockID: string;
  hasCheckpoint: Bool;
  checkpointRequired: boolean;
  missingRequiredCheckpoint: boolean;
  isCoveredByPlan: boolean;
  isCoveredByChain: boolean;
  isCoveredByAnyVerification: boolean;
  checkpointUnbound: boolean;
  chainGateMissing: boolean;
}

export type Bool = boolean;

export interface ArchitectureCoverage {
  totalBlocks: number;
  verifiedBlocks: number;
  plannedBlocks: number;
  blocksWithCheckpoints: number;
  outsideChainIDs: string[];
  unplannedIDs: string[];
  withoutCheckpointIDs: string[];
  requiredCheckpointMissingIDs: string[];
  failingIDs: string[];
  verificationCoveredBlocks: number;
  checkpointUnboundIDs: string[];
  chainGateMissingIDs: string[];
  blocks: BlockCoverage[];
}

export interface PlanChainReference {
  planId: string;
  chainId: string;
  position: number;
}

export interface PlanDependency {
  planId: string;
  dependsOnPlanId: string;
  position: number;
}

export interface PlanStep {
  id: string;
  planId: string;
  position: number;
  title: string;
  action: string;
  summary?: string;
  status: string;
  targetReferences: string;
  proposedDelta: string;
  updatedAt: string;
  ruleRefs: string[];
}

export interface PlanCheckpointReference {
  planId: string;
  checkpointId: string;
  stepId?: string | null;
  position: number;
  required: boolean;
}

export interface PlanChainScopeItem {
  id: string;
  planId: string;
  chainId: string;
  position: number;
  title: string;
  summary: string;
  rationale: string;
  startBlockId?: string | null;
  endBlockId?: string | null;
  nodeIds: string;
  linkIds: string;
  expectedDelta: string;
  prohibitions: string;
  status: string;
  revision: number;
}

export interface PlanChangeItem {
  id: string;
  planId: string;
  entityType: string;
  entityId: string;
  position: number;
  title: string;
  summary: string;
  currentBehavior: string;
  proposedBehavior: string;
  rationale: string;
  prohibitions: string;
  expectedEffects: string;
  sourceRefs: string;
  status: string;
  revision: number;
}

export interface PlanChainChangeReference {
  chainScopeId: string;
  planChangeId: string;
  role: string;
  position: number;
}

export interface BackgroundScope {
  blockId: string;
  scopeType: string;
  scopeValue: string;
}

export interface DecisionItem {
  id: string;
  title: string;
  summary: string;
  rationale: string;
  alternatives: string;
  consequences: string;
  status: string;
  supersedesDecisionID?: string | null;
  revision: number;
}

export interface DecisionScope {
  decisionID: string;
  scopeType: string;
  scopeValue: string;
}

export interface SourceReference {
  id: string;
  blockId: string;
  path: string;
  anchorKind: string;
  startLine?: number | null;
  endLine?: number | null;
  symbol?: string | null;
  hash: string;
  hashMode?: string | null;
  manifest?: string | null;
  role: string;
  gitCommit?: string | null;
}

export interface CheckpointItem {
  id: string;
  targetType: string;
  targetId: string;
  title: string;
  criteria: string;
  status: string;
  kind: string;
  aggregationPolicy: string;
  eligibleAfterChildren: boolean;
  evidenceLevel: string;
  requiredEvidenceLevel: string;
  coverage: string;
  evidence: string;
  invalidatedAt?: string | null;
  revision: number;
  updatedAt: string;
}

export interface CheckpointBinding {
  checkpointId: string;
  subjectType: string;
  subjectId: string;
  role: string;
  required: boolean;
  position: number;
}

export interface CheckpointDependency {
  parentCheckpointId: string;
  childCheckpointId: string;
  position: number;
  required: boolean;
}

export interface HistoryFieldDiff {
  field: string;
  before: string;
  after: string;
}

export interface HistoryItem {
  id: number;
  entityType: string;
  entityId: string;
  action: string;
  revision: number;
  summary: string;
  planID?: string | null;
  chainScopeID?: string | null;
  changedFields: string[];
  fieldDiffs: HistoryFieldDiff[];
  affectedRefs: string[];
  evidenceRefs: string[];
  createdAt: string;
}

export interface ChangeItem {
  sequence: number;
  entityType: string;
  entityId: string;
  action: string;
}

export interface LocalizedTextItem {
  entityType: string;
  entityId: string;
  locale: string;
  field: string;
  value: string;
}

export interface GraphSnapshot {
  project: ProjectInfo;
  changeSequence: number;
  blocks: BlockItem[];
  chains: ChainItem[];
  plans: PlanItem[];
  links: LinkItem[];
  chainMembers: ChainMemberItem[];
  chainNodes: ChainNode[];
  chainEdges: ChainEdge[];
  planChainReferences: PlanChainReference[];
  planDependencies: PlanDependency[];
  planSteps: PlanStep[];
  planCheckpointReferences: PlanCheckpointReference[];
  planChainScopes: PlanChainScopeItem[];
  planChanges: PlanChangeItem[];
  planChainChangeReferences: PlanChainChangeReference[];
  backgroundScopes: BackgroundScope[];
  decisions: DecisionItem[];
  decisionScopes: DecisionScope[];
  sourceReferences: SourceReference[];
  checkpoints: CheckpointItem[];
  checkpointBindings: CheckpointBinding[];
  checkpointDependencies: CheckpointDependency[];
  localizations: LocalizedTextItem[];
  history: HistoryItem[];
  latestChanges: ChangeItem[];
}

export type EntityType = 'block' | 'chain' | 'link' | 'plan' | 'decision';

export interface GraphSelection {
  type: EntityType;
  id: string;
}

export type SidebarSection =
  | 'knowledge'
  | 'synchronization'
  | 'projectRules'
  | 'decisions'
  | 'plans'
  | 'chains'
  | 'verification';

export type AppLanguage = 'system' | 'zhHans' | 'english' | 'zh-Hans' | 'en';

export type AppearancePreference = 'system' | 'light' | 'dark';

export interface RunningProcessItem {
  id: string;
  pid: number;
  command: string;
  cwd?: string | null;
  status: string;
  port?: number | null;
  startedAt?: string | null;
}

export interface EditorPlatformStatus {
  id: string;
  name: string;
  iconSystemName: string;
  isAppInstalled: boolean;
  isSynced: boolean;
  installedVersion?: string | null;
  targetVersion: string;
  isOutdated: boolean;
  configPath: string;
  appVersion: string;
  installedBuild?: string | null;
  targetBuild: string;
}

export interface AppReleaseAsset {
  id: number;
  name: string;
  downloadUrl: string;
  size: number;
}

export interface AppRelease {
  id: number;
  tagName: string;
  version: string;
  name: string;
  body: string;
  publishedAt?: string | null;
  htmlUrl: string;
  isPrerelease: boolean;
  assets: AppReleaseAsset[];
}

export type UpdateEdition = 'full' | 'standard';

export interface LocalNodeEnvironment {
  isQualified: boolean;
  version?: string | null;
  executablePath?: string | null;
  message: string;
}

export type UpdateState =
  | { type: 'idle' }
  | { type: 'checking' }
  | { type: 'upToDate'; checkedAt: string }
  | { type: 'updateAvailable'; latest: AppRelease; releases: AppRelease[] }
  | { type: 'downloading'; progress: number; bytesWritten: number; totalBytes: number }
  | { type: 'readyToInstall'; stagedAppURL?: string; version: string }
  | { type: 'installing' }
  | { type: 'failed'; message: string };


export function emptyGraphSnapshot(): GraphSnapshot {
  return {
    project: { id: '', name: '', root: '', graphRevision: 0 },
    changeSequence: 0,
    blocks: [],
    chains: [],
    plans: [],
    links: [],
    chainMembers: [],
    chainNodes: [],
    chainEdges: [],
    planChainReferences: [],
    planDependencies: [],
    planSteps: [],
    planCheckpointReferences: [],
    planChainScopes: [],
    planChanges: [],
    planChainChangeReferences: [],
    backgroundScopes: [],
    decisions: [],
    decisionScopes: [],
    sourceReferences: [],
    checkpoints: [],
    checkpointBindings: [],
    checkpointDependencies: [],
    localizations: [],
    history: [],
    latestChanges: [],
  };
}

