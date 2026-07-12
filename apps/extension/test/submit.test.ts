import { describe, expect, it } from "vitest";
import { submitPromptWithFallback } from "../src/submit.js";

describe("prompt submission", () => {
  it("waits until the send button is enabled before submitting", async () => {
    const reports: string[] = [];
    let polls = 0;
    let clickCount = 0;

    const sendButton = {
      disabled: true,
      click() {
        clickCount += 1;
      },
      getAttribute() {
        return null;
      },
      closest() {
        return null;
      }
    } as unknown as HTMLButtonElement;
    const composer = {
      dispatchEvent() {
        return true;
      },
      closest() {
        return null;
      }
    } as unknown as HTMLElement;

    await submitPromptWithFallback({
      composer,
      sendButton,
      isSubmitted: async () => clickCount > 0,
      onWaitingForSubmitReady: async () => {
        reports.push("waiting_upload_ready");
      },
      sleep: async () => {
        polls += 1;
        if (polls === 2) sendButton.disabled = false;
      }
    });

    expect(reports).toEqual(["waiting_upload_ready"]);
    expect(clickCount).toBe(1);
  });

  it("does not throw when the ready button is not owned by the fallback form", async () => {
    let submitted = false;
    let requestSubmitSubmitter: HTMLElement | null | undefined = undefined;

    const form = {
      contains() {
        return false;
      },
      requestSubmit(submitter?: HTMLElement | null) {
        requestSubmitSubmitter = submitter;
        submitted = true;
      }
    } as unknown as HTMLFormElement;
    const sendButton = {
      disabled: false,
      click() {},
      getAttribute() {
        return null;
      },
      closest() {
        return form;
      }
    } as unknown as HTMLButtonElement;
    const composer = {
      dispatchEvent() {
        return true;
      },
      closest() {
        return form;
      }
    } as unknown as HTMLElement;

    const result = await submitPromptWithFallback({
      composer,
      sendButton,
      isSubmitted: async () => submitted,
      sleep: async () => {}
    });

    expect(result).toBe(true);
    expect(requestSubmitSubmitter).toBeUndefined();
  });
});
