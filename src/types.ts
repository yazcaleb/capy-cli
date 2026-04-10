export interface QualityConfig {
  minReviewScore: number;
  requireCI: boolean;
  requireTests: boolean;
  requireLinearLink: boolean;
  reviewProvider: string;
}

export interface RepoRef {
  repoFullName: string;
  branch: string;
}

export interface CapyConfig {
  apiKey: string;
  projectId: string;
  server: string;
  repos: RepoRef[];
  defaultModel: string;
  quality: QualityConfig;
  watchInterval: number;
  notifyCommand: string;
  greptileApiKey?: string;
  approveCommand?: string;
  [key: string]: unknown;
}

export interface Credits {
  llm?: number;
  vm?: number;
}

export interface Jam {
  id?: string;
  model?: string;
  status?: string;
  credits?: Credits | number;
  pullRequest?: PullRequestRef;
  branches?: Record<string, unknown>;
  git?: unknown;
  slackThreads?: unknown[];
  createdAt?: string;
  updatedAt?: string;
}

export interface PullRequestRef {
  number?: number;
  url?: string;
  state?: string;
  repoFullName?: string;
  headRef?: string;
  baseRef?: string;
  title?: string;
}

export interface Task {
  id: string;
  projectId?: string;
  identifier: string;
  title: string;
  status: string;
  prompt?: string;
  labels?: string[];
  pullRequest?: PullRequestRef;
  slackThreads?: unknown[];
  createdAt?: string;
  updatedAt?: string;
  jams?: Jam[];
}

export interface Thread {
  id: string;
  projectId?: string;
  title?: string;
  status: string;
  tasks?: Task[];
  pullRequests?: PullRequestRef[];
  slackThreads?: unknown[];
  createdAt?: string;
  updatedAt?: string;
}

export interface ThreadMessage {
  source: string;
  content: string;
}

export interface DiffFile {
  path: string;
  filename?: string;
  state?: string;
  additions?: number;
  deletions?: number;
  patch?: string;
}

export interface DiffData {
  source?: string;
  stats?: { additions?: number; deletions?: number; files?: number };
  files?: DiffFile[];
}

export interface Model {
  id: string;
  name?: string;
  provider?: string;
  captainEligible?: boolean;
}

export interface StatusCheck {
  name?: string;
  context?: string;
  conclusion?: string;
  status?: string;
}

export interface PRData {
  state: string;
  mergeable?: string;
  mergedAt?: string;
  closedAt?: string;
  headRefName?: string;
  baseRefName?: string;
  title?: string;
  body?: string;
  url?: string;
  number?: number;
  additions?: number;
  deletions?: number;
  changedFiles?: number;
  reviewDecision?: string;
  statusCheckRollup?: StatusCheck[];
  reviews?: unknown[];
  comments?: unknown[];
}

export interface CIStatus {
  total: number;
  passing: number;
  failing: { name: string; conclusion?: string; status?: string }[];
  pending: { name: string; status?: string }[];
  allGreen: boolean;
  noChecks: boolean;
}

export interface QualityGate {
  name: string;
  pass: boolean;
  detail: string;
  failing?: { name: string; conclusion?: string; status?: string }[];
  pending?: { name: string; status?: string }[];
  issues?: UnaddressedIssue[];
  threads?: { body: string; author: string }[];
}

export interface QualityResult {
  pass: boolean;
  passed: number;
  total: number;
  gates: QualityGate[];
  summary: string;
}

export interface GreptileReview {
  score: number | null;
  issueCount: number;
  logic: number;
  syntax: number;
  style: number;
  body: string;
  url?: string;
}

export interface UnaddressedIssue {
  body: string;
  file: string;
  line: string | number;
  hasSuggestion: boolean;
  suggestedCode: string | null;
}

export interface WatchEntry {
  id: string;
  type: string;
  intervalMin: number;
  created: string;
}

export interface ApiResponse {
  error?: { message?: string; code?: string };
  [key: string]: unknown;
}

export interface ListResponse<T> {
  items?: T[];
  nextCursor?: string;
  hasMore?: boolean;
  [key: string]: unknown;
}
