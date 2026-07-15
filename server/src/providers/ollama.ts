import type {
  ChatMessage,
  Model,
  ModelProviderPort,
  ModelStreamChunk,
} from "../core/ports.js";

function endpointFor(baseUrl: string): string {
  const normalized = baseUrl.replace(/\/+$/u, "");
  return normalized.endsWith("/api/chat")
    ? normalized
    : `${normalized}/api/chat`;
}

export class OllamaModelProvider implements ModelProviderPort {
  private readonly endpoint: string;

  constructor(baseUrl = "http://localhost:11434") {
    this.endpoint = endpointFor(baseUrl);
  }

  async *stream(
    model: Model,
    messages: ChatMessage[],
  ): AsyncIterable<ModelStreamChunk> {
    const response = await fetch(this.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: model.providerModelId,
        messages,
        stream: true,
      }),
    });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(
        `Ollama returned ${response.status}: ${body || response.statusText}`,
      );
    }
    if (!response.body) {
      throw new Error("Ollama returned no response body");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      const lines = buffer.split(/\r?\n/u);
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        yield* this.parseLine(line);
      }
      if (done) {
        if (buffer.trim()) {
          yield* this.parseLine(buffer);
        }
        return;
      }
    }
  }

  private *parseLine(line: string): Iterable<ModelStreamChunk> {
    if (!line.trim()) {
      return;
    }
    const chunk = JSON.parse(line) as {
      model?: string;
      message?: { content?: string };
      eval_count?: number;
      error?: string;
    };
    if (chunk.error) {
      throw new Error(chunk.error);
    }
    if (chunk.model || chunk.eval_count !== undefined) {
      yield {
        type: "metadata",
        modelVersion: chunk.model,
        outputTokenCount: chunk.eval_count,
      };
    }
    if (chunk.message?.content) {
      yield { type: "token", token: chunk.message.content };
    }
  }
}
