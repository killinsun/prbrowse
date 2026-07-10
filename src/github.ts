import { runGh, runGhJson } from "./gh.ts";
import type {
  AppOptions,
  Comment,
  PullRequest,
  PrState,
} from "./types.ts";

interface ListedPrItem {
  number: number;
  title: string;
  state: string;
  url: string;
  updatedAt: string;
  createdAt: string;
  author: { login: string };
  body: string;
}

/** Practical ceiling when fetching "all" via `gh pr list` pagination. */
const UNLIMITED_FETCH = 100_000;

interface GhUser {
  login: string;
  type?: string;
}

interface InlineCommentRaw {
  id: number;
  body: string;
  user: GhUser | null;
  created_at: string;
  html_url: string;
  path: string;
  line: number | null;
  original_line: number | null;
  side: "LEFT" | "RIGHT" | null;
  start_line: number | null;
  original_start_line: number | null;
  diff_hunk: string;
  in_reply_to_id: number | null;
}

interface IssueCommentRaw {
  id: number;
  body: string;
  user: GhUser | null;
  created_at: string;
  html_url: string;
}

interface ReviewRaw {
  id: number;
  body: string | null;
  user: GhUser | null;
  submitted_at: string | null;
  html_url: string;
  state: string;
}

/** GitHub Apps / Dependabot / Copilot など */
export function isBotAuthor(user: GhUser | null | undefined): boolean {
  if (!user?.login) return true;
  if (user.type === "Bot") return true;
  const login = user.login.toLowerCase();
  if (login.endsWith("[bot]")) return true;
  if (login.endsWith("-bot")) return true;
  if (
    [
      "dependabot",
      "dependabot[bot]",
      "github-actions",
      "github-actions[bot]",
      "copilot",
      "copilot[bot]",
      "cursor",
      "cursor[bot]",
      "renovate",
      "renovate[bot]",
      "imgbot",
      "imgbot[bot]",
      "coderabbitai",
      "coderabbitai[bot]",
      "sonarcloud",
      "sonarcloud[bot]",
    ].includes(login)
  ) {
    return true;
  }
  return false;
}

export async function resolveAuthor(author: string): Promise<string> {
  if (author === "@me" || author === "me") {
    const login = (await runGh(["api", "user", "--jq", ".login"])).trim();
    return login;
  }
  return author;
}

function mapListedPr(
  item: ListedPrItem,
  owner: string,
  repo: string,
): PullRequest {
  const stateRaw = item.state.toLowerCase();
  let state: PrState = "closed";
  if (stateRaw === "open") state = "open";
  else if (stateRaw === "merged") state = "merged";
  else state = "closed";

  return {
    id: `${owner}/${repo}#${item.number}`,
    number: item.number,
    title: item.title,
    state,
    author: item.author.login,
    repo,
    owner,
    url: item.url,
    updatedAt: item.updatedAt,
    createdAt: item.createdAt,
    body: item.body ?? "",
  };
}

async function listPullRequestsForRepo(
  owner: string,
  repo: string,
  author: string,
  state: AppOptions["state"],
  limit: number,
): Promise<PullRequest[]> {
  const args = [
    "pr",
    "list",
    "--repo",
    `${owner}/${repo}`,
    `--author=${author}`,
    `--state=${state}`,
    `--limit=${String(limit)}`,
    "--json",
    "number,title,state,url,updatedAt,createdAt,author,body",
  ];

  const items = await runGhJson<ListedPrItem[]>(args);
  return items.map((item) => mapListedPr(item, owner, repo));
}

export async function listPullRequests(
  options: AppOptions,
): Promise<PullRequest[]> {
  const author = await resolveAuthor(options.author);
  const fetchLimit = options.limit ?? UNLIMITED_FETCH;

  // Per-repo listing avoids GitHub Search's 1000-result cap.
  const batches = await Promise.all(
    options.repos.map((repo) =>
      listPullRequestsForRepo(
        options.org,
        repo,
        author,
        options.state,
        fetchLimit,
      ),
    ),
  );

  let prs = batches.flat();
  prs.sort(
    (a, b) =>
      new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
  );

  if (options.limit != null && prs.length > options.limit) {
    prs = prs.slice(0, options.limit);
  }

  return prs;
}

