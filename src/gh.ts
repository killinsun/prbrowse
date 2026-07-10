import { spawn } from "node:child_process";

export class GhError extends Error {
  constructor(
    message: string,
    readonly stderr: string,
    readonly code: number | null,
  ) {
    super(message);
    this.name = "GhError";
  }
}

export async function runGh(
  args: string[],
  options: { stdin?: string } = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("gh", args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });

    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    child.on("error", (err) => {
      reject(
        new GhError(
          `Failed to run gh: ${err.message}. Is the GitHub CLI installed?`,
          "",
          null,
        ),
      );
    });

    child.on("close", (code) => {
      if (code === 0) {
        resolve(stdout);
        return;
      }
      reject(
        new GhError(
          `gh ${args.join(" ")} failed (exit ${code}): ${stderr.trim() || stdout.trim()}`,
          stderr,
          code,
        ),
      );
    });

    if (options.stdin != null) {
      child.stdin.write(options.stdin);
    }
    child.stdin.end();
  });
}

export async function runGhJson<T>(
  args: string[],
  options: { stdin?: string } = {},
): Promise<T> {
  const out = await runGh(args, options);
  if (!out.trim()) {
    return [] as unknown as T;
  }
  return JSON.parse(out) as T;
}

export async function which(cmd: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn("which", [cmd], { stdio: "ignore" });
    child.on("close", (code) => resolve(code === 0));
    child.on("error", () => resolve(false));
  });
}
