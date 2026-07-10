import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import type { Comment, PullRequest } from "./types.ts";
import { fetchPrDiff } from "./github.ts";
import { which } from "./gh.ts";

interface AgentAnnotation {
  summary: string;
  rationale?: string;
  author?: string;
  newRange?: [number, number];
  oldRange?: [number, number];
}

interface AgentFileContext {
  path: string;
  summary?: string;
  annotations: AgentAnnotation[];
}

interface AgentContext {
  version: number;
  summary?: string;
  files: AgentFileContext[];
}

function firstLine(body: string, max = 80): string {
  const line = body.split(/\r?\n/).find((l) => l.trim()) ?? body;
  const t = line.trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function resolveRange(comment: Comment): {
  oldRange?: [number, number];
  newRange?: [number, number];
} {
  const end =
    comment.line ?? comment.originalLine ?? null;
  const start =
    comment.startLine ??
    comment.originalStartLine ??
    end;

  if (end == null || start == null) {
    return {};
  }

  const range: [number, number] = [start, end];
  if (comment.side === "LEFT") {
    return { oldRange: range };
  }
  return { newRange: range };
}

export function commentsToAgentContext(
  pr: PullRequest,
  comments: Comment[],
  focusId?: string,
): AgentContext {
  const inline = comments.filter((c) => c.kind === "inline" && c.path);
  // Put focused comment's file/annotation first for visibility
  const ordered = [...inline];
  if (focusId) {
    ordered.sort((a, b) => {
      if (a.id === focusId) return -1;
      if (b.id === focusId) return 1;
      return 0;
    });
  }

  const byPath = new Map<string, AgentAnnotation[]>();
  for (const c of ordered) {
    const path = c.path!;
    const ranges = resolveRange(c);
    const annotation: AgentAnnotation = {
      summary: firstLine(c.body),
      rationale: `@${c.author}\n\n${c.body}`,
      author: c.author,
      ...ranges,
    };
    // If no line info, still attach as file-level note via summary-only annotation
    // Hunk requires a range OR we skip range fields — schema allows summary only
    // but normalizeAnnotation may need range. Use newRange [1,1] as last resort? Better skip range.
    const list = byPath.get(path) ?? [];
    list.push(annotation);
    byPath.set(path, list);
  }

  // Move focused file to front
  const paths = [...byPath.keys()];
  if (focusId) {
    const focus = ordered.find((c) => c.id === focusId);
    if (focus?.path) {
      const i = paths.indexOf(focus.path);
      if (i > 0) {
        paths.splice(i, 1);
        paths.unshift(focus.path);
      }
    }
  }

  return {
    version: 1,
    summary: `${pr.owner}/${pr.repo}#${pr.number} ${pr.title}`,
    files: paths.map((path) => ({
      path,
      annotations: byPath.get(path) ?? [],
    })),
  };
}

export async function openInHunk(
  pr: PullRequest,
  comments: Comment[],
  focusId?: string,
): Promise<{ ok: true } | { ok: false; reason: string; fallbackHunk?: string }> {
  const hasHunk = await which("hunk");
  const focus = comments.find((c) => c.id === focusId);

  if (!hasHunk) {
    return {
      ok: false,
      reason:
        "hunk is not installed. Install from https://github.com/modem-dev/hunk then retry Enter.",
      fallbackHunk: focus?.diffHunk,
    };
  }

  let diff: string;
  try {
    diff = await fetchPrDiff(pr.owner, pr.repo, pr.number);
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : String(err),
      fallbackHunk: focus?.diffHunk,
    };
  }

  if (!diff.trim()) {
    return {
      ok: false,
      reason: "PR diff is empty.",
      fallbackHunk: focus?.diffHunk,
    };
  }

  const dir = await mkdtemp(join(tmpdir(), "prbrowse-"));
  const patchPath = join(dir, "pr.patch");
  const notesPath = join(dir, "agent-context.json");
  const context = commentsToAgentContext(pr, comments, focusId);

  await writeFile(patchPath, diff, "utf8");
  await writeFile(notesPath, JSON.stringify(context, null, 2), "utf8");

  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      "hunk",
      ["patch", patchPath, "--agent-context", notesPath],
      {
        stdio: "inherit",
        env: process.env,
      },
    );
    child.on("error", reject);
    child.on("close", () => resolve());
  });

  return { ok: true };
}
