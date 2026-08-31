export const REDACTED = "[REDACTED]";
export const CIRCULAR = "[CIRCULAR]";

const QUOTED_PREDICATE_PATTERN =
  /(?<![A-Za-z0-9_.-])([A-Za-z][A-Za-z0-9._-]*)\s+(is|was|are|were)\s+("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;]+)/gi;

const NON_SECRET_STATUS_VALUES = new Set([
  "available",
  "empty",
  "expired",
  "invalid",
  "missing",
  "required",
  "revoked",
  "unavailable",
  "unset",
]);

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
  "secret",
  "secrets",
  "token",
  "tokens",
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
  "credential",
  "credentials",
  "cookie",
  "cookies",
  "set_cookie",
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
    normalized.endsWith("_tokens") ||
    normalized.endsWith("_api_key") ||
    normalized.endsWith("_password") ||
    normalized.endsWith("_passwd") ||
    normalized.endsWith("_secret") ||
    normalized.endsWith("_secrets") ||
    normalized.endsWith("_secret_key") ||
    normalized.endsWith("_access_key") ||
    normalized.endsWith("_access_key_id") ||
    normalized.endsWith("_private_key") ||
    normalized.endsWith("_credential") ||
    normalized.endsWith("_credentials") ||
    normalized.endsWith("_authorization") ||
    normalized.endsWith("_cookie") ||
    normalized.endsWith("_cookies")
  );
}

interface AssignmentStart {
  key: string;
  separatorIndex: number;
}

function isKeyCharacter(character: string | undefined): boolean {
  return character !== undefined && /[A-Za-z0-9_.-]/.test(character);
}

function readAssignmentStart(
  text: string,
  startIndex: number,
): AssignmentStart | null {
  if (isKeyCharacter(text[startIndex - 1])) return null;

  let cursor = startIndex;
  let key = "";
  const quote = text[cursor] === '"' || text[cursor] === "'" ? text[cursor] : null;

  if (quote) {
    const keyStart = ++cursor;
    while (isKeyCharacter(text[cursor])) cursor += 1;
    if (cursor === keyStart || text[cursor] !== quote) return null;
    key = text.slice(keyStart, cursor);
    cursor += 1;
  } else {
    if (!/[A-Za-z]/.test(text[cursor] ?? "")) return null;
    const keyStart = cursor;
    while (isKeyCharacter(text[cursor])) cursor += 1;
    key = text.slice(keyStart, cursor);
  }

  while (text[cursor] === " " || text[cursor] === "\t") cursor += 1;
  if (text[cursor] !== ":" && text[cursor] !== "=") return null;
  return { key, separatorIndex: cursor };
}

function readQuotedValueEnd(text: string, startIndex: number): number {
  const quote = text[startIndex];
  let cursor = startIndex + 1;
  while (cursor < text.length) {
    if (text[cursor] === "\\") {
      cursor += 2;
      continue;
    }
    if (text[cursor] === quote) return cursor + 1;
    if (text[cursor] === "\r" || text[cursor] === "\n") return cursor;
    cursor += 1;
  }
  return cursor;
}

function readBalancedValueEnd(text: string, startIndex: number): number {
  const stack: string[] = [text[startIndex] === "[" ? "]" : "}"];
  let quote: string | null = null;
  let cursor = startIndex + 1;

  while (cursor < text.length) {
    const character = text[cursor];
    if (quote) {
      if (character === "\\") {
        cursor += 2;
        continue;
      }
      if (character === quote) quote = null;
      cursor += 1;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
    } else if (character === "[") {
      stack.push("]");
    } else if (character === "{") {
      stack.push("}");
    } else if (character === stack.at(-1)) {
      stack.pop();
      if (stack.length === 0) return cursor + 1;
    } else if (character === "\r" || character === "\n") {
      return cursor;
    }
    cursor += 1;
  }
  return cursor;
}

function readUnquotedValueEnd(text: string, startIndex: number): number {
  let cursor = startIndex;
  while (cursor < text.length) {
    const character = text[cursor];
    if (",;}\]\r\n".includes(character ?? "")) return cursor;
    if (character === " " || character === "\t") return cursor;
    cursor += 1;
  }
  return cursor;
}

function readAssignmentValueEnd(text: string, startIndex: number): number {
  if (text[startIndex] === '"' || text[startIndex] === "'") {
    return readQuotedValueEnd(text, startIndex);
  }
  if (text[startIndex] === "[" || text[startIndex] === "{") {
    return readBalancedValueEnd(text, startIndex);
  }
  return readUnquotedValueEnd(text, startIndex);
}

