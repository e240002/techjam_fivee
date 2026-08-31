import { describe, expect, it } from "vitest";
import {
  CIRCULAR,
  REDACTED,
  sanitizeMetadata,
  sanitizeText,
} from "./redaction.js";

describe("sanitizeMetadata", () => {
  it("redacts API keys", () => {
    expect(
      sanitizeMetadata({
        ARK_API_KEY: "secret123",
        model: "example",
      }),
    ).toEqual({
      ARK_API_KEY: REDACTED,
      model: "example",
    });
  });

  it("redacts nested secrets", () => {
    expect(
      sanitizeMetadata({
        env: {
          apiKey: "secret",
          NODE_ENV: "test",
        },
      }),
    ).toEqual({
      env: {
        apiKey: REDACTED,
        NODE_ENV: "test",
      },
    });
  });

  it("redacts secrets inside arrays", () => {
    expect(
      sanitizeMetadata({
        providers: [
          { name: "ark", password: "secret" },
          { name: "safe" },
        ],
      }),
    ).toEqual({
      providers: [
        { name: "ark", password: REDACTED },
        { name: "safe" },
      ],
    });
  });

  it("preserves safe token telemetry", () => {
    expect(
      sanitizeMetadata({
        inputTokens: 100,
        cachedInputTokens: 20,
        outputTokens: 50,
      }),
    ).toEqual({
      inputTokens: 100,
      cachedInputTokens: 20,
      outputTokens: 50,
    });
  });

  it("redacts prompt and output", () => {
    expect(
      sanitizeMetadata({
        prompt: "private prompt",
        output: "private response",
        inputTokens: 100,
      }),
    ).toEqual({
      prompt: REDACTED,
      output: REDACTED,
      inputTokens: 100,
    });
  });

  it("does not mutate the original object", () => {
    const original = {
      env: { ARK_API_KEY: "secret" },
    };

    const sanitized = sanitizeMetadata(original);

    expect(original.env.ARK_API_KEY).toBe("secret");
    expect(sanitized).toEqual({
      env: { ARK_API_KEY: REDACTED },
    });
  });

  it("redacts exact configured values in otherwise safe metadata", () => {
    expect(
      sanitizeMetadata(
        { detail: "Invalid API key: ark-secret-value" },
        ["ark-secret-value"],
      ),
    ).toEqual({ detail: `Invalid API key: ${REDACTED}` });
  });

  it("redacts generic token fields", () => {
    expect(
      sanitizeMetadata({
        githubToken: "secret-one",
        serviceToken: "secret-two",
        idToken: "secret-three",
      }),
    ).toEqual({
      githubToken: REDACTED,
      serviceToken: REDACTED,
      idToken: REDACTED,
    });
  });

  it("redacts cloud credential fields", () => {
    expect(
      sanitizeMetadata({
        secretKey: "secret-one",
        accessKey: "secret-two",
        accessKeyId: "secret-three",
      }),
    ).toEqual({
      secretKey: REDACTED,
      accessKey: REDACTED,
      accessKeyId: REDACTED,
    });
  });

  it("redacts exact and suffixed secret, credential, and cookie fields", () => {
    expect(
      sanitizeMetadata({
        secret: "secret-one",
        credential: "secret-two",
        sessionCookie: "secret-three",
        nested: {
          deploymentSecrets: ["secret-four"],
        },
      }),
    ).toEqual({
      secret: REDACTED,
      credential: REDACTED,
      sessionCookie: REDACTED,
      nested: {
        deploymentSecrets: REDACTED,
      },
    });
  });
});

