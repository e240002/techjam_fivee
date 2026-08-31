import { describe, expect, it } from "vitest";
import { REDACTED, sanitizeMetadata, sanitizeText } from "./redaction.js";

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
  });
});
