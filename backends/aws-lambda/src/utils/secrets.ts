import { createHash, timingSafeEqual } from "crypto";
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

/**
 * Zeitkonstanter Vergleich eines übergebenen Secrets (z. B. Admin-Key).
 * SHA-256 vorab gleicht die Längen an, damit timingSafeEqual nicht an der Länge scheitert.
 * Ein leerer erwarteter Key wird nie akzeptiert.
 */
export function secretMatches(provided: string | undefined, expected: string | undefined): boolean {
  if (!provided || !expected) return false;
  const a = createHash("sha256").update(provided).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}