describe("sanitizeText", () => {
  it("redacts bearer tokens", () => {
    expect(
      sanitizeText("Authorization failed: Bearer abc123.xyz"),
    ).toBe("Authorization failed: Bearer [REDACTED]");
  });

  it("redacts exact configured values without rescanning markers", () => {
    expect(
      sanitizeText(
        "Invalid API key: ark-secret-value; repeated ark-secret-value",
        ["ark-secret-value", "RED"],
      ),
    ).toBe(`Invalid API key: ${REDACTED}; repeated ${REDACTED}`);
    expect(sanitizeText(REDACTED, ["RED"])).toBe(REDACTED);
  });

  it("redacts environment-style API keys", () => {
    expect(
      sanitizeText("ARK_API_KEY=mysecret"),
    ).toBe("ARK_API_KEY=[REDACTED]");
  });

  it("keeps normal error messages unchanged", () => {
    expect(
      sanitizeText("Execution failed after 2 retries"),
    ).toBe("Execution failed after 2 retries");
  });

  it("redacts Authorization credentials", () => {
    expect(
      sanitizeText("Authorization: Basic abc123"),
    ).toBe("Authorization=[REDACTED]");
  });

  it("redacts AK and SK credentials in text", () => {
    expect(
      sanitizeText("AK=my-access-key SK=my-secret-key"),
    ).toBe("AK=[REDACTED] SK=[REDACTED]");
  });

  it("redacts credentials inside JSON-like text", () => {
    const result = sanitizeText(
      'request failed: {"API_KEY":"my-super-secret"}',
    );

    expect(result).not.toContain("my-super-secret");
    expect(result).toContain(REDACTED);
  });

  it("redacts access tokens inside JSON-like text", () => {
    const result = sanitizeText(
      '{"ACCESS_TOKEN":"private-token-value"}',
    );

    expect(result).not.toContain("private-token-value");
  });

  it("redacts generic token and secret assignments in free text", () => {
    const result = sanitizeText(
      'token="private token", githubToken=github-private, secret is "phrase secret"',
    );

    expect(result).not.toContain("private token");
    expect(result).not.toContain("github-private");
    expect(result).not.toContain("phrase secret");
    expect(result.match(/\[REDACTED\]/g)).toHaveLength(3);
  });

  it("redacts plural sensitive assignments", () => {
    const result = sanitizeText(
      "tokens=alpha deploymentSecrets=beta cookies=gamma",
    );

    expect(result).toBe(
      `tokens=${REDACTED} deploymentSecrets=${REDACTED} cookies=${REDACTED}`,
    );
  });

  it("redacts complete sensitive array and object values", () => {
    const result = sanitizeText(
      'tokens=["alpha","beta"] secret={value:"gamma",nested:{token:"delta"}}',
    );

    expect(result).toBe(`tokens=${REDACTED} secret=${REDACTED}`);
  });

  it("preserves diagnostics after an unquoted secret assignment", () => {
    expect(sanitizeText("token=abc request failed after 3 retries")).toBe(
      `token=${REDACTED} request failed after 3 retries`,
    );
  });

  it("redacts sensitive suffixes on long keys", () => {
    const longKey = `${"a".repeat(256)}Token`;
    expect(sanitizeText(`${longKey}=private`)).toBe(
      `${longKey}=${REDACTED}`,
    );
  });

  it("redacts generic token fields inside JSON-like text", () => {
    const result = sanitizeText(
      'request failed: {"token":"json-private","serviceToken":"service-private"}',
    );

    expect(result).not.toContain("json-private");
    expect(result).not.toContain("service-private");
  });

  it("redacts complete Cookie and Set-Cookie header values", () => {
    const result = sanitizeText(
      "Cookie: session=private-cookie; theme=dark\nSet-Cookie: refresh=private-refresh; HttpOnly",
    );

    expect(result).toBe(
      `Cookie=${REDACTED}\nSet-Cookie=${REDACTED}`,
    );
  });

  it("does not redact normal prose about token accounting", () => {
    expect(
      sanitizeText("Execution failed after the token budget was exceeded"),
    ).toBe("Execution failed after the token budget was exceeded");
    expect(sanitizeText("This token is expired")).toBe("This token is expired");
    expect(sanitizeText("token is abc123.xyz")).toBe(
      `token is ${REDACTED}`,
    );
    expect(sanitizeText('secrets are "alpha beta"')).toBe(
      `secrets are ${REDACTED}`,
    );
  });

  it("is idempotent for already-redacted values", () => {
    const sanitized = [
      `token=${REDACTED}`,
      `Authorization=${REDACTED}`,
      `Cookie=${REDACTED}`,
    ].join("\n");

    expect(sanitizeText(sanitized)).toBe(sanitized);
  });

  it("handles long non-sensitive text without pathological backtracking", () => {
    const input = "a".repeat(100_000);
    const startedAt = performance.now();

    expect(sanitizeText(input)).toBe(input);
    expect(performance.now() - startedAt).toBeLessThan(1_000);
  });

  it("normalizes cyclic and non-JSON metadata safely", () => {
    const cyclic: Record<string, unknown> = {
      finite: 1,
      notFinite: Number.POSITIVE_INFINITY,
      missing: undefined,
      bigint: 12n,
      createdAt: new Date("2026-08-31T00:00:00.000Z"),
    };
    cyclic.self = cyclic;

    expect(sanitizeMetadata(cyclic)).toEqual({
      finite: 1,
      notFinite: null,
      missing: null,
      bigint: "12",
      createdAt: "2026-08-31T00:00:00.000Z",
      self: CIRCULAR,
    });
  });
});
