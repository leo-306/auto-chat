export function isDoubaoDownloadControl(element: HTMLElement): boolean {
  const descriptor = [
    element.getAttribute("aria-label"),
    element.title,
    element.innerText,
    element.getAttribute("data-testid"),
    element.getAttribute("data-test-id"),
    element.getAttribute("data-action"),
    element.getAttribute("name"),
    element.className,
    element.outerHTML
  ].filter((value): value is string => typeof value === "string" && value.length > 0).join(" ");

  return /download|save(?:[-_ ]?(?:image|picture))?|\u4e0b\u8f7d(?:\u539f\u56fe|\u56fe\u7247)?|\u4fdd\u5b58(?:\u539f\u56fe|\u56fe\u7247)?/i.test(descriptor);
}

// \u65b0\u7248\u8c46\u5305\u56fe\u7247\u9884\u89c8\u9762\u677f\u9876\u90e8\u7684\u4e0b\u8f7d\u6309\u94ae\u6ca1\u6709 aria-label / title / \u6587\u6848 / testid\uff0c
// \u4e0a\u9762\u7684\u6587\u672c\u5339\u914d\u4e00\u4e2a\u90fd\u78b0\u4e0d\u5230\uff0c\u53ea\u80fd\u9760\u300c\u7bad\u5934\u6307\u5411\u6258\u76d8\u300d\u7684\u4e0b\u8f7d\u56fe\u6807\u6765\u8ba4\u3002
// \u524d\u7f00\u53d6\u81ea 2026-08 \u7ebf\u4e0a DOM\uff08svg 24x24\uff0cviewBox \u5185\u7b2c\u4e00\u6761 path\uff09\u3002
const DOUBAO_DOWNLOAD_ICON_PATH_PREFIX = "M20.375 14.85";

export function hasDoubaoDownloadIcon(element: Element): boolean {
  return [...element.querySelectorAll("svg path")].some(path =>
    (path.getAttribute("d") ?? "").trimStart().startsWith(DOUBAO_DOWNLOAD_ICON_PATH_PREFIX)
  );
}

// \u9884\u89c8\u6253\u5f00\u65f6\u624d\u4f1a\u51fa\u73b0\u7684\u4e00\u6392\u6807\u6ce8\u5de5\u5177\uff0c\u7528\u6765\u786e\u8ba4\u300c\u9884\u89c8\u786e\u5b9e\u5f00\u7740\u300d\u3002
// \u54c1\u724c\u84dd\u515c\u5e95\u903b\u8f91\u5fc5\u987b\u9760\u5b83\u628a\u8f93\u5165\u6846\u7684\u53d1\u9001\u6309\u94ae\u6392\u9664\u6389\u2014\u2014\u4e24\u8005\u540c\u8272\u3002
export const DOUBAO_PREVIEW_MARKER_SELECTOR = "[aria-label^='marker-tool']";
export const DOUBAO_BRAND_BLUE = "rgb(0, 102, 255)";
