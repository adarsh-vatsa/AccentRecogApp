import { randomId } from "../auth.ts";
import type { Config } from "../config.ts";
import type { DB, RunRow, RunStatus, UserRow } from "../db.ts";
import { HttpError } from "../http.ts";
import { identityFor, type HouseService } from "../houses.ts";
import type { Repos } from "../repo.ts";
import type { Checker } from "./check.ts";
import { AgentFailure, runHarness } from "./harness.ts";
import { describeModelError, type ModelClient } from "./model.ts";
import { Workspace } from "./workspace.ts";

export interface RunLogEntry {
  at: number;
  kind: "text" | "tool" | "status";
  text: string;
}

export interface PublicRun {
  id: string;
  status: RunStatus;
  prompt: string;
  by: { id: string; name: string };
  createdAt: number;
  updatedAt: number;
  summary: string | null;
  error: string | null;
  baseSha: string;
  resultSha: string | null;
  log: RunLogEntry[];
}

const ACTIVE: RunStatus[] = ["queued", "running"];
const MAX_LOG = 200;

/**
 * Agent runs: queue, execute, preview, ship, discard. A run edits its own worktree
 * branched from the live version; shipping merges it into main (three-way, no
 * checkout), so two people building at once don't clobber each other.
 */
export class RunService {
  private queue: string[] = [];
  private running = new Map<string, AbortController>();

  constructor(
    private readonly db: DB,
    private readonly repos: Repos,
    private readonly houses: HouseService,
    private readonly cfg: Config,
    private readonly model: ModelClient,
    private readonly checker: Checker,
  ) {}

  /** Runs that were in flight when the server stopped can't be resumed. */
  recover(): void {
    const stale = this.db.prepare("SELECT * FROM runs WHERE status IN ('queued', 'running')").all() as unknown as RunRow[];
    for (const run of stale) {
      this.update(run.id, { status: "failed", error: "Interrupted by a server restart. Try again." });
      void this.repos.removeWorktree(run.house_id, run.id).catch(() => {});
    }
  }

  async shutdown(): Promise<void> {
    for (const ctl of this.running.values()) ctl.abort();
    await this.checker.close();
  }

  private row(runId: string): RunRow | undefined {
    return this.db.prepare("SELECT * FROM runs WHERE id = ?").get(runId) as RunRow | undefined;
  }

  private toPublic(run: RunRow): PublicRun {
    const user = this.db.prepare("SELECT id, display_name FROM users WHERE id = ?").get(run.user_id) as
      | { id: string; display_name: string }
      | undefined;
    return {
      id: run.id,
      status: run.status,
      prompt: run.prompt,
      by: { id: run.user_id, name: user?.display_name ?? "someone" },
      createdAt: run.created_at,
      updatedAt: run.updated_at,
      summary: run.summary,
      error: run.error,
      baseSha: run.base_sha,
      resultSha: run.result_sha,
      log: JSON.parse(run.log) as RunLogEntry[],
    };
  }

  private update(runId: string, patch: Partial<Pick<RunRow, "status" | "result_sha" | "summary" | "error" | "log">>): PublicRun | undefined {
    const sets: string[] = [];
    const values: Array<string | number | null> = [];
    for (const [k, v] of Object.entries(patch)) {
      sets.push(`${k} = ?`);
      values.push(v as string | null);
    }
    sets.push("updated_at = ?");
    values.push(Date.now());
    this.db.prepare(`UPDATE runs SET ${sets.join(", ")} WHERE id = ?`).run(...values, runId);
    const row = this.row(runId);
    if (!row) return undefined;
    const pub = this.toPublic(row);
    this.houses.publish(row.house_id, "run", pub);
    return pub;
  }

  private appendLog(runId: string, kind: RunLogEntry["kind"], text: string): void {
    const row = this.row(runId);
    if (!row) return;
    const log = JSON.parse(row.log) as RunLogEntry[];
    log.push({ at: Date.now(), kind, text: text.slice(0, 500) });
    this.update(runId, { log: JSON.stringify(log.slice(-MAX_LOG)) });
  }

  list(houseId: string): PublicRun[] {
    const rows = this.db.prepare("SELECT * FROM runs WHERE house_id = ? ORDER BY created_at DESC LIMIT 30").all(houseId) as unknown as RunRow[];
    return rows.map((r) => this.toPublic(r));
  }

  get(houseId: string, runId: string): RunRow {
    const row = this.row(runId);
    if (!row || row.house_id !== houseId) throw new HttpError(404, "Run not found");
    return row;
  }

  async create(houseId: string, user: UserRow, prompt: string): Promise<PublicRun> {
    const house = this.houses.getHouse(houseId);
    if (!house) throw new HttpError(404, "House not found");
    const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
    const { n: today } = this.db.prepare("SELECT COUNT(*) AS n FROM runs WHERE user_id = ? AND created_at > ?").get(user.id, dayAgo) as { n: number };
    if (today >= this.cfg.agent.runsPerUserPerDay) throw new HttpError(429, "You've used today's builds. Try again tomorrow.");
    const { n: mine } = this.db
      .prepare(`SELECT COUNT(*) AS n FROM runs WHERE user_id = ? AND status IN ('queued', 'running')`)
      .get(user.id) as { n: number };
    if (mine > 0) throw new HttpError(429, "You already have a build in progress. Wait for it to finish, or stop it.");

    const id = randomId();
    const now = Date.now();
    this.db
      .prepare(
        "INSERT INTO runs (id, house_id, user_id, prompt, status, base_sha, log, created_at, updated_at) VALUES (?, ?, ?, ?, 'queued', ?, '[]', ?, ?)",
      )
      .run(id, houseId, user.id, prompt, house.live_sha, now, now);
    this.queue.push(id);
    const pub = this.toPublic(this.row(id)!);
    this.houses.publish(houseId, "run", pub);
    this.pump();
    return pub;
  }

