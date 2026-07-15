import { GoogleModelProvider } from "./google.js";
import { HostProxyModelProvider } from "./host-proxy.js";
import { OllamaModelProvider } from "./ollama.js";
import { OpenAICompatibleModelProvider } from "./openai-compatible.js";
import { ProviderRegistry } from "./registry.js";

export function createProviderRegistry(
  environment: NodeJS.ProcessEnv,
): ProviderRegistry {
  const registry = new ProviderRegistry();

  if (environment.GOOGLE_API_KEY) {
    registry.register(
      "google",
      new GoogleModelProvider(environment.GOOGLE_API_KEY),
    );
  }
  if (environment.OPENAI_API_KEY || environment.OPENAI_BASE_URL) {
    registry.register(
      "openai",
      new OpenAICompatibleModelProvider({
        baseUrl:
          environment.OPENAI_BASE_URL ?? "https://api.openai.com/v1",
        apiKey: environment.OPENAI_API_KEY,
      }),
    );
  }

  registry.register(
    "ollama",
    new OllamaModelProvider(
      environment.OLLAMA_BASE_URL ?? "http://localhost:11434",
    ),
  );

  if (environment.VLLM_BASE_URL) {
    registry.register(
      "vllm",
      new OpenAICompatibleModelProvider({
        baseUrl: environment.VLLM_BASE_URL,
        apiKey: environment.VLLM_API_KEY,
      }),
    );
  }
  if (environment.HOST_PROXY_URL) {
    registry.register(
      "host-proxy",
      new HostProxyModelProvider(
        environment.HOST_PROXY_URL,
        environment.HOST_PROXY_TOKEN,
      ),
    );
  }

  return registry;
}
