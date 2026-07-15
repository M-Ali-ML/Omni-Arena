import type {
  ChatMessage,
  Model,
  ModelProviderPort,
  ModelStreamChunk,
} from "../core/ports.js";

interface OpenAICompatibleOptions {
  baseUrl: string;
  apiKey?: string;
  headers?: Record<string, string>;
}

function endpointFor(baseUrl: string): string {
  const normalized = baseUrl.replace(/\/+$/u, "");
  return normalized.endsWith("/chat/completions")
    ? normalized
    : `${normalized}/chat/completions`;
}

async function responseError(response: Response): Promise<Error> {
  const body = await response.text();
  return new Error(
    `Model endpoint returned ${response.status}: ${body || response.statusText}`,
  );
}

export async function* readSseData(
  body: ReadableStream<Uint8Array>,
): AsyncIterable<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done }).replace(/\r\n/g, "\n");
    const blocks = buffer.split("\n\n");
    buffer = blocks.pop() ?? "";

    for (const block of blocks) {
      const data = block
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      if (data) {
        yield data;
      }
    }

    if (done) {
      const data = buffer
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      if (data) {
        yield data;
      }
      return;
    }
  }
}

export class OpenAICompatibleModelProvider implements ModelProviderPort {
  private readonly endpoint: string;

  constructor(private readonly options: OpenAICompatibleOptions) {
    if (!options.baseUrl) {
      throw new Error("An OpenAI-compatible base URL is required");
    }
    this.endpoint = endpointFor(options.baseUrl);
  }

  async *stream(
    model: Model,
    messages: ChatMessage[],
  ): AsyncIterable<ModelStreamChunk> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      ...this.options.headers,
    };
    if (this.options.apiKey) {
      headers.authorization = `Bearer ${this.options.apiKey}`;
    }

    const response = await fetch(this.endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: model.providerModelId,
        messages,
        stream: true,
        stream_options: { include_usage: true },
      }),
    });
    if (!response.ok) {
      throw await responseError(response);
    }
    if (!response.body) {
      throw new Error("Model endpoint returned no response body");
    }

    for await (const data of readSseData(response.body)) {
      if (data === "[DONE]") {
        return;
      }
      const chunk = JSON.parse(data) as {
        model?: string;
        choices?: Array<{ delta?: { content?: string | null } }>;
        usage?: {
          output_tokens?: number;
          completion_tokens?: number;
        } | null;
        error?: { message?: string };
      };
      if (chunk.error) {
        throw new Error(chunk.error.message ?? "Model endpoint stream failed");
      }

      const outputTokenCount =
        chunk.usage?.output_tokens ?? chunk.usage?.completion_tokens;
      if (chunk.model || outputTokenCount !== undefined) {
        yield {
          type: "metadata",
          modelVersion: chunk.model,
          outputTokenCount,
        };
      }
      const token = chunk.choices?.[0]?.delta?.content;
      if (token) {
        yield { type: "token", token };
      }
    }
  }
}