  private activeInHouse(houseId: string): number {
    let n = 0;
    for (const runId of this.running.keys()) if (this.row(runId)?.house_id === houseId) n++;
    return n;
  }

  private pump(): void {
    for (let i = 0; i < this.queue.length; ) {
      if (this.running.size >= this.cfg.agent.maxConcurrentGlobal) return;
      const runId = this.queue[i]!;
      const run = this.row(runId);
      if (!run || run.status !== "queued") {
        this.queue.splice(i, 1);
        continue;
      }
      if (this.activeInHouse(run.house_id) >= this.cfg.agent.maxConcurrentPerHouse) {
        i++;
        continue;
      }
      this.queue.splice(i, 1);
      const ctl = new AbortController();
      this.running.set(runId, ctl);
      void this.execute(run, ctl.signal).finally(() => {
        this.running.delete(runId);
        this.pump();
      });
    }
  }

  private async execute(run: RunRow, signal: AbortSignal): Promise<void> {
    const user = this.db.prepare("SELECT * FROM users WHERE id = ?").get(run.user_id) as UserRow | undefined;
    const house = this.houses.getHouse(run.house_id);
    if (!user || !house) return;
    this.update(run.id, { status: "running" });
    this.appendLog(run.id, "status", "Started building");
    let worktreeReady = false;
    try {
      const dir = await this.repos.addWorktree(run.house_id, run.id, run.base_sha);
      worktreeReady = true;
      const author = identityFor(user);
      const message = `Builder: ${run.prompt.replace(/\s+/g, " ").slice(0, 120)}`;
      const result = await runHarness(
        {
          model: this.model,
          checker: this.checker,
          workspace: new Workspace(dir),
          cfg: this.cfg.agent,
          signal,
          log: (kind, text) => this.appendLog(run.id, kind, text),
          snapshot: async () => {
            const sha = await this.repos.commitWorktree(run.house_id, run.id, `${message} (work in progress)`, author);
            return { sha, frameUrl: await this.houses.frameUrl(run.house_id, sha) };
          },
        },
        {
          prompt: run.prompt,
          requester: user.display_name,
          houseName: house.name,
          memberCount: this.houses.members(run.house_id).length,
        },
      );
      if (this.row(run.id)?.status !== "running") return; // discarded meanwhile
      const sha = await this.repos.commitWorktree(run.house_id, run.id, message, author);
      if (sha === run.base_sha) {
        this.update(run.id, { status: "failed", summary: result.summary, error: "The builder didn't change anything." });
      } else {
        this.update(run.id, { status: "ready", result_sha: sha, summary: result.summary });
        this.appendLog(run.id, "status", result.incomplete ? "Stopped early; preview to see how far it got" : "Ready to preview");
      }
    } catch (err) {
      const current = this.row(run.id);
      if (current?.status !== "running") return;
      let error = "Something went wrong while building. Try again.";
      const described = describeModelError(err);
      if (err instanceof AgentFailure) error = err.message;
      else if (described) error = described;
      if (!(err instanceof AgentFailure)) console.error("[runs]", (err as Error)?.message ?? err);
      this.update(run.id, { status: "failed", error });
    } finally {
      // Keep the worktree only while the run can still be shipped from it. Commits
      // live on under refs/runs/<id>, so previews keep working either way.
      if (worktreeReady) await this.repos.removeWorktree(run.house_id, run.id).catch(() => {});
    }
  }

  private requireActor(houseId: string, run: RunRow, user: UserRow): void {
    const membership = this.houses.membership(houseId, user.id);
    if (run.user_id !== user.id && membership?.role !== "owner") {
      throw new HttpError(403, "Only the person who asked for this change, or the house owner, can do that");
    }
  }

  async ship(houseId: string, runId: string, user: UserRow): Promise<{ run: PublicRun; liveSha: string }> {
    const run = this.get(houseId, runId);
    this.requireActor(houseId, run, user);
    if (run.status !== "ready" || !run.result_sha) throw new HttpError(409, "This change isn't ready to ship");
    const resultSha = run.result_sha;
    return this.repos.withLock(houseId, async () => {
      const live = await this.repos.mainSha(houseId);
      let next: string;
      if (live === run.base_sha) {
        next = resultSha;
      } else {
        const tree = await this.repos.mergeTrees(houseId, run.base_sha, live, resultSha);
        if (tree === null) {
          const pub = this.update(runId, { status: "conflict", error: "Someone else changed the same parts of the house first." })!;
          return { run: pub, liveSha: live };
        }
        next = await this.repos.commitTree(houseId, tree, [live, resultSha], `Merge: ${run.prompt.slice(0, 100)}`, identityFor(user));
      }
      await this.repos.setMain(houseId, next, live);
      const summary = run.summary?.split("\n")[0]?.slice(0, 160) || run.prompt.slice(0, 160);
      this.houses.recordLive(houseId, next, "ship", user, runId, summary);
      const pub = this.update(runId, { status: "shipped" })!;
      return { run: pub, liveSha: next };
    });
  }

  discard(houseId: string, runId: string, user: UserRow): PublicRun {
    const run = this.get(houseId, runId);
    this.requireActor(houseId, run, user);
    if (!["queued", "running", "ready", "conflict", "failed"].includes(run.status)) {
      throw new HttpError(409, "This change can't be discarded");
    }
    const pub = this.update(runId, { status: "discarded" })!;
    this.running.get(runId)?.abort();
    this.queue = this.queue.filter((id) => id !== runId);
    return pub;
  }

  isActive(status: RunStatus): boolean {
    return ACTIVE.includes(status);
  }
}
