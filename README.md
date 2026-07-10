# prbrowse

Browse GitHub PR review comments in a terminal UI. Open inline comments in [Hunk](https://github.com/modem-dev/hunk) without cloning the target repository.

## Install

### Homebrew (recommended)

```bash
brew install killinsun/tap/prbrowse
```

Requires [`gh`](https://cli.github.com/) (`brew install gh` then `gh auth login`).

### From source

```bash
git clone https://github.com/killinsun/prbrowse.git
cd prbrowse
bun install
bun link
```

## Quick start

Create `~/.config/prbrowse/config.toml`:

```toml
org = "my-org"
repos = ["my-repo", "another-repo"]
default_author = "@me"
# limit = 50   # optional; omit to fetch all matching PRs
```

Then:

```bash
prbrowse
```

Or pass targets on the CLI (no config needed):

```bash
prbrowse --org my-org --repo my-repo
prbrowse --repo my-org/my-repo --repo my-org/other-repo
prbrowse --user someone --repo my-org/my-repo
prbrowse --state open --limit 50
prbrowse clear-cache
prbrowse clear-cache --all
```

## Requirements

- [GitHub CLI](https://cli.github.com/) (`gh`) authenticated
- [Hunk](https://github.com/modem-dev/hunk) (optional; needed to open inline comments in a full diff viewer)

## Keys

| Key | Action |
|-----|--------|
| `j` / `k` | Next / previous comment (thread scroll follows) |
| `h` / `l` | Previous / next PR |
| `PgUp` / `PgDn` / `u` / `d` | Scroll the thread pane |
| `g` / `G` | Top / bottom |
| `Enter` | Open inline comment in Hunk (`hunk patch` + agent-context) |
| `r` | Reply to the selected thread (description / issue / inline) |
| `Ctrl+Enter` / `⌘+Enter` | Send reply (in reply mode) |
| `↑` / `↓` | Scroll the target thread (in reply mode) |
| `Esc` | Cancel reply |
| `o` | Open PR in browser |
| `q` | Quit |

Bot authors (`cursor[bot]`, Dependabot, Copilot, etc.) are filtered out. Each PR thread starts with the PR description, then comments oldest-first. Inline comments include the reviewed `diff_hunk` so you can see the target code without opening Hunk.

On first load, matching PRs and their comments are fetched and saved under `~/.cache/prbrowse/`. Later launches reuse that cache. Run `prbrowse clear-cache` to force a refetch.

## How Hunk integration works

1. Fetch PR review comments via `gh api`
2. On `Enter` for an inline comment, fetch `gh pr diff`
3. Write a temp patch + Hunk `--agent-context` JSON
4. Run `hunk patch <patch> --agent-context <json>`

If Hunk is not installed, the comment's `diff_hunk` from GitHub is shown as a fallback.

## License

MIT