function mapInline(raw: InlineCommentRaw): Comment {
  return {
    id: `inline:${raw.id}`,
    kind: "inline",
    author: raw.user?.login ?? "ghost",
    body: raw.body ?? "",
    createdAt: raw.created_at,
    url: raw.html_url,
    path: raw.path,
    line: raw.line,
    originalLine: raw.original_line,
    side: raw.side,
    startLine: raw.start_line,
    originalStartLine: raw.original_start_line,
    diffHunk: raw.diff_hunk,
    inReplyToId: raw.in_reply_to_id,
  };
}

function mapIssue(raw: IssueCommentRaw): Comment {
  return {
    id: `issue:${raw.id}`,
    kind: "issue",
    author: raw.user?.login ?? "ghost",
    body: raw.body ?? "",
    createdAt: raw.created_at,
    url: raw.html_url,
  };
}

function mapReview(raw: ReviewRaw): Comment | null {
  const body = (raw.body ?? "").trim();
  if (!body) return null;
  return {
    id: `review:${raw.id}`,
    kind: "review",
    author: raw.user?.login ?? "ghost",
    body,
    createdAt: raw.submitted_at ?? new Date(0).toISOString(),
    url: raw.html_url,
  };
}

export async function listComments(
  owner: string,
  repo: string,
  number: number,
): Promise<Comment[]> {
  const repoSlug = `${owner}/${repo}`;
  const [inline, issue, reviews] = await Promise.all([
    runGhJson<InlineCommentRaw[]>([
      "api",
      `repos/${repoSlug}/pulls/${number}/comments`,
      "--paginate",
    ]),
    runGhJson<IssueCommentRaw[]>([
      "api",
      `repos/${repoSlug}/issues/${number}/comments`,
      "--paginate",
    ]),
    runGhJson<ReviewRaw[]>([
      "api",
      `repos/${repoSlug}/pulls/${number}/reviews`,
      "--paginate",
    ]),
  ]);

  const comments: Comment[] = [
    ...inline.filter((r) => !isBotAuthor(r.user)).map(mapInline),
    ...issue.filter((r) => !isBotAuthor(r.user)).map(mapIssue),
    ...reviews
      .filter((r) => !isBotAuthor(r.user))
      .map(mapReview)
      .filter((c): c is Comment => c != null),
  ].filter((c) => c.body.trim().length > 0);

  // Thread order: oldest first
  comments.sort(
    (a, b) =>
      new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
  );

  return comments;
}

export async function fetchPrDiff(
  owner: string,
  repo: string,
  number: number,
): Promise<string> {
  return runGh(["pr", "diff", String(number), "--repo", `${owner}/${repo}`]);
}

export async function openPrInBrowser(
  owner: string,
  repo: string,
  number: number,
): Promise<void> {
  await runGh([
    "pr",
    "view",
    String(number),
    "--repo",
    `${owner}/${repo}`,
    "--web",
  ]);
}

/** Reply to an inline review comment (creates a threaded reply). */
export async function replyToInlineComment(
  owner: string,
  repo: string,
  prNumber: number,
  inReplyToId: number,
  body: string,
): Promise<Comment> {
  const raw = await runGhJson<InlineCommentRaw>(
    [
      "api",
      "--method",
      "POST",
      `repos/${owner}/${repo}/pulls/${prNumber}/comments`,
      "--input",
      "-",
    ],
    {
      stdin: JSON.stringify({ body, in_reply_to: inReplyToId }),
    },
  );
  return mapInline(raw);
}

/** Post a general PR (issue) comment. */
export async function createIssueComment(
  owner: string,
  repo: string,
  prNumber: number,
  body: string,
): Promise<Comment> {
  const raw = await runGhJson<IssueCommentRaw>(
    [
      "api",
      "--method",
      "POST",
      `repos/${owner}/${repo}/issues/${prNumber}/comments`,
      "--input",
      "-",
    ],
    {
      stdin: JSON.stringify({ body }),
    },
  );
  return mapIssue(raw);
}
