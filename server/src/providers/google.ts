import { GoogleGenAI } from "@google/genai";
import type { Model, ModelProviderPort } from "../core/ports.js";

export class GoogleModelProvider implements ModelProviderPort {
  private readonly client: GoogleGenAI;

  constructor(apiKey: string) {
    if (!apiKey) {
      throw new Error("GOOGLE_API_KEY is required");
    }
    this.client = new GoogleGenAI({ apiKey });
  }

  async *stream(model: Model, prompt: string): AsyncIterable<string> {
    const response = await this.client.models.generateContentStream({
      model: model.providerModelId,
      contents: prompt,
    });

    for await (const chunk of response) {
      if (chunk.text) {
        yield chunk.text;
      }
    }
  }
}
