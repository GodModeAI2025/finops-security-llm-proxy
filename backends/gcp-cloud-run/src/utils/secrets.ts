import { SecretManagerServiceClient } from "@google-cloud/secret-manager";

const client = new SecretManagerServiceClient();
const PROJECT_ID = process.env.GCP_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT || "";

// Cache secrets in memory (they rarely change)
const secretCache = new Map<string, { value: string; fetchedAt: number }>();
const CACHE_TTL_MS = 300_000; // 5 minutes

export async function getSecret(secretName: string): Promise<string> {
  const cached = secretCache.get(secretName);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.value;
  }

  const name = `projects/${PROJECT_ID}/secrets/${secretName}/versions/latest`;

  try {
    const [version] = await client.accessSecretVersion({ name });
    const value = version.payload?.data?.toString() ?? "";

    secretCache.set(secretName, { value, fetchedAt: Date.now() });
    return value;
  } catch (err: any) {
    // In local dev, fall back to environment variables
    const envKey = secretName.toUpperCase().replace(/-/g, "_");
    const envValue = process.env[envKey];
    if (envValue) return envValue;

    throw new Error(`Secret "${secretName}" not found: ${err.message}`);
  }
}

/**
 * Resolve the actual API key for a provider.
 * Secret naming convention: llm-proxy-{provider}-key
 */
export async function getProviderKey(provider: string): Promise<string> {
  return getSecret(`llm-proxy-${provider}-key`);
}

/**
 * Get the admin key for authenticating /admin/* endpoints.
 */
export async function getAdminKey(): Promise<string> {
  return getSecret("llm-proxy-admin-key");
}
