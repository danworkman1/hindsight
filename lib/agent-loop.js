// lib/agent-loop.js
// Generic agent loop: send messages, execute tool calls, loop until end_turn.

import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic(); // reads ANTHROPIC_API_KEY from env

// Model identifiers — exported so callers can pick per-phase
export const MODELS = {
  HAIKU: "claude-haiku-4-5",
  SONNET: "claude-sonnet-4-6",
  OPUS: "claude-opus-4-7",
};

const DEFAULT_MODEL = MODELS.OPUS;
const MAX_TOKENS = 4096;

/**
 * Run an agent loop until the model produces a final answer or hits maxIterations.
 *
 * @param {object} opts
 * @param {string} opts.system - System prompt
 * @param {string} opts.userPrompt - Initial user message
 * @param {Array} opts.tools - Tool schemas
 * @param {Object} opts.toolHandlers - Map of tool name -> handler function
 * @param {number} [opts.maxIterations=10] - Safety cap on loop iterations
 * @param {string} [opts.model] - Override the model for this run
 * @returns {Promise<string>} The final text response
 */
export async function runAgent({
  system,
  userPrompt,
  tools,
  toolHandlers,
  maxIterations = 10,
  model = DEFAULT_MODEL,
}) {
  const messages = [{ role: "user", content: userPrompt }];

  for (let i = 0; i < maxIterations; i++) {
    const response = await client.messages.create({
      model,
      max_tokens: MAX_TOKENS,
      system,
      tools,
      messages,
    });

    messages.push({ role: "assistant", content: response.content });

    if (response.stop_reason === "end_turn") {
      const textBlock = response.content.find((b) => b.type === "text");
      return textBlock?.text ?? "";
    }

    if (response.stop_reason === "tool_use") {
      const toolResults = [];

      for (const block of response.content) {
        if (block.type !== "tool_use") continue;

        const handler = toolHandlers[block.name];
        let result;

        if (!handler) {
          result = `Error: unknown tool "${block.name}"`;
        } else {
          try {
            result = await handler(block.input);
          } catch (err) {
            result = `Error: ${err.message}`;
          }
        }

        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: String(result),
        });
      }

      messages.push({ role: "user", content: toolResults });
      continue;
    }

    // Any other stop_reason (e.g. max_tokens) — bail out
    const textBlock = response.content.find((b) => b.type === "text");
    return textBlock?.text ?? `[stopped: ${response.stop_reason}]`;
  }

  return "[review hit max iterations]";
}