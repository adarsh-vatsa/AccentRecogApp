import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import type { AgentConfig } from "../config.ts";
import type { Checker } from "./check.ts";
import type { AgentMessageParam, AgentTool, ModelClient } from "./model.ts";
import { SYSTEM_PROMPT, firstUserMessage } from "./prompt.ts";
import { ToolError, type Workspace } from "./workspace.ts";

/**
 * The agent loop. Tools are file operations on a run's worktree plus check(), which
 * renders the house headlessly. No shell, no network, no access to other houses or
 * to chat. History is append-only: each assistant turn is pushed back verbatim.
 */

const TOOLS: AgentTool[] = [
  {
    name: "list_files",
    description: "List every file in the house with its size in bytes.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
    eager_input_streaming: true,
  },
  {
    name: "read_file",
    description: "Read a text file from the house.",
    input_schema: {
      type: "object",
      properties: { path: { type: "string", description: "Relative path, e.g. app.js or rooms/kitchen.js" } },
      required: ["path"],
      additionalProperties: false,
    },
    eager_input_streaming: true,
  },
  {
    name: "write_file",
    description: "Create or overwrite a file with the full contents given. Parent folders are created automatically.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Relative path, e.g. index.html or games/snake.js" },
        content: { type: "string", description: "The complete file contents" },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
    eager_input_streaming: true,
  },
  {
    name: "edit_file",
    description: "Replace one exact, unique snippet of an existing file. Copy old_text exactly from read_file output, with enough surrounding lines to be unique.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string" },
        old_text: { type: "string", description: "Exact text currently in the file; must appear exactly once" },
        new_text: { type: "string", description: "Replacement text" },
      },
      required: ["path", "old_text", "new_text"],
      additionalProperties: false,
    },
    eager_input_streaming: true,
  },
  {
    name: "delete_file",
    description: "Delete a file from the house.",
    input_schema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
      additionalProperties: false,
    },
    eager_input_streaming: true,
  },
  {
    name: "check",
    description:
      "Save the current files and load the house in a headless browser at desktop and phone sizes, as a member named Alex Tester with a friend Sam Friend online and two chat messages. Returns uncaught errors, requests the sandbox blocked, console errors, and screenshots of both sizes.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
    eager_input_streaming: true,
  },
];

const inputs = {
  list_files: z.object({}).strict(),
  read_file: z.object({ path: z.string() }).strict(),
  write_file: z.object({ path: z.string(), content: z.string() }).strict(),
  edit_file: z.object({ path: z.string(), old_text: z.string(), new_text: z.string() }).strict(),
  delete_file: z.object({ path: z.string() }).strict(),
  check: z.object({}).strict(),
} as const;

export interface HarnessDeps {
  model: ModelClient;
  checker: Checker;
  workspace: Workspace;
  cfg: AgentConfig;
  /** Commit the worktree and return a frame URL for that commit. */
  snapshot(): Promise<{ sha: string; frameUrl: string }>;
  log(kind: "text" | "tool" | "status", text: string): void;
  signal: AbortSignal;
}

export interface HarnessInput {
  prompt: string;
  requester: string;
  houseName: string;
  memberCount: number;
}

export interface HarnessResult {
  summary: string;
  incomplete: boolean;
  checks: number;
  turns: number;
}

export class AgentFailure extends Error {}

export async function runHarness(deps: HarnessDeps, input: HarnessInput): Promise<HarnessResult> {
  const files = await deps.workspace.list();
  const messages: AgentMessageParam[] = [
    { role: "user", content: firstUserMessage(input.prompt, input.requester, input.houseName, input.memberCount, files) },
  ];
  let checks = 0;
  let lastText = "";

  for (let turn = 1; turn <= deps.cfg.maxTurns; turn++) {
    if (deps.signal.aborted) throw new AgentFailure("Stopped");
    const message = await deps.model.turn({ system: SYSTEM_PROMPT, tools: TOOLS, messages }, deps.signal);
    messages.push({ role: "assistant", content: message.content });

    const texts = message.content.filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text").map((b) => b.text.trim()).filter(Boolean);
    if (texts.length) {
      lastText = texts.join("\n\n");
      deps.log("text", truncate(lastText, 300));
    }

    if (message.stop_reason === "refusal") {
      throw new AgentFailure("The builder declined this request.");
    }
    if (message.stop_reason === "pause_turn") continue;

    const toolUses = message.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
    if (toolUses.length === 0) {
      return { summary: lastText || "Done.", incomplete: false, checks, turns: turn };
    }

    const truncated = message.stop_reason === "max_tokens";
    const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
    for (const use of toolUses) {
      if (truncated) {
        results.push(errorResult(use.id, "Your output was cut off before this call finished, so it was not run. Write smaller pieces, or use edit_file."));
        continue;
      }
      results.push(await runTool(deps, use, () => checks++ < deps.cfg.maxChecks));
    }
    messages.push({ role: "user", content: results });
  }

  return {
    summary: lastText || "The builder ran out of steps before finishing. Preview it to see how far it got.",
    incomplete: true,
    checks,
    turns: deps.cfg.maxTurns,
  };
}

