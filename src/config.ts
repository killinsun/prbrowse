import { homedir } from "node:os";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { parse } from "smol-toml";
import type { AppOptions, CliStateFilter } from "./types.ts";

export interface ConfigFile {
  org?: string;
  repos?: string[];
  default_author?: string;
  limit?: number;
}

const DEFAULTS = {
  author: "@me",
  limit: null as number | null,
  state: "all" as CliStateFilter,
};

export function configPath(): string {
  return join(homedir(), ".config", "prbrowse", "config.toml");
}

export async function loadConfigFile(): Promise<ConfigFile> {
  try {
    const raw = await readFile(configPath(), "utf8");
    return parse(raw) as ConfigFile;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return {};
    throw err;
  }
}

function usageHint(): string {
  return [
    "Set target repos via CLI or config.",
    "",
    "  prbrowse --org my-org --repo my-repo",
    "  prbrowse --repo owner/repo",
    "",
    `Or create ${configPath()}:`,
    "",
    '  org = "my-org"',
    '  repos = ["my-repo"]',
    '  default_author = "@me"',
  ].join("\n");
}

/** Parse `--repo` values: `name` (needs org) or `owner/name`. */
export function normalizeRepos(
  org: string | undefined,
  repos: string[],
): { org: string; repos: string[] } {
  if (repos.length === 0) {
    throw new Error(usageHint());
  }

  const owners = new Set<string>();
  const names: string[] = [];

  for (const raw of repos) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    if (trimmed.includes("/")) {
      const [owner, name, ...rest] = trimmed.split("/");
      if (!owner || !name || rest.length > 0) {
        throw new Error(`Invalid --repo: ${raw} (expected name or owner/name)`);
      }
      owners.add(owner);
      names.push(name);
    } else {
      names.push(trimmed);
    }
  }

  if (names.length === 0) {
    throw new Error(usageHint());
  }

  if (owners.size > 1) {
    throw new Error(
      `All --repo owner/name values must share one owner (got: ${[...owners].join(", ")})`,
    );
  }

  const fromRepos = owners.size === 1 ? [...owners][0] : undefined;
  const resolvedOrg = org ?? fromRepos;
  if (!resolvedOrg) {
    throw new Error(
      `Missing org. Pass --org, use --repo owner/name, or set org in ${configPath()}\n\n${usageHint()}`,
    );
  }

  if (fromRepos && org && fromRepos !== org) {
    throw new Error(`--org ${org} conflicts with --repo owner ${fromRepos}`);
  }

  return { org: resolvedOrg, repos: names };
}

export async function resolveOptions(cli: {
  user?: string;
  repo?: string[];
  state?: CliStateFilter;
  limit?: number | null;
  org?: string;
}): Promise<AppOptions> {
  const file = await loadConfigFile();
  const cliRepos = cli.repo && cli.repo.length > 0 ? cli.repo : [];
  const fileRepos = file.repos && file.repos.length > 0 ? file.repos : [];
  const reposInput = cliRepos.length > 0 ? cliRepos : fileRepos;
  const orgInput = cli.org ?? file.org;

  const { org, repos } = normalizeRepos(orgInput, reposInput);

  const limit =
    cli.limit !== undefined
      ? cli.limit
      : file.limit !== undefined
        ? file.limit
        : DEFAULTS.limit;

  return {
    org,
    repos,
    author: cli.user ?? file.default_author ?? DEFAULTS.author,
    limit,
    state: cli.state ?? DEFAULTS.state,
  };
}
