import { resolveOptions } from "../src/config.ts";
import { listPullRequests, listComments } from "../src/github.ts";
import { commentsToAgentContext } from "../src/hunk.ts";

async function main() {
  // Uses ~/.config/prbrowse/config.toml or PRBROWSE_ORG / PRBROWSE_REPO env.
  const org = process.env.PRBROWSE_ORG;
  const repo = process.env.PRBROWSE_REPO;
  const options = await resolveOptions({
    org,
    repo: repo ? [repo] : [],
    user: "@me",
    limit: 3,
    state: "all",
  });

  const prs = await listPullRequests(options);
  console.log(
    "PRs:",
    prs.map((p) => `${p.repo}#${p.number} ${p.state}`),
  );
  const pr = prs[0];
  if (!pr) {
    console.log("No PRs");
    return;
  }
  const comments = await listComments(pr.owner, pr.repo, pr.number);
  console.log(
    "Comments:",
    comments.length,
    comments
      .slice(0, 5)
      .map((c) => `${c.kind}@${c.author} ${c.path ?? ""}:${c.line ?? ""}`),
  );
  if (
    comments.some(
      (c) =>
        /\[bot\]$/i.test(c.author) || c.author.toLowerCase().includes("bot"),
    )
  ) {
    console.error("FAIL: bot comment leaked through filter");
    process.exit(1);
  }
  const focus = comments.find((c) => c.kind === "inline");
  const ctx = commentsToAgentContext(pr, comments, focus?.id);
  console.log("Agent files:", ctx.files.length);
  if (ctx.files[0]?.annotations[0]) {
    console.log("First annotation:", ctx.files[0].annotations[0].summary);
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
