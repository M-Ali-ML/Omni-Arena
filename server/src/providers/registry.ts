import type {
  ModelProviderPort,
  ProviderResolverPort,
} from "../core/ports.js";

export class ProviderRegistry implements ProviderResolverPort {
  private readonly providers = new Map<string, ModelProviderPort>();

  register(name: string, provider: ModelProviderPort): this {
    this.providers.set(name, provider);
    return this;
  }

  resolve(provider: string): ModelProviderPort {
    const implementation = this.providers.get(provider);
    if (!implementation) {
      throw new Error(`No provider registered for "${provider}"`);
    }
    return implementation;
  }
}
