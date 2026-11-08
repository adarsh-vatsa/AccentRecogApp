import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { idPattern, shaPattern } from "./validate.ts";

/**
 * Git storage for house code. Each house is one bare repository:
 *   refs/heads/main      the live version everyone sees
 *   refs/runs/<runId>    the latest commit of an agent run (kept for preview/history)
 * Agent runs edit a detached worktree; nothing ever checks out `main` on disk.
 */

// Repository-level hardening applied to every git invocation.
const HARDENING = [
  "-c", "core.hooksPath=/dev/null",
  "-c", "core.symlinks=false",
  "-c", "core.fsmonitor=false",
  "-c", "protocol.allow=never",
  "-c", "gc.auto=0",
  "-c", "advice.detachedHead=false",
];

export interface GitIdentity {
  name: string;
  email: string;
}

const COMMITTER: GitIdentity = { name: "Dynamic Chats", email: "platform@dynamic-chats.invalid" };

function cleanIdentityName(name: string): string {
  return name.replace(/[<>\r\n\u0000-\u001f]/g, "").trim() || "member";
}

interface GitResult {
  stdout: Buffer;
  stderr: string;
  code: number;
}

function runGit(args: string[], opts: { cwd?: string; author?: GitIdentity; maxBuffer?: number } = {}): Promise<GitResult> {
  const author = opts.author ?? COMMITTER;
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: os.tmpdir(),
    LANG: "C",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_AUTHOR_NAME: cleanIdentityName(author.name),
    GIT_AUTHOR_EMAIL: author.email,
    GIT_COMMITTER_NAME: COMMITTER.name,
    GIT_COMMITTER_EMAIL: COMMITTER.email,
  };
  return new Promise((resolve) => {
    execFile(
      "git",
      [...HARDENING, ...args],
      { cwd: opts.cwd, env, encoding: "buffer", maxBuffer: opts.maxBuffer ?? 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const code = err ? (typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : 1) : 0;
        resolve({ stdout, stderr: stderr.toString("utf8"), code });
      },
    );
  });
}

async function git(args: string[], opts: { cwd?: string; author?: GitIdentity; maxBuffer?: number } = {}): Promise<string> {
  const r = await runGit(args, opts);
  if (r.code !== 0) throw new Error(`git ${args[0]} failed: ${r.stderr.trim()}`);
  return r.stdout.toString("utf8").trim();
}

export interface TreeEntry {
  path: string;
  size: number;
}

export class Repos {
  /** Serializes writes to refs/heads/main per house. */
  private locks = new Map<string, Promise<unknown>>();

  constructor(private readonly root: string) {}

  private gitDir(houseId: string): string {
    if (!idPattern.test(houseId)) throw new Error("bad house id");
    return path.join(this.root, houseId, "repo.git");
  }

  runDir(houseId: string, runId: string): string {
    if (!idPattern.test(houseId) || !idPattern.test(runId)) throw new Error("bad id");
    return path.join(this.root, houseId, "runs", runId);
  }

  /** Run fn while holding the house's ref lock. */
  async withLock<T>(houseId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(houseId) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((r) => (release = r));
    const chained = prev.then(() => next);
    this.locks.set(houseId, chained);
    await prev;
    try {
      return await fn();
    } finally {
      release();
      if (this.locks.get(houseId) === chained) this.locks.delete(houseId);
    }
  }

  async init(houseId: string, templateDir: string, author: GitIdentity): Promise<string> {
    const gitDir = this.gitDir(houseId);
    await fs.mkdir(path.dirname(gitDir), { recursive: true, mode: 0o700 });
    await git(["init", "--quiet", "--bare", "--initial-branch=main", gitDir]);
    const staging = await fs.mkdtemp(path.join(os.tmpdir(), "house-init-"));
    try {
      await fs.cp(templateDir, staging, { recursive: true });
      await git(["--git-dir", gitDir, "--work-tree", staging, "add", "--all", "."], { cwd: staging });
      const tree = await git(["--git-dir", gitDir, "write-tree"]);
      const commit = await git(["--git-dir", gitDir, "commit-tree", tree, "-m", "Move in: the default house"], { author });
      await git(["--git-dir", gitDir, "update-ref", "refs/heads/main", commit]);
      return commit;
    } finally {
      await fs.rm(staging, { recursive: true, force: true });
    }
  }

  async mainSha(houseId: string): Promise<string> {
    return git(["--git-dir", this.gitDir(houseId), "rev-parse", "--verify", "refs/heads/main^{commit}"]);
  }

  async hasCommit(houseId: string, sha: string): Promise<boolean> {
    if (!shaPattern.test(sha)) return false;
    const r = await runGit(["--git-dir", this.gitDir(houseId), "cat-file", "-e", `${sha}^{commit}`]);
    return r.code === 0;
  }

