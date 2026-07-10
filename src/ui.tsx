import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Box, Text, useApp, useInput, useStdout, type Key } from "ink";
import type { AppOptions, Comment, PullRequest } from "./types.ts";
import {
  createIssueComment,
  listComments,
  listPullRequests,
  openPrInBrowser,
  replyToInlineComment,
} from "./github.ts";
import { loadDiskCache, mapPool, saveDiskCache } from "./cache.ts";
import { openInHunk } from "./hunk.ts";
import { session } from "./session.ts";

export type SuspendAndRun = (fn: () => Promise<void>) => Promise<void>;

const COMMENT_FETCH_CONCURRENCY = 6;

/**
 * xterm modifyOtherKeys / CSI dumps for Ctrl|Meta|Super + Enter.
 * Example seen in Terminal.app: `[27;5;13~` (ESC stripped) for Ctrl+Enter.
 */
const SEND_REPLY_CSI =
  /(?:\x1b)?\[(?:27;)?(?:5|7|9|13|15);13[~u]|\x1b\[13;(?:5|7|9|13|15)u/;

function isSendReplyChord(input: string, key: Key): boolean {
  if ((key.ctrl || key.meta || key.super) && (key.return || input === "\n")) {
    return true;
  }
  if (SEND_REPLY_CSI.test(input)) return true;
  // ESC stripped fragment that still looks like modifyOtherKeys Enter
  if (/^\[27;(?:5|7|9|13|15);13~$/.test(input)) return true;
  return false;
}

/** Drop accidental CSI fragments pasted into the draft by broken key handling. */
function stripLeakedCsi(text: string): string {
  return text
    .replace(/(?:\x1b)?\[27;\d+;\d+[~u]/g, "")
    .replace(/\x1b\[\d+(?:;\d+)*[u~]/g, "")
    .replace(/\[27;\d+;\d+~/g, "");
}

interface Props {
  options: AppOptions;
  suspendAndRun: SuspendAndRun;
  onQuit: () => void;
}

type Status =
  | { kind: "loading"; message: string }
  | { kind: "ready" }
  | { kind: "error"; message: string }
  | { kind: "info"; message: string };

function kindLabel(kind: Comment["kind"]): string {
  switch (kind) {
    case "description":
      return "description";
    case "inline":
      return "inline";
    case "issue":
      return "comment";
    case "review":
      return "review";
  }
}

function descriptionComment(pr: PullRequest): Comment {
  const body = pr.body?.trim() ? pr.body : "(no description)";
  return {
    id: `description:${pr.id}`,
    kind: "description",
    author: pr.author,
    body,
    createdAt: pr.createdAt,
  };
}

function locationOf(c: Comment): string {
  if (c.kind !== "inline" || !c.path) return "";
  const line = c.line ?? c.originalLine;
  return line != null ? `${c.path}:${line}` : c.path;
}

function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

function displayWidth(text: string): number {
  // Bun.stringWidth handles CJK / emoji column widths
  if (typeof Bun !== "undefined" && typeof Bun.stringWidth === "function") {
    return Bun.stringWidth(text);
  }
  let w = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    // rough fallback: CJK & fullwidth → 2
    if (
      (code >= 0x1100 && code <= 0x115f) ||
      (code >= 0x2e80 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe10 && code <= 0xfe6f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6) ||
      (code >= 0x1f300 && code <= 0x1faff)
    ) {
      w += 2;
    } else {
      w += 1;
    }
  }
  return w;
}

function sliceByWidth(text: string, maxWidth: number): [string, string] {
  if (maxWidth <= 0) return ["", text];
  let w = 0;
  let i = 0;
  for (const ch of text) {
    const cw = displayWidth(ch);
    if (w + cw > maxWidth) break;
    w += cw;
    i += ch.length;
  }
  if (i === 0 && text.length > 0) {
    // single char wider than max — force take it
    const ch = [...text][0]!;
    return [ch, text.slice(ch.length)];
  }
  return [text.slice(0, i), text.slice(i)];
}

function padToWidth(text: string, width: number): string {
  const w = displayWidth(text);
  if (w >= width) return text;
  return text + " ".repeat(width - w);
}

type LineKind =
  | "normal"
  | "suggestion"
  | "suggestionFence"
  | "diffHeader"
  | "diffAdd"
  | "diffDel"
  | "diffCtx"
  | "diffMeta";

interface ThreadLine {
  text: string;
  kind: LineKind;
}

const MAX_DIFF_HUNK_LINES = 16;

function diffLineKind(raw: string): LineKind {
  if (raw.startsWith("@@")) return "diffHeader";
  if (raw.startsWith("+")) return "diffAdd";
  if (raw.startsWith("-")) return "diffDel";
  return "diffCtx";
}

/** Prefer the end of the hunk (where the review usually points). */
function trimDiffHunk(hunk: string, maxLines: number): string[] {
  const lines = hunk.replace(/\r\n/g, "\n").split("\n");
  if (lines.length <= maxLines) return lines;
  const kept = lines.slice(-maxLines);
  return [`… ${lines.length - maxLines} more lines`, ...kept];
}

function boxRow(side: string, content: string, innerWidth: number): string {
  return `${side} ${padToWidth(content, innerWidth)} ${side}`;
}

function pushWrapped(
  lines: ThreadLine[],
  side: string,
  raw: string,
  innerWidth: number,
  kind: LineKind,
  indent: string,
): void {
  if (raw.length === 0) {
    lines.push({ text: indent + boxRow(side, "", innerWidth), kind });
    return;
  }
  let rest = raw;
  while (rest.length > 0) {
    const [chunk, next] = sliceByWidth(rest, innerWidth);
    lines.push({ text: indent + boxRow(side, chunk, innerWidth), kind });
    rest = next;
  }
}

function isSuggestionOpen(line: string): boolean {
  return /^```suggestion\b/i.test(line.trim());
}

function isFenceClose(line: string): boolean {
  return /^```\s*$/.test(line.trim());
}

function inlineNumericId(c: Comment): number | null {
  const m = /^inline:(\d+)$/.exec(c.id);
  return m ? Number(m[1]) : null;
}

/** Roots first (by time), then replies nested under parents. */
function orderAsThreads(comments: Comment[]): Comment[] {
  const byNum = new Map<number, Comment>();
  for (const c of comments) {
    const n = inlineNumericId(c);
    if (n != null) byNum.set(n, c);
  }

  const children = new Map<string, Comment[]>();
  const roots: Comment[] = [];

  for (const c of comments) {
    if (
      c.kind === "inline" &&
      c.inReplyToId != null &&
      byNum.has(c.inReplyToId)
    ) {
      const parent = byNum.get(c.inReplyToId)!;
      const list = children.get(parent.id) ?? [];
      list.push(c);
      children.set(parent.id, list);
    } else {
      roots.push(c);
    }
  }

  const byTime = (a: Comment, b: Comment) =>
    new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();

  roots.sort(byTime);
  for (const list of children.values()) list.sort(byTime);

  const out: Comment[] = [];
  const walk = (c: Comment) => {
    out.push(c);
    for (const child of children.get(c.id) ?? []) walk(child);
  };
  for (const r of roots) walk(r);
  return out;
}

function computeDepths(comments: Comment[]): Map<string, number> {
  const byNum = new Map<number, Comment>();
  for (const c of comments) {
    const n = inlineNumericId(c);
    if (n != null) byNum.set(n, c);
  }

  const depths = new Map<string, number>();
  const depthOf = (c: Comment): number => {
    const cached = depths.get(c.id);
    if (cached != null) return cached;
    if (c.kind !== "inline" || c.inReplyToId == null) {
      depths.set(c.id, 0);
      return 0;
    }
    const parent = byNum.get(c.inReplyToId);
    if (!parent) {
      depths.set(c.id, 1);
      return 1;
    }
    const d = Math.min(depthOf(parent) + 1, 5);
    depths.set(c.id, d);
    return d;
  };

  for (const c of comments) depthOf(c);
  return depths;
}

function parentAuthor(
  c: Comment,
  byNum: Map<number, Comment>,
): string | null {
  if (c.inReplyToId == null) return null;
  return byNum.get(c.inReplyToId)?.author ?? null;
}

/** Flatten thread into display lines for scrolling; each comment is boxed.
 *  `comments` must already be ordered (description first, then threads). */
function buildThreadLines(
  comments: Comment[],
  selectedId: string | null,
  contentWidth: number,
): {
  lines: ThreadLine[];
  commentStartLine: number[];
  ordered: Comment[];
} {
  const ordered = comments;
  const depths = computeDepths(ordered);
  const byNum = new Map<number, Comment>();
  for (const c of ordered) {
    const n = inlineNumericId(c);
    if (n != null) byNum.set(n, c);
  }

  const lines: ThreadLine[] = [];
  const commentStartLine: number[] = [];

  for (const c of ordered) {
    commentStartLine.push(lines.length);
    const depth = depths.get(c.id) ?? 0;
    // visual nest: spaces + optional rail for replies
    const indent =
      depth === 0 ? "" : `${"│ ".repeat(depth - 1)}│ `;

    // box must fit: indent + "│ " + inner + " │"
    const boxChrome = 4; // side + spaces around content
    const indentCols = displayWidth(indent);
    const innerWidth = Math.max(
      12,
      contentWidth - boxChrome - indentCols,
    );
    const hLine = "─".repeat(innerWidth + 2);

    const selected = c.id === selectedId;
    const marker = selected ? "❯" : depth > 0 ? "↳" : " ";
    const loc = locationOf(c);
    const replyTo = parentAuthor(c, byNum);
    const meta = [
      `${marker} @${c.author}`,
      depth > 0
        ? replyTo
          ? `reply to @${replyTo}`
          : "reply"
        : null,
      kindLabel(c.kind),
      formatTime(c.createdAt),
      loc || null,
    ]
      .filter(Boolean)
      .join(" · ");

    const top = selected ? `┏${hLine}┓` : `┌${hLine}┐`;
    const bot = selected ? `┗${hLine}┛` : `└${hLine}┘`;
    const side = selected ? "┃" : "│";

    lines.push({ text: indent + top, kind: "normal" });

    let metaRest = meta.length > 0 ? meta : " ";
    while (metaRest.length > 0) {
      const [chunk, rest] = sliceByWidth(metaRest, innerWidth);
      lines.push({
        text: indent + boxRow(side, chunk, innerWidth),
        kind: "normal",
      });
      metaRest = rest;
    }

    lines.push({
      text: indent + boxRow(side, "", innerWidth),
      kind: "normal",
    });

    // Show the reviewed code so the comment has context without opening Hunk.
    // Replies usually share the parent's hunk — only render on thread roots.
    if (c.kind === "inline" && depth === 0 && c.diffHunk?.trim()) {
      const hunkLines = trimDiffHunk(c.diffHunk.trim(), MAX_DIFF_HUNK_LINES);
      pushWrapped(
        lines,
        side,
        "── code ──",
        innerWidth,
        "diffMeta",
        indent,
      );
      for (const raw of hunkLines) {
        pushWrapped(
          lines,
          side,
          raw,
          innerWidth,
          raw.startsWith("…") ? "diffMeta" : diffLineKind(raw),
          indent,
        );
      }
      lines.push({
        text: indent + boxRow(side, "", innerWidth),
        kind: "normal",
      });
    }

    let inSuggestion = false;
    const bodyLines = c.body.replace(/\r\n/g, "\n").split("\n");
    for (const raw of bodyLines) {
      if (!inSuggestion && isSuggestionOpen(raw)) {
        inSuggestion = true;
        pushWrapped(
          lines,
          side,
          raw,
          innerWidth,
          "suggestionFence",
          indent,
        );
        continue;
      }
      if (inSuggestion && isFenceClose(raw)) {
        pushWrapped(
          lines,
          side,
          raw,
          innerWidth,
          "suggestionFence",
          indent,
        );
        inSuggestion = false;
        continue;
      }
      pushWrapped(
        lines,
        side,
        raw,
        innerWidth,
        inSuggestion ? "suggestion" : "normal",
        indent,
      );
    }

    lines.push({ text: indent + bot, kind: "normal" });
    lines.push({ text: "", kind: "normal" });
  }

  return { lines, commentStartLine, ordered };
}

function Header({
  pr,
  index,
  total,
  commentIndex,
  commentTotal,
}: {
  pr: PullRequest | null;
  index: number;
  total: number;
  commentIndex: number;
  commentTotal: number;
}) {
  if (!pr) {
    return (
      <Box paddingX={1}>
        <Text dimColor>No pull requests</Text>
      </Box>
    );
  }
  return (
    <Box paddingX={1} flexDirection="column">
      <Text>
        <Text bold>
          {pr.owner}/{pr.repo}#{pr.number}
        </Text>{" "}
        <Text dimColor>
          PR {index + 1}/{total} · {pr.state}
          {commentTotal > 0
            ? ` · comment ${commentIndex + 1}/${commentTotal}`
            : ""}
        </Text>
      </Text>
      <Text>{pr.title}</Text>
    </Box>
  );
}

/** Fixed composer height (content rows, excluding border/label). */
const REPLY_DRAFT_VIEWPORT = 6;

function wrapPlainLines(text: string, width: number): string[] {
  const out: string[] = [];
  const parts = text.replace(/\r\n/g, "\n").split("\n");
  for (const line of parts) {
    if (line.length === 0) {
      out.push("");
      continue;
    }
    let rest = line;
    while (rest.length > 0) {
      const [chunk, next] = sliceByWidth(rest, Math.max(1, width));
      out.push(chunk);
      rest = next;
    }
  }
  return out.length > 0 ? out : [""];
}

function Footer({
  status,
  replyMode,
}: {
  status: Status;
  replyMode: boolean;
}) {
  let msg = replyMode
    ? "↑↓ scroll thread  Enter newline  Ctrl/⌘+Enter send  Esc cancel"
    : "j/k comment  h/l PR  Enter hunk  r reply  o browser  q quit";
  if (!replyMode) {
    if (status.kind === "loading") msg = status.message;
    if (status.kind === "error") msg = `Error: ${status.message}`;
    if (status.kind === "info") msg = status.message;
  }
  return (
    <Box paddingX={1}>
      <Text
        color={
          status.kind === "error" && !replyMode
            ? "red"
            : status.kind === "info" && !replyMode
              ? "yellow"
              : replyMode
                ? "cyan"
                : undefined
        }
        dimColor={
          !replyMode &&
          (status.kind === "ready" || status.kind === "loading")
        }
      >
        {msg}
      </Text>
    </Box>
  );
}

export function App({ options, suspendAndRun, onQuit }: Props) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const rows = stdout?.rows ?? 24;
  const cols = stdout?.columns ?? 80;

  const [prs, setPrs] = useState<PullRequest[]>(() => session.prs);
  const [prIndex, setPrIndex] = useState(() => session.prIndex);
  const [cache, setCache] = useState<Record<string, Comment[]>>(
    () => session.cache,
  );
  const [commentIndex, setCommentIndex] = useState(
    () => session.commentIndex,
  );
  const [scrollOffset, setScrollOffset] = useState(
    () => session.scrollOffset,
  );
  const [status, setStatus] = useState<Status>(() =>
    session.hydrated && session.prs.length > 0
      ? { kind: "ready" }
      : { kind: "loading", message: "Loading pull requests…" },
  );
  const [fallback, setFallback] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [prefetching, setPrefetching] = useState(false);
  const [replyMode, setReplyMode] = useState(false);
  const [replyDraft, setReplyDraft] = useState("");
  const [replyTargetScroll, setReplyTargetScroll] = useState(0);
  const [replyDraftScroll, setReplyDraftScroll] = useState(0);

  useEffect(() => {
    session.prs = prs;
    session.prIndex = prIndex;
    session.cache = cache;
    session.commentIndex = commentIndex;
    session.scrollOffset = scrollOffset;
  }, [prs, prIndex, cache, commentIndex, scrollOffset]);

  const currentPr = prs[prIndex] ?? null;
  const rawComments = useMemo(() => {
    if (!currentPr) return [];
    return cache[currentPr.id] ?? [];
  }, [cache, currentPr]);

  const comments = useMemo(() => {
    if (!currentPr) return [];
    return [descriptionComment(currentPr), ...orderAsThreads(rawComments)];
  }, [currentPr, rawComments]);
  const currentComment = comments[commentIndex] ?? null;

  // Header ~2 + footer 1 + fixed reply composer + fallback
  const replyChrome = replyMode ? REPLY_DRAFT_VIEWPORT + 3 : 0; // label + border + draft rows
  const fallbackLines = fallback
    ? Math.min(6, fallback.split(/\r?\n/).length + 1)
    : 0;
  const viewportHeight = Math.max(
    5,
    rows - 4 - fallbackLines - replyChrome,
  );

  const { lines: threadLines, commentStartLine } = useMemo(
    () =>
      buildThreadLines(comments, currentComment?.id ?? null, cols - 4),
    [comments, currentComment?.id, cols],
  );

  const targetThreadLines = useMemo(() => {
    if (!replyMode) return [];
    const start = commentStartLine[commentIndex] ?? 0;
    const end = commentStartLine[commentIndex + 1] ?? threadLines.length;
    return threadLines.slice(start, end);
  }, [replyMode, commentStartLine, commentIndex, threadLines]);

  const draftWidth = Math.max(20, cols - 6);
  const draftWrapped = useMemo(
    () => wrapPlainLines(replyDraft, draftWidth),
    [replyDraft, draftWidth],
  );

  // Keep draft viewport pinned to the end while typing (cursor is always at end).
  useEffect(() => {
    if (!replyMode) return;
    const maxScroll = Math.max(0, draftWrapped.length - REPLY_DRAFT_VIEWPORT);
    setReplyDraftScroll(maxScroll);
  }, [replyMode, draftWrapped.length]);

  const ensureCommentVisible = useCallback(
    (index: number, lines: ThreadLine[], starts: number[]) => {
      const start = starts[index] ?? 0;
      const nextStart = starts[index + 1] ?? lines.length;
      const blockEnd = nextStart;
      setScrollOffset((prev) => {
        if (start < prev) return start;
        if (blockEnd > prev + viewportHeight) {
          return Math.max(0, blockEnd - viewportHeight);
        }
        return prev;
      });
    },
    [viewportHeight],
  );

  const persistCache = useCallback(
    async (
      nextPrs: PullRequest[],
      nextComments: Record<string, Comment[]>,
    ) => {
      await saveDiskCache(options, nextPrs, nextComments);
    },
    [options],
  );

  const loadPrList = useCallback(async () => {
    setBusy(true);
    try {
      setStatus({ kind: "loading", message: "Loading cache…" });
      const cached = await loadDiskCache(options);
      if (cached && cached.prs.length > 0) {
        setPrs(cached.prs);
        setPrIndex(0);
        setCache(cached.comments);
        setCommentIndex(0);
        setScrollOffset(0);
        setFallback(null);
        session.hydrated = true;
        setStatus({
          kind: "info",
          message: `Cached ${cached.prs.length} PRs (${new Date(cached.savedAt).toLocaleString()}). clear-cache to refetch.`,
        });
        return;
      }

      setStatus({ kind: "loading", message: "Loading pull requests…" });
      const list = await listPullRequests(options);
      setPrs(list);
      setPrIndex(0);
      setCache({});
      setCommentIndex(0);
      setScrollOffset(0);
      setFallback(null);
      session.hydrated = true;

      if (list.length === 0) {
        await saveDiskCache(options, [], {});
        setStatus({
          kind: "info",
          message:
            "No pull requests found. Adjust --user / --repo / config.",
        });
        return;
      }

      // Allow browsing while comments fill in
      setBusy(false);
      setPrefetching(true);
      setStatus({
        kind: "loading",
        message: `Caching comments 0/${list.length}…`,
      });

      const nextCache: Record<string, Comment[]> = {};
      await mapPool(
        list,
        COMMENT_FETCH_CONCURRENCY,
        async (pr) => {
          const comments = await listComments(pr.owner, pr.repo, pr.number);
          nextCache[pr.id] = comments;
          setCache((prev) => ({ ...prev, [pr.id]: comments }));
          return comments;
        },
        (done, total) => {
          setStatus({
            kind: "loading",
            message: `Caching comments ${done}/${total}…`,
          });
        },
      );

      await saveDiskCache(options, list, nextCache);
      setPrefetching(false);
      setStatus({
        kind: "info",
        message: `Cached ${list.length} PRs. Ready.`,
      });
    } catch (err) {
      setPrefetching(false);
      setStatus({
        kind: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setBusy(false);
    }
  }, [options]);

  useEffect(() => {
    if (session.hydrated && session.prs.length > 0) {
      return;
    }
    void loadPrList();
  }, [loadPrList]);

  // Fallback: if a PR somehow has no cached comments yet, fetch on demand.
  useEffect(() => {
    if (!currentPr) return;
    if (cache[currentPr.id]) return;
    if (busy || prefetching) return;

    const pr = currentPr;
    let cancelled = false;

    void listComments(pr.owner, pr.repo, pr.number)
      .then((list) => {
        if (cancelled) return;
        setCache((prev) => ({ ...prev, [pr.id]: list }));
      })
      .catch(() => {
        /* ignore */
      });

    return () => {
      cancelled = true;
    };
  }, [currentPr?.id, cache, busy, prefetching]);

  useEffect(() => {
    setFallback(null);
    setReplyMode(false);
    setReplyDraft("");
    setReplyTargetScroll(0);
    setReplyDraftScroll(0);
  }, [commentIndex, prIndex]);

  const goPr = (delta: number) => {
    if (prs.length === 0 || replyMode) return;
    setPrIndex((i) => Math.min(prs.length - 1, Math.max(0, i + delta)));
    setCommentIndex(0);
    setScrollOffset(0);
  };

  const goComment = (delta: number) => {
    if (comments.length === 0 || replyMode) return;
    setCommentIndex((i) => {
      const next = Math.min(comments.length - 1, Math.max(0, i + delta));
      ensureCommentVisible(next, threadLines, commentStartLine);
      return next;
    });
  };

  const scrollBy = (delta: number) => {
    const maxScroll = Math.max(0, threadLines.length - viewportHeight);
    setScrollOffset((s) => Math.min(maxScroll, Math.max(0, s + delta)));
  };

  const scrollReplyTarget = (delta: number) => {
    const maxScroll = Math.max(0, targetThreadLines.length - viewportHeight);
    setReplyTargetScroll((s) => Math.min(maxScroll, Math.max(0, s + delta)));
  };

  const startReply = () => {
    if (!currentPr || !currentComment || busy) return;
    if (currentComment.kind === "review") {
      setStatus({
        kind: "info",
        message:
          "Cannot reply to a review summary here. Select description / comment / inline.",
      });
      return;
    }
    setReplyMode(true);
    setReplyDraft("");
    setReplyTargetScroll(0);
    setReplyDraftScroll(0);
    setStatus({ kind: "ready" });
  };

  const cancelReply = () => {
    setReplyMode(false);
    setReplyDraft("");
    setReplyTargetScroll(0);
    setReplyDraftScroll(0);
    setStatus({ kind: "ready" });
  };

  const submitReply = async () => {
    if (!currentPr || !currentComment || busy) return;
    const body = stripLeakedCsi(replyDraft).trim();
    if (!body) {
      setStatus({ kind: "info", message: "Empty reply — type something first." });
      return;
    }

    const pr = currentPr;
    const target = currentComment;

    setBusy(true);
    setStatus({ kind: "loading", message: "Posting reply…" });

    try {
      let posted: Comment;
      if (target.kind === "inline") {
        const replyTo =
          target.inReplyToId ?? inlineNumericId(target);
        if (replyTo == null) {
          throw new Error("Missing inline comment id for reply");
        }
        posted = await replyToInlineComment(
          pr.owner,
          pr.repo,
          pr.number,
          replyTo,
          body,
        );
      } else if (target.kind === "description" || target.kind === "issue") {
        posted = await createIssueComment(
          pr.owner,
          pr.repo,
          pr.number,
          body,
        );
      } else {
        throw new Error("Unsupported reply target");
      }

      const nextCache = {
        ...cache,
        [pr.id]: [...(cache[pr.id] ?? []), posted],
      };
      setCache(nextCache);
      await persistCache(prs, nextCache);

      setReplyMode(false);
      setReplyDraft("");
      setReplyTargetScroll(0);
      setReplyDraftScroll(0);
      setStatus({ kind: "info", message: "Reply posted." });

      // Select the new comment once threads recompute
      const nextComments = [
        descriptionComment(pr),
        ...orderAsThreads(nextCache[pr.id] ?? []),
      ];
      const idx = nextComments.findIndex((c) => c.id === posted.id);
      if (idx >= 0) setCommentIndex(idx);
    } catch (err) {
      setStatus({
        kind: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setBusy(false);
    }
  };

  const openHunk = async () => {
    if (!currentPr || !currentComment || busy) return;
    if (currentComment.kind !== "inline") {
      setStatus({
        kind: "info",
        message: "Hunk opens for inline comments only. Use j/k to find one.",
      });
      return;
    }

    const pr = currentPr;
    const allComments = rawComments;
    const focusId = currentComment.id;

    setBusy(true);
    setStatus({ kind: "loading", message: "Opening Hunk…" });

    await suspendAndRun(async () => {
      const result = await openInHunk(pr, allComments, focusId);
      if (!result.ok) {
        session.lastFallback = result.fallbackHunk ?? null;
        session.lastInfo = result.reason;
      } else {
        session.lastFallback = null;
        session.lastInfo = undefined;
      }
    });
  };

  useEffect(() => {
    if (session.lastInfo) {
      setStatus({ kind: "info", message: session.lastInfo });
      session.lastInfo = undefined;
    }
    if (session.lastFallback) {
      setFallback(session.lastFallback);
      session.lastFallback = null;
    }
    setBusy(false);
  }, []);

  useInput((input, key) => {
    if (replyMode) {
      if (key.escape) {
        cancelReply();
        return;
      }
      if (isSendReplyChord(input, key)) {
        void submitReply();
        return;
      }
      if (key.upArrow) {
        scrollReplyTarget(-1);
        return;
      }
      if (key.downArrow) {
        scrollReplyTarget(1);
        return;
      }
      if (key.pageUp) {
        scrollReplyTarget(-Math.max(1, viewportHeight - 2));
        return;
      }
      if (key.pageDown) {
        scrollReplyTarget(Math.max(1, viewportHeight - 2));
        return;
      }
      if (key.return) {
        setReplyDraft((d) => d + "\n");
        return;
      }
      if (key.backspace || key.delete) {
        setReplyDraft((d) => d.slice(0, -1));
        return;
      }
      // Ignore raw escape / CSI noise so it never becomes draft text.
      if (input.startsWith("\x1b") || /^\[\d/.test(input)) {
        return;
      }
      if (input && !key.ctrl && !key.meta && !key.super) {
        setReplyDraft((d) => d + input);
      }
      return;
    }

    if (busy && input !== "q") return;

    if (input === "q") {
      onQuit();
      exit();
      return;
    }
    if (input === "r") {
      startReply();
      return;
    }
    if (input === "o" && currentPr) {
      void openPrInBrowser(currentPr.owner, currentPr.repo, currentPr.number);
      return;
    }
    if (input === "j" || key.downArrow) {
      goComment(1);
      return;
    }
    if (input === "k" || key.upArrow) {
      goComment(-1);
      return;
    }
    if (input === "l" || key.rightArrow) {
      goPr(1);
      return;
    }
    if (input === "h" || key.leftArrow) {
      goPr(-1);
      return;
    }
    if (key.return) {
      void openHunk();
      return;
    }
    if (key.pageDown) {
      scrollBy(Math.max(1, viewportHeight - 2));
      return;
    }
    if (key.pageUp) {
      scrollBy(-Math.max(1, viewportHeight - 2));
      return;
    }
    if (input === "d") {
      scrollBy(Math.max(1, Math.floor(viewportHeight / 2)));
      return;
    }
    if (input === "u") {
      scrollBy(-Math.max(1, Math.floor(viewportHeight / 2)));
      return;
    }
    if (input === "g") {
      setScrollOffset(0);
      setCommentIndex(0);
      return;
    }
    if (input === "G") {
      const maxScroll = Math.max(0, threadLines.length - viewportHeight);
      setScrollOffset(maxScroll);
      if (comments.length > 0) setCommentIndex(comments.length - 1);
      return;
    }
  });

  const browseVisible = threadLines.slice(
    scrollOffset,
    scrollOffset + viewportHeight,
  );
  while (browseVisible.length < viewportHeight) {
    browseVisible.push({ text: "", kind: "normal" });
  }

  const replyTargetVisible = targetThreadLines.slice(
    replyTargetScroll,
    replyTargetScroll + viewportHeight,
  );
  while (replyTargetVisible.length < viewportHeight) {
    replyTargetVisible.push({ text: "", kind: "normal" });
  }

  const draftVisible = draftWrapped.slice(
    replyDraftScroll,
    replyDraftScroll + REPLY_DRAFT_VIEWPORT,
  );
  while (draftVisible.length < REPLY_DRAFT_VIEWPORT) {
    draftVisible.push("");
  }

  const selectedStart = commentStartLine[commentIndex] ?? -1;
  const paneLines = replyMode ? replyTargetVisible : browseVisible;

  const renderThreadLine = (
    line: ThreadLine,
    abs: number,
    i: number,
    forceSelected: boolean,
  ) => {
    const isSelectedBlock =
      forceSelected ||
      (selectedStart >= 0 &&
        abs >= selectedStart &&
        (commentStartLine[commentIndex + 1] == null ||
          abs < (commentStartLine[commentIndex + 1] as number)));

    let color: string | undefined;
    let dimColor = false;
    if (line.kind === "suggestion") {
      color = "green";
    } else if (line.kind === "suggestionFence") {
      color = "yellow";
    } else if (line.kind === "diffAdd") {
      color = "green";
    } else if (line.kind === "diffDel") {
      color = "red";
    } else if (line.kind === "diffHeader") {
      color = "magenta";
    } else if (line.kind === "diffCtx" || line.kind === "diffMeta") {
      dimColor = true;
    } else if (isSelectedBlock) {
      color = "cyan";
    }

    return (
      <Text
        key={`${abs}-${i}`}
        color={color}
        dimColor={dimColor}
        bold={line.kind === "suggestionFence"}
      >
        {line.text || " "}
      </Text>
    );
  };

  return (
    <Box flexDirection="column" width={cols} height={rows}>
      <Header
        pr={currentPr}
        index={prIndex}
        total={prs.length}
        commentIndex={commentIndex}
        commentTotal={comments.length}
      />
      <Box
        flexDirection="column"
        height={viewportHeight}
        width={cols}
        paddingX={1}
        overflow="hidden"
      >
        {!currentPr ? (
          <Text dimColor>
            {busy ? "Loading…" : "No pull requests"}
          </Text>
        ) : (
          paneLines.map((line, i) => {
            const abs = replyMode
              ? replyTargetScroll + i
              : scrollOffset + i;
            return renderThreadLine(line, abs, i, replyMode);
          })
        )}
      </Box>
      {replyMode ? (
        <Box
          paddingX={1}
          flexDirection="column"
          height={REPLY_DRAFT_VIEWPORT + 3}
          borderStyle="single"
          borderColor="cyan"
        >
          <Text dimColor>
            Reply to @{currentComment?.author ?? "?"} ·{" "}
            {currentComment ? kindLabel(currentComment.kind) : "?"}
            {currentComment?.path
              ? ` · ${locationOf(currentComment)}`
              : ""}
          </Text>
          {draftVisible.map((line, i) => {
            const showCursor =
              replyDraftScroll + i === draftWrapped.length - 1;
            return (
              <Text key={i}>
                {line || " "}
                {showCursor ? <Text inverse> </Text> : null}
              </Text>
            );
          })}
        </Box>
      ) : null}
      {fallback ? (
        <Box paddingX={1} flexDirection="column" height={fallbackLines}>
          <Text dimColor>diff_hunk fallback:</Text>
          {fallback
            .split(/\r?\n/)
            .slice(0, 5)
            .map((line, i) => (
              <Text key={i}>{line}</Text>
            ))}
        </Box>
      ) : null}
      <Footer status={status} replyMode={replyMode} />
    </Box>
  );
}
