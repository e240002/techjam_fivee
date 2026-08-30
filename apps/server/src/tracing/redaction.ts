export const REDACTED = "[REDACTED]";

const SAFE_TELEMETRY_KEYS = new Set([
  "input_tokens",
  "cached_input_tokens",
  "output_tokens",
]);

const SENSITIVE_KEYS = new Set([
  "ark_api_key",
  "api_key",
  "apikey",
  "app_auth_token",
  "authorization",
  "password",
  "passwd",
  "token",
  "auth_token",
  "id_token",
  "access_token",
  "refresh_token",
  "session_token",
  "client_secret",
  "secret_key",
  "access_key",
  "access_key_id",
  "private_key",
  "credentials",
  "cookie",
  "ak",
  "sk",
]);

const RAW_PAYLOAD_KEYS = new Set([
  "prompt",
  "output",
  "stderr",
  "stdout",
  "raw_payload",
  "request_body",
  "response_body",
  "workspace_contents",
  "process_env",
]);

function normalizeKey(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .toLowerCase();
}

function isSensitiveKey(key: string): boolean {
  const normalized = normalizeKey(key);

  if (SAFE_TELEMETRY_KEYS.has(normalized)) {
    return false;
  }

  if (SENSITIVE_KEYS.has(normalized) || RAW_PAYLOAD_KEYS.has(normalized)) {
    return true;
  }

  return (
    normalized === "token" ||
    normalized.endsWith("_token") ||
    normalized.endsWith("_api_key") ||
    normalized.endsWith("_password") ||
    normalized.endsWith("_passwd") ||
    normalized.endsWith("_secret") ||
    normalized.endsWith("_secret_key") ||
    normalized.endsWith("_access_key") ||
    normalized.endsWith("_access_key_id") ||
    normalized.endsWith("_private_key") ||
    normalized.endsWith("_credentials")
  );
}

export function sanitizeText(text: string): string {
  return text
    .replace(
      /\bAuthorization\s*[:=]\s*[^\r\n,;]+/gi,
      `Authorization=${REDACTED}`,
    )
    .replace(
      /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi,
      `Bearer ${REDACTED}`,
    )
    .replace(
      /["']?(ARK_API_KEY|API[_-]?KEY|APP_AUTH_TOKEN|PASSWORD|PASSWD|AUTH[_-]?TOKEN|ID[_-]?TOKEN|ACCESS[_-]?TOKEN|REFRESH[_-]?TOKEN|SESSION[_-]?TOKEN|CLIENT[_-]?SECRET|SECRET[_-]?KEY|ACCESS[_-]?KEY(?:[_-]?ID)?|PRIVATE[_-]?KEY|AK|SK)["']?\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;}\]]+)/gi,
      (match) => {
        const separatorIndex = match.search(/[:=]/);
        const key = match.slice(0, separatorIndex).replace(/["']/g, "");
        return `${key}=${REDACTED}`;
      },
    );
}

function sanitizeValue(value: unknown): unknown {
  if (typeof value === "string") return sanitizeText(value);

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeValue(item));
  }

  if (value === null || typeof value !== "object") return value;

  const result: Record<string, unknown> = {};

  for (const [key, item] of Object.entries(value)) {
    result[key] = isSensitiveKey(key) ? REDACTED : sanitizeValue(item);
  }

  return result;
}

export function sanitizeMetadata(
  metadata: Record<string, unknown>,
): Record<string, unknown> {
  return sanitizeValue(metadata) as Record<string, unknown>;
}
