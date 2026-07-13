import { describe, expect, it } from "vitest";
import { waitForStableReadiness } from "../src/readiness.js";

describe("conversation page readiness", () => {
  it("continues early after readiness remains stable", async () => {
    let now = 0;
    let inspections = 0;

    const result = await waitForStableReadiness({
      inspect: () => {
        inspections += 1;
        return inspections >= 3;
      },
      sleep: async ms => {
        now += ms;
      },
      now: () => now
    });

    expect(result).toBe("ready");
    expect(inspections).toBe(5);
    expect(now).toBe(2_000);
  });

  it("resets the stability window when readiness disappears", async () => {
    let now = 0;
    const states = [true, true, false, true, true, true];

    const result = await waitForStableReadiness({
      inspect: () => states.shift() ?? true,
      sleep: async ms => {
        now += ms;
      },
      now: () => now
    });

    expect(result).toBe("ready");
    expect(now).toBe(2_500);
  });

  it("uses a ten second fallback when readiness cannot be confirmed", async () => {
    let now = 0;
    let inspections = 0;

    const result = await waitForStableReadiness({
      inspect: () => {
        inspections += 1;
        return false;
      },
      sleep: async ms => {
        now += ms;
      },
      now: () => now
    });

    expect(result).toBe("timeout");
    expect(now).toBe(10_000);
    expect(inspections).toBe(20);
  });
});
