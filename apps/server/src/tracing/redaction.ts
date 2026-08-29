export const REDACTED = "[REDACTED]";

const SENSITIVE_KEYS = new Set([
  "ark_api_key",
  "api_key",
  "apikey",
  "app_auth_token",
  "authorization",
  "password",
  "passwd",
  "access_token",
  "refresh_token",
  "session_token",
  "client_secret",
  "private_key",
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

  if (SENSITIVE_KEYS.has(normalized) || RAW_PAYLOAD_KEYS.has(normalized)) {
    return true;
  }

  return (
    normalized.endsWith("_api_key") ||
    normalized.endsWith("_password") ||
    normalized.endsWith("_secret") ||
    normalized.endsWith("_private_key") ||
    normalized.endsWith("_access_token") ||
    normalized.endsWith("_refresh_token") ||
    normalized.endsWith("_session_token")
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
      /\b(ARK_API_KEY|API[_-]?KEY|APP_AUTH_TOKEN|PASSWORD|PASSWD|ACCESS[_-]?TOKEN|REFRESH[_-]?TOKEN|SESSION[_-]?TOKEN|CLIENT[_-]?SECRET|PRIVATE[_-]?KEY|AK|SK)\b\s*[:=]\s*[^\s,;]+/gi,
      (match) => `${match.split(/[:=]/)[0]}=${REDACTED}`,
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