function redactSensitiveAssignments(text: string): string {
  const output: string[] = [];
  let retainedFrom = 0;
  let cursor = 0;

  while (cursor < text.length) {
    const assignment = readAssignmentStart(text, cursor);
    if (!assignment || !isSensitiveKey(assignment.key)) {
      cursor += 1;
      continue;
    }

    let valueStart = assignment.separatorIndex + 1;
    while (text[valueStart] === " " || text[valueStart] === "\t") {
      valueStart += 1;
    }
    const valueEnd = readAssignmentValueEnd(text, valueStart);
    output.push(text.slice(retainedFrom, valueStart), REDACTED);
    retainedFrom = valueEnd;
    cursor = Math.max(valueEnd, cursor + 1);
  }

  output.push(text.slice(retainedFrom));
  return output.join("");
}

function redactSensitiveValues(
  text: string,
  sensitiveValues: readonly string[],
): string {
  const uniqueValues = [...new Set(sensitiveValues)]
    .filter((value) => value.length > 0 && value !== REDACTED)
    .sort((left, right) => right.length - left.length);

  if (uniqueValues.length === 0) return text;

  // Process each original segment once so a shorter configured value cannot
  // redact text inside a marker emitted for a longer value. Existing markers
  // are kept opaque for the same reason.
  return text
    .split(REDACTED)
    .map((segment) => {
      const output: string[] = [];
      let cursor = 0;

      while (cursor < segment.length) {
        let matchIndex = -1;
        let matchValue = "";

        for (const value of uniqueValues) {
          const candidateIndex = segment.indexOf(value, cursor);
          if (
            candidateIndex !== -1 &&
            (matchIndex === -1 ||
              candidateIndex < matchIndex ||
              (candidateIndex === matchIndex && value.length > matchValue.length))
          ) {
            matchIndex = candidateIndex;
            matchValue = value;
          }
        }

        if (matchIndex === -1) break;
        output.push(segment.slice(cursor, matchIndex), REDACTED);
        cursor = matchIndex + matchValue.length;
      }

      output.push(segment.slice(cursor));
      return output.join("");
    })
    .join(REDACTED);
}

export function sanitizeText(
  text: string,
  sensitiveValues: readonly string[] = [],
): string {
  return redactSensitiveAssignments(redactSensitiveValues(text, sensitiveValues))
    .replace(
      /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi,
      `Bearer ${REDACTED}`,
    )
    .replace(
      QUOTED_PREDICATE_PATTERN,
      (match, key: string, verb: string, value: string) => {
        if (!isSensitiveKey(key)) return match;
        const unquoted = value.replace(/^(?:"([\s\S]*)"|'([\s\S]*)')$/, "$1$2");
        if (NON_SECRET_STATUS_VALUES.has(unquoted.toLowerCase())) return match;
        return `${key} ${verb} ${REDACTED}`;
      },
    )
    .replace(
      /\b(Authorization|Cookie|Set-Cookie)\s*[:=]\s*[^\r\n]+/gi,
      (_match, key: string) => `${key}=${REDACTED}`,
    );
}

function sanitizeValue(
  value: unknown,
  sensitiveValues: readonly string[],
  ancestors: WeakSet<object>,
): unknown {
  if (typeof value === "string") return sanitizeText(value, sensitiveValues);

  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "bigint") return value.toString();
  if (
    value === undefined ||
    typeof value === "function" ||
    typeof value === "symbol"
  ) {
    return null;
  }

  if (Array.isArray(value)) {
    if (ancestors.has(value)) return CIRCULAR;
    ancestors.add(value);
    const sanitized = value.map((item) =>
      sanitizeValue(item, sensitiveValues, ancestors),
    );
    ancestors.delete(value);
    return sanitized;
  }

  if (value === null || typeof value !== "object") return value;

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }
  if (value instanceof URL) return value.toString();
  if (value instanceof Set) {
    if (ancestors.has(value)) return CIRCULAR;
    ancestors.add(value);
    const sanitized = [...value].map((item) =>
      sanitizeValue(item, sensitiveValues, ancestors),
    );
    ancestors.delete(value);
    return sanitized;
  }
  if (value instanceof Map) {
    if (ancestors.has(value)) return CIRCULAR;
    ancestors.add(value);
    const sanitized: Record<string, unknown> = {};
    for (const [key, item] of value) {
      const normalizedKey = String(key);
      Object.defineProperty(sanitized, normalizedKey, {
        value: isSensitiveKey(normalizedKey)
          ? REDACTED
          : sanitizeValue(item, sensitiveValues, ancestors),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    ancestors.delete(value);
    return sanitized;
  }

  if (ancestors.has(value)) return CIRCULAR;
  ancestors.add(value);

  const result: Record<string, unknown> = {};

  for (const [key, item] of Object.entries(value)) {
    Object.defineProperty(result, key, {
      value: isSensitiveKey(key)
        ? REDACTED
        : sanitizeValue(item, sensitiveValues, ancestors),
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }

  ancestors.delete(value);
  return result;
}

export function sanitizeMetadata(
  metadata: Record<string, unknown>,
  sensitiveValues: readonly string[] = [],
): Record<string, unknown> {
  return sanitizeValue(
    metadata,
    sensitiveValues,
    new WeakSet<object>(),
  ) as Record<string, unknown>;
}
