#!/usr/bin/env bun
import React from "react";
import { render } from "ink";
import { Command } from "commander";
import { clearAllCaches, clearDiskCache, cacheDir } from "./cache.ts";
import { resolveOptions } from "./config.ts";
import type { AppOptions, CliStateFilter } from "./types.ts";
import { App } from "./ui.tsx";
import { resetSession } from "./session.ts";

async function runTui(options: AppOptions): Promise<void> {
  let resolveExit!: () => void;
  const exitPromise = new Promise<void>((resolve) => {
    resolveExit = resolve;
  });

  type Handle = { unmount: () => void };
  const handle: { current: Handle | null } = { current: null };

  const mount = () => {
    const suspendAndRun = async (fn: () => Promise<void>) => {
      handle.current?.unmount();
      handle.current = null;
      await new Promise((r) => setTimeout(r, 50));
      try {
        await fn();
      } finally {
        mount();
      }
    };

    const instance = render(
      <App
        options={options}
        suspendAndRun={suspendAndRun}
        onQuit={resolveExit}
      />,
      {
        // So Ctrl/⌘+Enter is a real key event instead of a raw CSI dump.
        kittyKeyboard: { mode: "auto" },
      },
    );
    handle.current = instance;
  };

  mount();
  await exitPromise;
  handle.current?.unmount();
}

function parseBrowseOptions(cmd: Command): Promise<AppOptions> {
  const opts = cmd.opts<{
    user?: string;
    repo: string[];
    org?: string;
    state: string;
    limit?: number;
  }>();

  const state = opts.state as CliStateFilter;
  if (!["all", "open", "closed"].includes(state)) {
    console.error(`Invalid --state: ${opts.state}`);
    process.exit(1);
  }

  if (opts.limit != null && (!Number.isFinite(opts.limit) || opts.limit < 1)) {
    console.error(`Invalid --limit: ${opts.limit}`);
    process.exit(1);
  }

  return resolveOptions({
    user: opts.user,
    repo: opts.repo,
    org: opts.org,
    state,
    limit: opts.limit,
  });
}

function addBrowseOptions(cmd: Command): Command {
  return cmd
    .option("-u, --user <login>", "PR author (default: @me or config)")
    .option(
      "-r, --repo <name>",
      "Repo name under org (repeatable)",
      (value: string, prev: string[]) => [...prev, value],
      [] as string[],
    )
    .option("--org <org>", "GitHub org / owner")
    .option(
      "-s, --state <state>",
      "PR state filter: all | open | closed",
      "all",
    )
    .option(
      "-n, --limit <n>",
      "Max PRs to fetch (omit for all)",
      (v) => Number(v),
    );
}

async function main(): Promise<void> {
  const program = new Command();
  program
    .name("prbrowse")
    .description(
      "Browse PR review comments in a TUI; open inline comments in Hunk",
    )
    .enablePositionalOptions();

  addBrowseOptions(program).action(async function (this: Command) {
    const options = await parseBrowseOptions(this);
    resetSession();
    await runTui(options);
  });

  addBrowseOptions(
    program
      .command("clear-cache")
      .description("Delete disk cache (next launch refetches from GitHub)")
      .option("--all", "Delete all prbrowse cache files"),
  ).action(async function (this: Command) {
    const opts = this.opts<{ all?: boolean }>();
    if (opts.all) {
      const n = await clearAllCaches();
      console.log(
        n === 0
          ? `No cache files in ${cacheDir()}`
          : `Removed ${n} cache file(s) from ${cacheDir()}`,
      );
      return;
    }
    const options = await parseBrowseOptions(this);
    const removed = await clearDiskCache(options);
    console.log(
      removed
        ? `Cleared cache for current options (${cacheDir()})`
        : `No cache for current options (${cacheDir()})`,
    );
  });

  await program.parseAsync();
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
