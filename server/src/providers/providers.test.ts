import { afterEach, describe, expect, it, vi } from "vitest";
import type { Model, ModelStreamChunk } from "../core/ports.js";
import { HostProxyModelProvider } from "./host-proxy.js";
import { OllamaModelProvider } from "./ollama.js";
import { OpenAICompatibleModelProvider } from "./openai-compatible.js";

const model: Model = {
  id: "00000000-0000-4000-8000-000000000001",
  displayName: "Test model",
  provider: "test",
  providerModelId: "test-model",
  enabled: true,
};
const messages = [
  { role: "user" as const, content: "Hello" },
  { role: "assistant" as const, content: "Hi" },
  { role: "user" as const, content: "Continue" },
];

function chunkedBody(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
}

async function collect(
  stream: AsyncIterable<ModelStreamChunk>,
): Promise<ModelStreamChunk[]> {
  const chunks: ModelStreamChunk[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  return chunks;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("OpenAICompatibleModelProvider", () => {
  it("streams tokens and provider metadata from chat completions SSE", async () => {
    const fetchMock = vi.fn(
      async (_url: RequestInfo | URL, _init?: RequestInit) => {
      return new Response(
        chunkedBody([
          'data: {"model":"test-model-2026-07","choices":[{"delta":{"content":"Hel',
          'lo"}}]}\n\ndata: {"choices":[],"usage":{"completion_tokens":4}}\n\n',
          "data: [DONE]\n\n",
        ]),
        { status: 200 },
      );
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    const provider = new OpenAICompatibleModelProvider({
      baseUrl: "https://models.example/v1",
      apiKey: "secret",
    });

    await expect(collect(provider.stream(model, messages))).resolves.toEqual([
      { type: "metadata", modelVersion: "test-model-2026-07" },
      { type: "token", token: "Hello" },
      { type: "metadata", outputTokenCount: 4 },
    ]);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://models.example/v1/chat/completions",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          authorization: "Bearer secret",
        }),
      }),
    );
    const request = fetchMock.mock.calls[0]?.[1];
    if (!request) {
      throw new Error("Missing provider request");
    }
    expect(JSON.parse(String(request.body))).toMatchObject({
      model: "test-model",
      messages,
      stream: true,
    });
  });
});

describe("OllamaModelProvider", () => {
  it("parses Ollama NDJSON and final token usage", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response(
          chunkedBody([
            '{"model":"llama3.2","message":{"content":"Hi"}}\n',
            '{"model":"llama3.2","message":{"content":" there"},"done":false}\n',
            '{"model":"llama3.2","done":true,"eval_count":3}\n',
          ]),
          { status: 200 },
        );
      }),
    );
    const provider = new OllamaModelProvider("http://ollama.internal");

    const chunks = await collect(provider.stream(model, messages));

    expect(chunks.filter((chunk) => chunk.type === "token")).toEqual([
      { type: "token", token: "Hi" },
      { type: "token", token: " there" },
    ]);
    expect(chunks.at(-1)).toEqual({
      type: "metadata",
      modelVersion: "llama3.2",
      outputTokenCount: 3,
    });
  });
});

describe("HostProxyModelProvider", () => {
  it("uses the host's OpenAI-compatible proxy without provider keys", async () => {
    const fetchMock = vi.fn(
      async (_url: RequestInfo | URL, _init?: RequestInit) => {
        return new Response(chunkedBody(["data: [DONE]\n\n"]), {
          status: 200,
        });
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    const provider = new HostProxyModelProvider(
      "https://host.example/arena/v1",
      "proxy-token",
    );

    await collect(provider.stream(model, messages));

    expect(fetchMock).toHaveBeenCalledWith(
      "https://host.example/arena/v1/chat/completions",
      expect.objectContaining({
        headers: expect.objectContaining({
          authorization: "Bearer proxy-token",
          "x-omni-arena-proxy": "1",
        }),
      }),
    );
  });
});
