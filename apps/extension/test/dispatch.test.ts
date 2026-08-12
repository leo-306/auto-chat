import { describe, expect, it } from "vitest";
import { isDispatchPending, shouldAcknowledgeDispatch } from "../src/dispatch.js";

describe("dispatch acknowledgement", () => {
  it("ignores only the exact dispatch that was already acknowledged", () => {
    expect(isDispatchPending({ id: 1503, token: "dispatch-a", platform: "gpt", jobId: "job", requestedAt: null }, { id: 1503, token: "dispatch-a" })).toBe(false);
    expect(isDispatchPending({ id: 1504, token: "dispatch-b", platform: "gpt", jobId: "job", requestedAt: null }, { id: 1503, token: "dispatch-a" })).toBe(true);
  });

  it("treats a reused id with a new token as new after the server data is restored", () => {
    expect(isDispatchPending({ id: 1503, token: "restored-dispatch", platform: "gpt", jobId: "job", requestedAt: null }, { id: 1503, token: "previous-dispatch" })).toBe(true);
  });

  it("does not treat the server's initial empty dispatch as work", () => {
    expect(isDispatchPending({ id: 0, token: null, platform: null, jobId: null, requestedAt: null }, { id: -1, token: null })).toBe(false);
  });

  it("uses the id as a fallback for dispatches persisted by older servers", () => {
    expect(isDispatchPending({ id: 1503, token: null, platform: "gpt", jobId: "job", requestedAt: null }, { id: 1503, token: null })).toBe(false);
  });

  it("keeps a dispatch pending while its platform is at maximum concurrency", () => {
    expect(shouldAcknowledgeDispatch(true)).toBe(false);
  });

  it("acknowledges after the dispatcher had a chance to claim or recheck", () => {
    expect(shouldAcknowledgeDispatch(false)).toBe(true);
  });
});
