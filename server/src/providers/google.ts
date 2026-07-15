import { GoogleGenAI } from "@google/genai";
import type {
  ChatMessage,
  Model,
  ModelProviderPort,
  ModelStreamChunk,
} from "../core/ports.js";

export class GoogleModelProvider implements ModelProviderPort {
  private readonly client: GoogleGenAI;

  constructor(apiKey: string) {
    if (!apiKey) {
      throw new Error("GOOGLE_API_KEY is required");
    }
    this.client = new GoogleGenAI({ apiKey });
  }

  async *stream(
    model: Model,
    messages: ChatMessage[],
  ): AsyncIterable<ModelStreamChunk> {
    const response = await this.client.models.generateContentStream({
      model: model.providerModelId,
      contents: messages.map((message) => ({
        role: message.role === "assistant" ? "model" : "user",
        parts: [{ text: message.content }],
      })),
    });

    for await (const chunk of response) {
      const metadata = chunk as typeof chunk & {
        modelVersion?: string;
        usageMetadata?: { candidatesTokenCount?: number };
      };
      if (
        metadata.modelVersion ||
        metadata.usageMetadata?.candidatesTokenCount !== undefined
      ) {
        yield {
          type: "metadata",
          modelVersion: metadata.modelVersion,
          outputTokenCount: metadata.usageMetadata?.candidatesTokenCount,
        };
      }
      if (chunk.text) {
        yield { type: "token", token: chunk.text };
      }
    }
  }
}
