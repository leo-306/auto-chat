import { describe, expect, it } from "vitest";
import { ConfigSchema, DEFAULT_CONFIG } from "../src/index.js";

describe("ConfigSchema", () => {
  it("defaults autoRetry to false and allows maxRetries to be omitted", () => {
    const parsed = ConfigSchema.parse({});
    expect(parsed.autoRetry).toBe(false);
    expect(parsed.maxRetries).toBeUndefined();
  });

  it("requires maxRetries when autoRetry is enabled", () => {
    expect(() => ConfigSchema.parse({ autoRetry: true })).toThrow();
  });

  it("accepts autoRetry with a valid maxRetries", () => {
    const parsed = ConfigSchema.parse({ autoRetry: true, maxRetries: 2 });
    expect(parsed.autoRetry).toBe(true);
    expect(parsed.maxRetries).toBe(2);
  });

  it("rejects maxRetries outside 1-10", () => {
    expect(() => ConfigSchema.parse({ autoRetry: true, maxRetries: 0 })).toThrow();
    expect(() => ConfigSchema.parse({ autoRetry: true, maxRetries: 11 })).toThrow();
  });

  it("keeps DEFAULT_CONFIG.autoRetry false", () => {
    expect(DEFAULT_CONFIG.autoRetry).toBe(false);
  });
});
