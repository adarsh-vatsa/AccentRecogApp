import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { ModelUnavailableError } from "../src/server/agent/model.ts";
import { Client, FakeChecker, ScriptedModel, assistant, frameGet, startApp, text, toolUse, waitUntil, type TestApp } from "./helpers.ts";

async function waitForRun(c: Client, houseId: string, runId: string, statuses: string[]): Promise<any> {
  return waitUntil(async () => {
    const r = await c.req("GET", `/api/houses/${houseId}/runs`);
    const run = r.json.runs.find((x: any) => x.id === runId);
    return run && statuses.includes(run.status) ? run : undefined;
  }, 10_000);
}

describe("builder runs", () => {
  let t: TestApp;
  let model: ScriptedModel;
  let checker: FakeChecker;
  let owner: Client;
  let friend: Client;
  let houseId: string;

  before(async () => {
    model = new ScriptedModel([]);
    checker = new FakeChecker();
    t = await startApp({ model, checker });
    owner = new Client(t);
    friend = new Client(t);
    await owner.signup("builder_bea", "Bea");
    await friend.signup("friend_finn", "Finn");
    houseId = await owner.createHouse("Bea's Place");
    await friend.join(owner, houseId);
  });
  after(async () => t.close());

  test("a run edits a private copy, previews, and ships to everyone", async () => {
    model.setScript([
      assistant([text("Let me look around."), toolUse("list_files", {})]),
      assistant([toolUse("read_file", { path: "index.html" })]),
      assistant([toolUse("edit_file", { path: "index.html", old_text: "Living room", new_text: "Disco room" })]),
      assistant([toolUse("write_file", { path: "disco.css", content: "body { background: hotpink; }" })]),
      assistant([toolUse("check", {})]),
      assistant([text("Your living room is now a disco room with pink walls.")], "end_turn"),
    ]);
    const before = (await owner.req("GET", `/api/houses/${houseId}`)).json.house.liveSha;
    const ws = await friend.ws();
    await ws.sub(houseId);

    const created = await owner.req("POST", `/api/houses/${houseId}/runs`, { prompt: "make it a disco" });
    assert.equal(created.status, 200);
    const run = await waitForRun(owner, houseId, created.json.run.id, ["ready", "failed"]);
    assert.equal(run.status, "ready", run.error);
    assert.equal(run.summary, "Your living room is now a disco room with pink walls.");
    assert.ok(run.log.some((l: any) => l.text === "Edited index.html"));
    assert.equal(checker.calls.length, 1);

    // The first turn got the request and the file listing; tool results came back.
    const firstUser = model.calls[0]!.messages[0]!.content as string;
    assert.match(firstUser, /<request>\nmake it a disco\n<\/request>/);
    assert.match(firstUser, /- index\.html \(\d+ bytes\)/);
    const readResult = (model.calls[2]!.messages.at(-1)!.content as any[])[0];
    assert.equal(readResult.type, "tool_result");
    assert.match(readResult.content, /Living room/);

    // Live is untouched until shipped; the preview shows the change.
    assert.equal((await owner.req("GET", `/api/houses/${houseId}`)).json.house.liveSha, before);
    const preview = await owner.req("GET", `/api/houses/${houseId}/frame?sha=${run.resultSha}`);
    assert.match((await frameGet(t, preview.json.url)).body, /Disco room/);
    assert.equal((await frameGet(t, preview.json.url, "disco.css")).headers["content-type"], "text/css; charset=utf-8");

    // Only the requester or owner can ship.
    assert.equal((await friend.req("POST", `/api/houses/${houseId}/runs/${run.id}/ship`)).status, 403);
    const shipped = await owner.req("POST", `/api/houses/${houseId}/runs/${run.id}/ship`);
    assert.equal(shipped.status, 200);
    assert.equal(shipped.json.run.status, "shipped");
    assert.equal(shipped.json.liveSha, run.resultSha);

    // Everyone is told; the live frame now serves the new version.
    const ev = await ws.waitFor((m) => m.t === "ev" && m.name === "version");
    assert.equal(ev.data.sha, run.resultSha);
    const live = await friend.req("GET", `/api/houses/${houseId}/frame`);
    assert.match((await frameGet(t, live.json.url)).body, /Disco room/);
    ws.close();

    // Version history shows who shipped what.
    const versions = (await friend.req("GET", `/api/houses/${houseId}/versions`)).json.versions;
    assert.equal(versions[0].kind, "ship");
    assert.equal(versions[0].by.name, "Bea");
    assert.equal(versions[0].live, true);
  });

  test("restoring an old version brings the old code back without touching chat", async () => {
    const ws = await owner.ws();
    await ws.sub(houseId);
    await ws.req(houseId, "chat.send", { body: "message before restore" });
    const versions = (await owner.req("GET", `/api/houses/${houseId}/versions`)).json.versions;
    const init = versions.find((v: any) => v.kind === "init");
    const r = await friend.req("POST", `/api/houses/${houseId}/versions/${init.sha}/restore`);
    assert.equal(r.status, 200);
    const live = await owner.req("GET", `/api/houses/${houseId}/frame`);
    const body = (await frameGet(t, live.json.url)).body;
    assert.match(body, /Living room/);
    assert.doesNotMatch(body, /Disco room/);
    const hist = await ws.req(houseId, "chat.list", {});
    assert.ok(hist.result.some((m: any) => m.body === "message before restore"));
    const after = (await owner.req("GET", `/api/houses/${houseId}/versions`)).json.versions;
    assert.equal(after[0].kind, "restore");
    ws.close();
  });

  test("two builds from the same base merge when they touch different files", async () => {
    model.setScript([
      assistant([toolUse("write_file", { path: "games/chess.js", content: "export const chess = 1;\n" })]),
      assistant([text("Added a chess table.")], "end_turn"),
    ]);
    const r1 = await owner.req("POST", `/api/houses/${houseId}/runs`, { prompt: "add chess" });
    const run1 = await waitForRun(owner, houseId, r1.json.run.id, ["ready", "failed"]);
    model.setScript([
      assistant([toolUse("write_file", { path: "games/darts.js", content: "export const darts = 1;\n" })]),
      assistant([text("Added darts.")], "end_turn"),
    ]);
    const r2 = await friend.req("POST", `/api/houses/${houseId}/runs`, { prompt: "add darts" });
    const run2 = await waitForRun(friend, houseId, r2.json.run.id, ["ready", "failed"]);
    assert.equal(run1.baseSha, run2.baseSha);

    assert.equal((await owner.req("POST", `/api/houses/${houseId}/runs/${run1.id}/ship`)).json.run.status, "shipped");
    const second = await friend.req("POST", `/api/houses/${houseId}/runs/${run2.id}/ship`);
    assert.equal(second.json.run.status, "shipped");
    const live = await owner.req("GET", `/api/houses/${houseId}/frame`);
    assert.equal((await frameGet(t, live.json.url, "games/chess.js")).status, 200);
    assert.equal((await frameGet(t, live.json.url, "games/darts.js")).status, 200);
  });

  test("conflicting builds are refused instead of clobbering each other", async () => {
    model.setScript([
      assistant([toolUse("edit_file", { path: "style.css", old_text: "--accent: #d9622b;", new_text: "--accent: #ff0000;" })]),
      assistant([text("Red.")], "end_turn"),
    ]);
    const r1 = await owner.req("POST", `/api/houses/${houseId}/runs`, { prompt: "red accent" });
    const run1 = await waitForRun(owner, houseId, r1.json.run.id, ["ready", "failed"]);
    model.setScript([
      assistant([toolUse("edit_file", { path: "style.css", old_text: "--accent: #d9622b;", new_text: "--accent: #0000ff;" })]),
      assistant([text("Blue.")], "end_turn"),
    ]);
    const r2 = await friend.req("POST", `/api/houses/${houseId}/runs`, { prompt: "blue accent" });
    const run2 = await waitForRun(friend, houseId, r2.json.run.id, ["ready", "failed"]);
    assert.equal((await owner.req("POST", `/api/houses/${houseId}/runs/${run1.id}/ship`)).json.run.status, "shipped");
    const second = await friend.req("POST", `/api/houses/${houseId}/runs/${run2.id}/ship`);
    assert.equal(second.json.run.status, "conflict");
    const live = await owner.req("GET", `/api/houses/${houseId}/frame`);
    assert.match((await frameGet(t, live.json.url, "style.css")).body, /#ff0000/);
  });

  test("bad tool input and escaping paths come back to the model as errors", async () => {
    model.setScript([
      assistant([toolUse("write_file", { path: "../../escape.txt", content: "nope" })]),
      assistant([toolUse("write_file", { path: ".git/config", content: "nope" })]),
      assistant([toolUse("write_file", { path: "ok.txt" })]),
      assistant([toolUse("read_file", { path: "missing.js" })]),
      assistant([toolUse("write_file", { path: "ok.txt", content: "fine" })]),
      assistant([text("Done after some mistakes.")], "end_turn"),
    ]);
    const callsBefore = model.calls.length;
    const r = await owner.req("POST", `/api/houses/${houseId}/runs`, { prompt: "test errors" });
    const run = await waitForRun(owner, houseId, r.json.run.id, ["ready", "failed"]);
    assert.equal(run.status, "ready");
    const resultOf = (i: number) => (model.calls[callsBefore + i]!.messages.at(-1)!.content as any[])[0];
    assert.equal(resultOf(1).is_error, true);
    assert.match(resultOf(1).content, /Invalid path/);
    assert.equal(resultOf(2).is_error, true);
    assert.equal(resultOf(3).is_error, true);
    assert.match(resultOf(3).content, /INVALID_INPUT/);
    assert.equal(resultOf(4).is_error, true);
    assert.match(resultOf(4).content, /No such file/);
    await owner.req("POST", `/api/houses/${houseId}/runs/${run.id}/discard`);
  });

  test("one build at a time per person, and stopping a build works", async () => {
    let started!: () => void;
    const startedP = new Promise<void>((r) => (started = r));
    model.setScript([
      (_p, signal) =>
        new Promise((_resolve, reject) => {
          started();
          signal.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    ]);
    const r1 = await owner.req("POST", `/api/houses/${houseId}/runs`, { prompt: "slow build" });
    await startedP;
    const r2 = await owner.req("POST", `/api/houses/${houseId}/runs`, { prompt: "another" });
    assert.equal(r2.status, 429);
    const stopped = await owner.req("POST", `/api/houses/${houseId}/runs/${r1.json.run.id}/discard`);
    assert.equal(stopped.json.run.status, "discarded");
    await new Promise((r) => setTimeout(r, 100));
    const runs = (await owner.req("GET", `/api/houses/${houseId}/runs`)).json.runs;
    assert.equal(runs.find((x: any) => x.id === r1.json.run.id).status, "discarded");
  });

  test("a build that changes nothing, or a missing API key, fails clearly", async () => {
    model.setScript([assistant([text("I don't think anything needs to change.")], "end_turn")]);
    const r1 = await owner.req("POST", `/api/houses/${houseId}/runs`, { prompt: "do nothing" });
    const run1 = await waitForRun(owner, houseId, r1.json.run.id, ["ready", "failed"]);
    assert.equal(run1.status, "failed");
    assert.match(run1.error, /didn't change anything/);

    model.setScript([
      () => {
        throw new ModelUnavailableError("The builder isn't configured on this server.");
      },
    ]);
    const r2 = await owner.req("POST", `/api/houses/${houseId}/runs`, { prompt: "anything" });
    const run2 = await waitForRun(owner, houseId, r2.json.run.id, ["ready", "failed"]);
    assert.equal(run2.status, "failed");
    assert.match(run2.error, /isn't configured/);
  });

  test("a refusal fails the run without shipping anything", async () => {
    model.setScript([assistant([], "refusal")]);
    const r = await owner.req("POST", `/api/houses/${houseId}/runs`, { prompt: "something declined" });
    const run = await waitForRun(owner, houseId, r.json.run.id, ["ready", "failed"]);
    assert.equal(run.status, "failed");
    assert.match(run.error, /declined/);
  });

  test("output cut off mid-tool-call is not executed", async () => {
    model.setScript([
      assistant([toolUse("write_file", { path: "half.js", content: "const x = " })], "max_tokens"),
      assistant([toolUse("write_file", { path: "whole.js", content: "const x = 1;" })]),
      assistant([text("Wrote it in smaller pieces.")], "end_turn"),
    ]);
    const r = await owner.req("POST", `/api/houses/${houseId}/runs`, { prompt: "big file" });
    const run = await waitForRun(owner, houseId, r.json.run.id, ["ready", "failed"]);
    assert.equal(run.status, "ready");
    const preview = await owner.req("GET", `/api/houses/${houseId}/frame?sha=${run.resultSha}`);
    assert.equal((await frameGet(t, preview.json.url, "half.js")).status, 404);
    assert.equal((await frameGet(t, preview.json.url, "whole.js")).status, 200);
  });

  test("without credentials the real Claude client fails with an actionable message", { skip: Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN) }, async () => {
    const { ClaudeModel } = await import("../src/server/agent/model.ts");
    const t2 = await startApp({ model: new ClaudeModel(t.cfg.agent) });
    try {
      const c = new Client(t2);
      await c.signup("nokey_nick");
      const h = await c.createHouse();
      const r = await c.req("POST", `/api/houses/${h}/runs`, { prompt: "anything" });
      const run = await waitForRun(c, h, r.json.run.id, ["ready", "failed"]);
      assert.equal(run.status, "failed");
      assert.match(run.error, /ANTHROPIC_API_KEY/);
    } finally {
      await t2.close();
    }
  });

  test("the system prompt stays byte-identical across runs (prompt caching)", () => {
    const systems = new Set(model.calls.map((c) => c.system));
    assert.equal(systems.size, 1);
    const tools = new Set(model.calls.map((c) => JSON.stringify(c.tools)));
    assert.equal(tools.size, 1);
  });
});
