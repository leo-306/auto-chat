export function findGeminiSendControl(root: ParentNode = document): HTMLElement | null {
  return root.querySelector<HTMLElement>("gem-icon-button.send-button:not([aria-disabled='true'])") ??
    root.querySelector<HTMLElement>("div[data-test-id='send-button-container']:not(.disabled) gem-icon-button.send-button") ??
    root.querySelector<HTMLElement>("gem-icon-button.send-button") ??
    root.querySelector<HTMLElement>("div[data-test-id='send-button-container']");
}

export function isGeminiSendDisabled(control: HTMLElement): boolean {
  return control.classList.contains("disabled") ||
    control.getAttribute("aria-disabled") === "true" ||
    Boolean(control.querySelector('[aria-disabled="true"], [disabled]'));
}
