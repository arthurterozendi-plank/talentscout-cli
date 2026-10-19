import { describe, expect, it } from "vitest";
import {
  buildConfig,
  checkTemperatureSupport,
  DEFAULT_MAX_RETRIES,
  describeConfig,
  MAX_TOKENS,
} from "./config.js";
import { findModel } from "./models.js";

function rejection(flags: Parameters<typeof buildConfig>[0]): string {
  const result = buildConfig(flags);
  if (result.ok) {
    throw new Error(`expected ${JSON.stringify(flags)} to be rejected`);
  }
  return result.error;
}

describe("buildConfig", () => {
  it("accepts a known model with a temperature it supports", () => {
    const result = buildConfig({ model: "claude-haiku-4-5", temperature: "0" });

    expect(result).toEqual({
      ok: true,
      config: {
        model: findModel("claude-haiku-4-5"),
        temperature: 0,
        system: undefined,
        maxTokens: MAX_TOKENS,
        maxRetries: DEFAULT_MAX_RETRIES,
      },
    });
  });

  it("leaves the temperature unset when the flag is absent", () => {
    const result = buildConfig({ model: "claude-opus-5-5" });

    expect(result.ok && result.config.temperature).toBeUndefined();
  });

  it("uses claude-sonnet-5-5 when --model is omitted", () => {
    const result = buildConfig({});

    expect(result.ok && result.config.model.id).toBe("claude-sonnet-5-5");
  });

  it("resolves an alias to its model", () => {
    const result = buildConfig({ model: "haiku" });

    expect(result.ok && result.config.model.id).toBe("claude-haiku-5-5");
  });

  it.each(["claude-haiku-4.5", "Claude-Haiku-4-5", "gpt-4o", ""])(
    "rejects the unknown model %j and lists the known IDs and aliases",
    (model) => {
      const error = rejection({ model });

      expect(error).toContain(`"${model}"`);
      expect(error).toContain("claude-haiku-4-5");
      expect(error).toContain("claude-opus-5-5");
      expect(error).toContain("an alias (opus, sonnet, haiku)");
    },
  );

  it.each(["0", "0.7", "1"])("accepts the in-range temperature %s", (temperature) => {
    expect(buildConfig({ model: "claude-sonnet-4-6", temperature }).ok).toBe(true);
  });

  it.each(["-0.1", "1.01", "2", "abc", "", " ", "NaN", "Infinity"])(
    "rejects the temperature %j",
    (temperature) => {
      expect(rejection({ model: "claude-sonnet-4-6", temperature })).toContain(
        "--temperature must be a number from 0 to 1",
      );
    },
  );

  it("rejects any temperature for a model that does not accept one, naming those that do", () => {
    const error = rejection({ model: "haiku", temperature: "0" });

    expect(error).toContain("claude-haiku-5-5 does not accept --temperature");
    expect(error).toContain(
      "pass --model with one of: claude-opus-4-6, claude-sonnet-4-6, claude-haiku-4-5.",
    );
  });

  it("rejects a temperature for the default model, which does not accept one", () => {
    expect(rejection({ temperature: "0.7" })).toContain(
      "claude-sonnet-5-5 does not accept --temperature",
    );
  });

  it.each(["0", "10"])("accepts --max-retries %s", (maxRetries) => {
    const result = buildConfig({ model: "claude-opus-5-5", maxRetries });

    expect(result.ok && result.config.maxRetries).toBe(Number(maxRetries));
  });

  it.each(["11", "-1", "1.5", "abc", ""])("rejects --max-retries %j", (maxRetries) => {
    expect(rejection({ model: "claude-opus-5-5", maxRetries })).toContain("--max-retries");
  });
});

describe("checkTemperatureSupport", () => {
  const pricing = { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 };
  const accepting = { id: "claude-sonnet-4-6", acceptsTemperature: true, pricing };
  const rejecting = { id: "claude-sonnet-5-5", acceptsTemperature: false, pricing };

  it("allows any model when no temperature is set", () => {
    expect(checkTemperatureSupport(rejecting, undefined)).toBeUndefined();
  });

  it("allows a temperature for a model that accepts one", () => {
    expect(checkTemperatureSupport(accepting, 0)).toBeUndefined();
  });

  it("explains why a model that accepts no temperature cannot take one", () => {
    expect(checkTemperatureSupport(rejecting, 1)).toContain(
      "claude-sonnet-5-5 does not accept --temperature: models released after Claude Opus 4.6",
    );
  });
});

describe("describeConfig", () => {
  it("names every value the request is sent with", () => {
    const result = buildConfig({ model: "claude-haiku-4-5", temperature: "0", maxRetries: "2" });
    if (!result.ok) throw new Error(result.error);

    expect(describeConfig(result.config)).toBe(
      "model=claude-haiku-4-5 temperature=0 max_tokens=32000 max_retries=2",
    );
  });

  it("says when the model's default temperature is in use", () => {
    const result = buildConfig({ model: "claude-opus-5-5" });
    if (!result.ok) throw new Error(result.error);

    expect(describeConfig(result.config)).toContain("temperature=default");
  });
});