  async listFiles(houseId: string, sha: string): Promise<TreeEntry[]> {
    if (!shaPattern.test(sha)) throw new Error("bad sha");
    const out = await git(["--git-dir", this.gitDir(houseId), "ls-tree", "-r", "-l", "--full-tree", "-z", sha]);
    const entries: TreeEntry[] = [];
    for (const record of out.split("\u0000")) {
      if (!record) continue;
      // "<mode> <type> <object> <size>\t<path>"
      const tab = record.indexOf("\t");
      const meta = record.slice(0, tab).split(/\s+/);
      if (meta[1] !== "blob") continue;
      entries.push({ path: record.slice(tab + 1), size: Number(meta[3]) });
    }
    return entries;
  }

  /**
   * Read a regular file from a commit. Returns null for anything that is not a plain
   * blob (missing, directory, symlink, submodule).
   */
  async readFile(houseId: string, sha: string, filePath: string): Promise<Buffer | null> {
    if (!shaPattern.test(sha)) return null;
    const gitDir = this.gitDir(houseId);
    const ls = await runGit(["--git-dir", gitDir, "ls-tree", "-z", "--full-tree", sha, "--", filePath]);
    if (ls.code !== 0) return null;
    const record = ls.stdout.toString("utf8").split("\u0000")[0];
    if (!record) return null;
    const tab = record.indexOf("\t");
    const [mode, type, object] = record.slice(0, tab).split(/\s+/);
    if (record.slice(tab + 1) !== filePath) return null;
    if (type !== "blob" || (mode !== "100644" && mode !== "100755") || !object) return null;
    const blob = await runGit(["--git-dir", gitDir, "cat-file", "blob", object], { maxBuffer: 64 * 1024 * 1024 });
    return blob.code === 0 ? blob.stdout : null;
  }

  async addWorktree(houseId: string, runId: string, baseSha: string): Promise<string> {
    const dir = this.runDir(houseId, runId);
    await fs.mkdir(path.dirname(dir), { recursive: true, mode: 0o700 });
    await git(["--git-dir", this.gitDir(houseId), "worktree", "add", "--quiet", "--detach", dir, baseSha]);
    await git(["--git-dir", this.gitDir(houseId), "update-ref", `refs/runs/${runId}`, baseSha]);
    return dir;
  }

  /** Commit everything in a run's worktree. Returns the new HEAD (unchanged if nothing changed). */
  async commitWorktree(houseId: string, runId: string, message: string, author: GitIdentity): Promise<string> {
    const dir = this.runDir(houseId, runId);
    await git(["add", "--all", "."], { cwd: dir });
    const diff = await runGit(["diff", "--cached", "--quiet"], { cwd: dir });
    if (diff.code !== 0) {
      await git(["commit", "--quiet", "--no-verify", "-m", message], { cwd: dir, author });
    }
    const head = await git(["rev-parse", "HEAD"], { cwd: dir });
    await git(["--git-dir", this.gitDir(houseId), "update-ref", `refs/runs/${runId}`, head]);
    return head;
  }

  async removeWorktree(houseId: string, runId: string): Promise<void> {
    const dir = this.runDir(houseId, runId);
    await runGit(["--git-dir", this.gitDir(houseId), "worktree", "remove", "--force", dir]);
    await fs.rm(dir, { recursive: true, force: true });
    await runGit(["--git-dir", this.gitDir(houseId), "worktree", "prune"]);
  }

  async isAncestor(houseId: string, ancestor: string, descendant: string): Promise<boolean> {
    const r = await runGit(["--git-dir", this.gitDir(houseId), "merge-base", "--is-ancestor", ancestor, descendant]);
    return r.code === 0;
  }

  /** Three-way merge without a worktree. Returns the merged tree, or null on conflict. */
  async mergeTrees(houseId: string, base: string, ours: string, theirs: string): Promise<string | null> {
    const r = await runGit([
      "--git-dir", this.gitDir(houseId),
      "merge-tree", "--write-tree", "--no-messages", `--merge-base=${base}`, ours, theirs,
    ]);
    if (r.code === 0) return r.stdout.toString("utf8").split("\n")[0]!.trim();
    if (r.code === 1) return null;
    throw new Error(`git merge-tree failed: ${r.stderr.trim()}`);
  }

  async treeOf(houseId: string, sha: string): Promise<string> {
    return git(["--git-dir", this.gitDir(houseId), "rev-parse", "--verify", `${sha}^{tree}`]);
  }

  async commitTree(houseId: string, tree: string, parents: string[], message: string, author: GitIdentity): Promise<string> {
    const args = ["--git-dir", this.gitDir(houseId), "commit-tree", tree];
    for (const p of parents) args.push("-p", p);
    args.push("-m", message);
    return git(args, { author });
  }

  /** Compare-and-swap refs/heads/main. Throws if main moved underneath us. */
  async setMain(houseId: string, newSha: string, expectedOld: string): Promise<void> {
    await git(["--git-dir", this.gitDir(houseId), "update-ref", "refs/heads/main", newSha, expectedOld]);
  }

  async removeHouse(houseId: string): Promise<void> {
    await fs.rm(path.join(this.root, houseId), { recursive: true, force: true });
  }
}
