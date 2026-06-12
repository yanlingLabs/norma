import type { SecretStore } from "../auth/secret-store";
import type { Settings } from "../settings";
import type { Provider } from "./types";
import { OpenAICompatibleProvider } from "./openai-compatible";
import { CodexAuthStore, CodexOAuthProvider } from "./codex-oauth";
import { QuotaManager, withQuota } from "./quota";

export const OPENAI_API_KEY_SECRET = "openai-api-key";

export interface ActiveProvider {
  provider: Provider;
  model: string;
  quota: QuotaManager;
}

export async function createProvider(settings: Settings, secrets: SecretStore): Promise<ActiveProvider> {
  const quota = new QuotaManager();
  let inner: Provider;
  if (settings.provider.type === "codex-oauth") {
    inner = new CodexOAuthProvider({ authStore: new CodexAuthStore(secrets) });
  } else {
    const apiKey = await secrets.get(OPENAI_API_KEY_SECRET);
    if (!apiKey) throw new Error("no API key stored — run: norma login --api-key");
    inner = new OpenAICompatibleProvider({ baseUrl: settings.provider.baseUrl, apiKey });
  }
  return { provider: withQuota(inner, quota), model: settings.provider.model, quota };
}
