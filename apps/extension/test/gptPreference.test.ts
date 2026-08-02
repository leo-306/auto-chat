import { describe, expect, it, vi } from "vitest";
import {
  answerGptImagePreferenceComparisons,
  findGptImagePreferenceComparisons
} from "../src/gptPreference.js";

function button(label: string): HTMLElement {
  return {
    tagName: "BUTTON",
    innerText: label,
    textContent: label,
    click: vi.fn()
  } as unknown as HTMLElement;
}

describe("GPT image preference comparison", () => {
  it("uses component attributes and structure instead of localized button copy", () => {
    const first = button("任意语言候选一");
    const second = button("任意语言候选二");
    const skip = button("任意语言跳过");
    const firstWrapper = { children: [] } as unknown as HTMLElement;
    const secondWrapper = { children: [] } as unknown as HTMLElement;
    const firstColumn = { children: [firstWrapper, first] } as unknown as HTMLElement;
    const secondColumn = { children: [secondWrapper, second] } as unknown as HTMLElement;
    const firstCard = { parentElement: firstWrapper } as unknown as HTMLElement;
    const secondCard = { parentElement: secondWrapper } as unknown as HTMLElement;
    Object.assign(firstWrapper, { parentElement: firstColumn });
    Object.assign(secondWrapper, { parentElement: secondColumn });
    const comparison = {
      querySelectorAll(selector: string) {
        return selector === "[id^='image-']" ? [firstCard, secondCard] : [];
      },
      children: [skip]
    } as unknown as HTMLElement;
    Object.assign(firstColumn, { parentElement: comparison });
    Object.assign(secondColumn, { parentElement: comparison });
    const root = {
      querySelectorAll(selector: string) {
        return selector.includes("image-paragen-multigen") ? [comparison] : [];
      }
    } as unknown as ParentNode;

    expect(findGptImagePreferenceComparisons(root)).toEqual([
      { container: comparison, choices: [first, second] }
    ]);

    const answered = new WeakSet<HTMLElement>();
    expect(answerGptImagePreferenceComparisons(root, answered)).toBe(true);
    expect(first.click).toHaveBeenCalledOnce();
    expect(second.click).not.toHaveBeenCalled();
    expect(skip.click).not.toHaveBeenCalled();

    expect(answerGptImagePreferenceComparisons(root, answered)).toBe(false);
    expect(first.click).toHaveBeenCalledOnce();
  });
});
