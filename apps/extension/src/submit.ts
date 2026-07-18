export type SubmissionOptions = {
  composer: HTMLElement;
  sendButton: HTMLButtonElement | null;
  getSendButton?: () => HTMLButtonElement | null;
  isSubmitted: () => Promise<boolean>;
  onWaitingForSubmitReady?: () => Promise<void>;
  sleep: (ms: number) => Promise<void>;
};

const READY_POLL_INTERVAL_MS = 500;
const READY_POLL_ATTEMPTS = 120;

export async function submitPromptWithFallback(options: SubmissionOptions): Promise<boolean> {
  const { composer, sendButton, isSubmitted, sleep } = options;
  const readyButton = sendButton ? await waitForSendButtonReady(sendButton, options) : null;

  if (readyButton) {
    readyButton.click();
    if (await waitForSubmitted(isSubmitted, sleep, 4, 250)) return true;

    if (await retryRequestSubmit(readyButton, options)) {
      if (await waitForSubmitted(isSubmitted, sleep, 4, 250)) return true;
    }
  }

  composer.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true }));
  await sleep(100);
  return waitForSubmitted(isSubmitted, sleep, 20, 500);
}

async function waitForSendButtonReady(
  sendButton: HTMLButtonElement,
  options: SubmissionOptions
): Promise<HTMLButtonElement | null> {
  let current = options.getSendButton?.() ?? sendButton;
  if (!isDisabled(current)) return current;

  await options.onWaitingForSubmitReady?.();
  for (let attempt = 0; attempt < READY_POLL_ATTEMPTS; attempt += 1) {
    await options.sleep(READY_POLL_INTERVAL_MS);
    current = options.getSendButton?.() ?? current;
    if (!isDisabled(current)) return current;
  }

  return null;
}

async function waitForSubmitted(
  isSubmitted: () => Promise<boolean>,
  sleep: (ms: number) => Promise<void>,
  attempts: number,
  delayMs: number
): Promise<boolean> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await isSubmitted()) return true;
    await sleep(delayMs);
  }
  return false;
}

function isDisabled(button: HTMLButtonElement): boolean {
  return button.disabled || button.getAttribute("aria-disabled") === "true";
}

const FORM_LOOKUP_RETRY_ATTEMPTS = 3;
const FORM_LOOKUP_RETRY_DELAY_MS = 150;

// ChatGPT re-renders the composer between the click and this fallback, which can detach the
// form we already resolved (form.isConnected === false) and make requestSubmit throw. Re-resolve
// the button/form pair from the DOM each attempt instead of reusing the stale reference.
async function retryRequestSubmit(
  initialButton: HTMLButtonElement,
  options: SubmissionOptions
): Promise<boolean> {
  const { composer, getSendButton, sleep } = options;
  let button = initialButton;

  for (let attempt = 0; attempt < FORM_LOOKUP_RETRY_ATTEMPTS; attempt += 1) {
    if (attempt > 0) {
      await sleep(FORM_LOOKUP_RETRY_DELAY_MS);
      button = getSendButton?.() ?? button;
    }

    const form = button.closest("form") ?? composer.closest("form");
    if (form?.isConnected && safeRequestSubmit(form, button)) return true;
  }

  return false;
}

function safeRequestSubmit(form: HTMLFormElement, submitter: HTMLButtonElement): boolean {
  try {
    if (form.contains(submitter)) {
      form.requestSubmit(submitter);
      return true;
    }
    form.requestSubmit();
    return true;
  } catch {
    // Form was detached mid-call, or the button isn't owned by this form. Let the caller retry
    // with a freshly resolved reference, or fall through to the keyboard-submit fallback.
    return false;
  }
}
