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
}
);