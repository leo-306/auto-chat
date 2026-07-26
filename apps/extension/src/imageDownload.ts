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
