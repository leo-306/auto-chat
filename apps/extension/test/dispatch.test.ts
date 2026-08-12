import { describe, expect, it } from "vitest";
import { isDispatchPending, shouldAcknowledgeDispatch } from "../src/dispatch.js";

describe("dispatch acknowledgement", () => {
  it("ignores only the exact dispatch that was already acknowledged", () => {
    expect(isDispatchPending({ id: 1503, platform: "gpt", jobId: "job", requestedAt: null }, 1503)).toBe(false);
    expect(isDispatchPending({ id: 1504, platform: "gpt", jobId: "job", requestedAt: null }, 1503)).toBe(true);
  });

  it("treats a lower id as new after the server data is restored", () => {
    expect(isDispatchPending({ id: 1, platform: "gpt", jobId: "job", requestedAt: null }, 1503)).toBe(true);
  });

  it("does not treat the server's initial empty dispatch as work", () => {
    expect(isDispatchPending({ id: 0, platform: null, jobId: null, requestedAt: null }, -1)).toBe(false);
  });

  it("keeps a dispatch pending while its platform is at maximum concurrency", () => {
    expect(shouldAcknowledgeDispatch(true)).toBe(false);
  });

  it("acknowledges after the dispatcher had a chance to claim or recheck", () => {
    expect(shouldAcknowledgeDispatch(false)).toBe(true);
  });
});
