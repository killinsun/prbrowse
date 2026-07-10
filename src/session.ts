import type { Comment, PullRequest } from "./types.ts";

/** Survives Ink unmount/remount when launching Hunk. */
export const session = {
  prs: [] as PullRequest[],
  prIndex: 0,
  cache: {} as Record<string, Comment[]>,
  commentIndex: 0,
  scrollOffset: 0,
  hydrated: false,
  lastInfo: undefined as string | undefined,
  lastFallback: null as string | null,
};

export function resetSession(): void {
  session.prs = [];
  session.prIndex = 0;
  session.cache = {};
  session.commentIndex = 0;
  session.scrollOffset = 0;
  session.hydrated = false;
  session.lastInfo = undefined;
  session.lastFallback = null;
}
