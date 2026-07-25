import { randomUUID } from "node:crypto";

/**
 * Minimal writer for a single-choice OpenAI streaming completion.
 *
 * Single-choice is not a simplification, it is a requirement: Open WebUI reads
 * `choices[0]` and nothing else, in both its browser stream parser
 * (`src/lib/apis/streaming/index.ts`) and its backend one
 * (`backend/open_webui/utils/middleware.py`). Anything the bridge puts on
 * `choices[1]` is discarded silently.
 */
export class CompletionWriter {
  constructor(response, model) {
    this.id = `chatcmpl-${randomUUID()}`;
    this.created = Math.floor(Date.now() / 1000);
    this.model = model;
    this.response = response;
    this.closed = false;
  }

  start() {
    this.response.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    this.#frame({ role: "assistant" }, null);
  }

  text(content) {
    if (content) {
      this.#frame({ content }, null);
    }
  }

  finish(reason = "stop") {
    if (this.closed) {
      return;
    }
    this.#frame({}, reason);
    this.response.write("data: [DONE]\n\n");
    this.response.end();
    this.closed = true;
  }

  #frame(delta, finishReason) {
    if (this.closed) {
      return;
    }
    const chunk = {
      id: this.id,
      object: "chat.completion.chunk",
      created: this.created,
      model: this.model,
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    };
    this.response.write(`data: ${JSON.stringify(chunk)}\n\n`);
  }
}

/** A complete non-streaming completion, for Open WebUI's title/tag tasks. */
export function completionJson(model, content) {
  return {
    id: `chatcmpl-${randomUUID()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}
