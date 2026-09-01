import { sanitizeText } from "./tracing/redaction.js";

interface RuntimeErrorOptions {
  arkModel: string;
  sensitiveValues: readonly string[];
}

const ARK_CREDENTIAL_ERROR =
  /(?:invalid|incorrect|expired|revoked)\s+(?:api[\s_-]*key|credentials?)|\b(?:unauthorized|authentication\s+failed)\b|\b401\b/i;

/**
 * Turn provider/runtime failures into safe operator guidance. Every fallback
 * passes through the shared redactor before it can be persisted or returned.
 */
export function formatRuntimeError(
  error: unknown,
  options: RuntimeErrorOptions,
): string {
  const rawMessage = error instanceof Error ? error.message : String(error);
  const sanitizedMessage = sanitizeText(rawMessage, options.sensitiveValues);

  if (ARK_CREDENTIAL_ERROR.test(rawMessage)) {
    return (
      "Ark rejected the credentials. Verify ARK_API_KEY and confirm that it can " +
      "access the configured ARK_MODEL, then restart RunProof."
    );
  }

  return sanitizedMessage;
}
