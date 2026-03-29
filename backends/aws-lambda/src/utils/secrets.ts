import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";

const client = new SecretsManagerClient({});
const cache = new Map<string, { value: string; at: number }>();
const CACHE_TTL = 300_000;

export async function getSecret(name: string): Promise<string> {
  const cached = cache.get(name);
  if (cached && Date.now() - cached.at < CACHE_TTL) return cached.value;

  const res = await client.send(new GetSecretValueCommand({ SecretId: name }));
  const value = res.SecretString ?? "";
  cache.set(name, { value, at: Date.now() });
  return value;
}

export async function getProviderKey(provider: string): Promise<string> {
  return getSecret(`llm-proxy/${provider}-key`);
}

export async function getAdminKey(): Promise<string> {
  return getSecret("llm-proxy/admin-key");
}
