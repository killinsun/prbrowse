export type PrState = "open" | "closed" | "merged";

export type CommentKind = "description" | "inline" | "issue" | "review";

export interface PullRequest {
  id: string;
  number: number;
  title: string;
  state: PrState;
  author: string;
  repo: string;
  owner: string;
  url: string;
  updatedAt: string;
  createdAt: string;
  /** PR body / description markdown */
  body?: string;
}

export interface Comment {
  id: string;
  kind: CommentKind;
  author: string;
  body: string;
  createdAt: string;
  url?: string;
  /** inline only */
  path?: string;
  line?: number | null;
  originalLine?: number | null;
  side?: "LEFT" | "RIGHT" | null;
  startLine?: number | null;
  originalStartLine?: number | null;
  diffHunk?: string;
  inReplyToId?: number | null;
}

export interface LoadedPr {
  pr: PullRequest;
  comments: Comment[];
}

export type CliStateFilter = "all" | "open" | "closed";

export interface AppOptions {
  org: string;
  repos: string[];
  author: string;
  /** null = fetch all matching PRs */
  limit: number | null;
  state: CliStateFilter;
}
