import { describe, expect, it } from "vitest";
import { isDoubaoDownloadControl } from "../src/imageDownload.js";

function control(attributes: Record<string, string | null>, text = "", className = ""): HTMLElement {
  return {
    innerText: text,
    className,
    title: attributes.title ?? "",
    getAttribute(name: string) {
      return attributes[name] ?? null;
    }
  } as unknown as HTMLElement;
}

describe("豆包图片下载控件", () => {
  it("识别中文下载标签和语义属性", () => {
    expect(isDoubaoDownloadControl(control({ "aria-label": "下载图片" }))).toBe(true);
    expect(isDoubaoDownloadControl(control({ "aria-label": "保存" }))).toBe(true);
    expect(isDoubaoDownloadControl(control({ "data-testid": "image-download-button" }))).toBe(true);
    expect(isDoubaoDownloadControl(control({ "data-action": "save-image" }))).toBe(true);
  });

  it("不把重新生成和分享控件当成下载", () => {
    expect(isDoubaoDownloadControl(control({ "aria-label": "重新生成" }))).toBe(false);
    expect(isDoubaoDownloadControl(control({ "aria-label": "分享图片" }))).toBe(false);
  });
});
