import type {
  ChatMessage,
  Model,
  ModelProviderPort,
  ModelStreamChunk,
} from "../core/ports.js";
import { OpenAICompatibleModelProvider } from "./openai-compatible.js";

export class HostProxyModelProvider implements ModelProviderPort {
  private readonly delegate: OpenAICompatibleModelProvider;

  constructor(endpoint: string, token?: string) {
    this.delegate = new OpenAICompatibleModelProvider({
      baseUrl: endpoint,
      apiKey: token,
      headers: { "x-omni-arena-proxy": "1" },
    });
  }

  stream(
    model: Model,
    messages: ChatMessage[],
  ): AsyncIterable<ModelStreamChunk> {
    return this.delegate.stream(model, messages);
  }
}
