import Anthropic from "@anthropic-ai/sdk";
import type { AgentConfig } from "../config.ts";

export type AgentMessage = Anthropic.Beta.BetaMessage;
export type AgentMessageParam = Anthropic.Beta.BetaMessageParam;
export type AgentTool = Anthropic.Beta.BetaToolUnion;

export interface TurnParams {
  system: string;
  tools: AgentTool[];
  messages: AgentMessageParam[];
}

/** One model turn. Swappable so tests (and other agent backends) can stand in. */
export interface ModelClient {
  turn(params: TurnParams, signal: AbortSignal): Promise<AgentMessage>;
}

export class ModelUnavailableError extends Error {}

/** A message members can act on, for errors from the model API. */
export function describeModelError(err: unknown): string | undefined {
  if (err instanceof ModelUnavailableError) return err.message;
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
    return "The builder's API key was rejected. Whoever runs this server needs to fix ANTHROPIC_API_KEY.";
  }
  if (err instanceof Anthropic.RateLimitError) return "The builder is busy right now. Try again in a minute.";
  if (err instanceof Anthropic.APIConnectionError) return "Couldn't reach the builder service. Try again.";
  if (err instanceof Anthropic.InternalServerError) return "The builder service had a problem. Try again.";
  if (err instanceof Anthropic.APIError) return `The builder service refused the request (${err.status ?? "error"}).`;
  // Credential resolution fails before any request is sent, with an untyped error.
  if (err instanceof Error && /resolve authentication/i.test(err.message)) {
    return "The builder isn't set up on this server yet. Whoever runs it needs to set ANTHROPIC_API_KEY.";
  }
  return undefined;
}

/**
 * Claude via the Messages API. Streams each turn (large file writes) and collects
 * the final message. Server-side fallback is on, so a classifier decline is retried
 * on Anthropic's recommended fallback model instead of failing the run outright.
 */
export class ClaudeModel implements ModelClient {
  private client: Anthropic | undefined;

  constructor(private readonly cfg: AgentConfig) {}

  private getClient(): Anthropic {
    if (!this.client) {
      try {
        this.client = new Anthropic();
      } catch (err) {
        throw new ModelUnavailableError(
          `The builder isn't configured on this server (${(err as Error).message}). Set ANTHROPIC_API_KEY and restart.`,
        );
      }
    }
    return this.client;
  }

  async turn(params: TurnParams, signal: AbortSignal): Promise<AgentMessage> {
    const client = this.getClient();
    let jsonRetries = 0;
    for (;;) {
      const stream = client.beta.messages.stream(
        {
          model: this.cfg.model,
          max_tokens: 64000,
          betas: ["server-side-fallback-2026-07-01"],
          fallbacks: "default",
          thinking: { type: "adaptive" },
          output_config: { effort: this.cfg.effort },
          cache_control: { type: "ephemeral" },
          system: params.system,
          tools: params.tools,
          messages: params.messages,
        },
        { signal },
      );
      try {
        return await stream.finalMessage();
      } catch (err) {
        // With eager input streaming, unparseable tool JSON rejects here. Retry that
        // (capped); rethrow real API errors (auth, rate limits, aborts).
        if (err instanceof Anthropic.APIError || signal.aborted || jsonRetries++ >= 2) throw err;
      }
    }
  }
}