async function runTool(
  deps: HarnessDeps,
  use: Anthropic.Beta.BetaToolUseBlock,
  allowCheck: () => boolean,
): Promise<Anthropic.Beta.BetaToolResultBlockParam> {
  const name = use.name as keyof typeof inputs;
  const schema = inputs[name];
  if (!schema) return errorResult(use.id, `Unknown tool ${use.name}`);
  const parsed = schema.safeParse(use.input);
  if (!parsed.success) {
    // Covers eager-streamed input that parsed into a truncated or malformed object.
    return errorResult(use.id, JSON.stringify({ INVALID_INPUT: JSON.stringify(use.input).slice(0, 2000), issue: parsed.error.issues[0]?.message }));
  }
  const ws = deps.workspace;
  try {
    switch (name) {
      case "list_files": {
        const files = await ws.list();
        deps.log("tool", "Looked around the house");
        return okResult(use.id, files.map((f) => `${f.path} (${f.size} bytes)`).join("\n") || "(no files)");
      }
      case "read_file": {
        const a = parsed.data as z.infer<typeof inputs.read_file>;
        const text = await ws.read(a.path);
        deps.log("tool", `Read ${a.path}`);
        return okResult(use.id, text);
      }
      case "write_file": {
        const a = parsed.data as z.infer<typeof inputs.write_file>;
        const r = await ws.write(a.path, a.content);
        deps.log("tool", `${r.created ? "Created" : "Rewrote"} ${a.path}`);
        return okResult(use.id, `Wrote ${a.path} (${r.bytes} bytes)`);
      }
      case "edit_file": {
        const a = parsed.data as z.infer<typeof inputs.edit_file>;
        const r = await ws.edit(a.path, a.old_text, a.new_text);
        deps.log("tool", `Edited ${a.path}`);
        return okResult(use.id, `Edited ${a.path} (${r.bytes} bytes now)`);
      }
      case "delete_file": {
        const a = parsed.data as z.infer<typeof inputs.delete_file>;
        await ws.remove(a.path);
        deps.log("tool", `Deleted ${a.path}`);
        return okResult(use.id, `Deleted ${a.path}`);
      }
      case "check": {
        if (!allowCheck()) return errorResult(use.id, "Check limit reached for this run. Finish with what you have and summarize.");
        deps.log("tool", "Tried the house in a test browser");
        const { frameUrl } = await deps.snapshot();
        const r = await deps.checker.check(frameUrl, "Test House");
        const report = {
          rendered: r.available,
          sdk_connected: r.connected,
          errors: r.errors,
          blocked_by_sandbox: r.blocked,
          console_errors: r.console,
          note: r.note,
        };
        const content: Anthropic.Beta.BetaToolResultBlockParam["content"] = [{ type: "text", text: JSON.stringify(report, null, 2) }];
        for (const shot of r.screenshots) {
          content.push({ type: "text", text: `Screenshot, ${shot.label}:` });
          content.push({ type: "image", source: { type: "base64", media_type: "image/png", data: shot.png.toString("base64") } });
        }
        return { type: "tool_result", tool_use_id: use.id, content };
      }
    }
  } catch (err) {
    if (err instanceof ToolError) return errorResult(use.id, err.message);
    throw err;
  }
}

function okResult(id: string, text: string): Anthropic.Beta.BetaToolResultBlockParam {
  return { type: "tool_result", tool_use_id: id, content: text };
}

function errorResult(id: string, text: string): Anthropic.Beta.BetaToolResultBlockParam {
  return { type: "tool_result", tool_use_id: id, content: text, is_error: true };
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}
