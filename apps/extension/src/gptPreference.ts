export type GptImagePreferenceComparison = {
  container: HTMLElement;
  choices: HTMLElement[];
};

const GPT_IMAGE_PREFERENCE_TEST_ID = "image-paragen-multigen";
const GPT_GENERATED_IMAGE_CARD_SELECTOR = "[id^='image-']";

export function findGptImagePreferenceComparisons(root: ParentNode): GptImagePreferenceComparison[] {
  return [...root.querySelectorAll<HTMLElement>(`[data-testid='${GPT_IMAGE_PREFERENCE_TEST_ID}']`)]
    .map(container => ({
      container,
      choices: findStructurallyAssociatedChoiceButtons(container)
    }))
    .filter(comparison => comparison.choices.length > 0);
}

export function answerGptImagePreferenceComparisons(
  root: ParentNode,
  answeredComparisons: WeakSet<HTMLElement>
): boolean {
  let answered = false;
  for (const comparison of findGptImagePreferenceComparisons(root)) {
    if (answeredComparisons.has(comparison.container)) continue;

    // Pick the first candidate deterministically. This keeps the selected
    // asset aligned with DOM-order image collection if the experiment UI
    // remains mounted briefly after the click.
    answeredComparisons.add(comparison.container);
    comparison.choices[0]?.click();
    answered = true;
  }
  return answered;
}

function findStructurallyAssociatedChoiceButtons(container: HTMLElement): HTMLElement[] {
  const choices: HTMLElement[] = [];
  const seen = new Set<HTMLElement>();

  for (const card of container.querySelectorAll<HTMLElement>(GPT_GENERATED_IMAGE_CARD_SELECTOR)) {
    const choice = findSiblingChoiceButton(card, container);
    if (!choice || seen.has(choice)) continue;
    seen.add(choice);
    choices.push(choice);
  }
  return choices;
}

function findSiblingChoiceButton(card: HTMLElement, container: HTMLElement): HTMLElement | null {
  for (let ancestor = card.parentElement; ancestor && ancestor !== container; ancestor = ancestor.parentElement) {
    const directButton = [...ancestor.children]
      .find((child): child is HTMLElement => child.tagName === "BUTTON");
    if (directButton) return directButton;
  }
  return null;
}
