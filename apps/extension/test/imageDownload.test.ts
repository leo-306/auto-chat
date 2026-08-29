import { describe, expect, it } from "vitest";
import { hasDoubaoDownloadIcon, isDoubaoDownloadControl } from "../src/imageDownload.js";

// 线上真实的下载图标（箭头指向托盘），只保留开头一段就够断言了。
const DOWNLOAD_ICON_D =
  "M20.375 14.8535C20.9273 14.8535 21.375 15.3012 21.375 15.8535V18.5059C21.375 20.1627 20.0319 21.5059 18.375 21.5059H5.625Z";

function withIconPaths(...ds: string[]): Element {
  return {
    querySelectorAll(selector: string) {
      return selector === "svg path" ? ds.map(d => ({ getAttribute: () => d })) : [];
    }
  } as unknown as Element;
}

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

describe("豆包预览面板的下载图标", () => {
  it("认出无标签按钮里的下载箭头", () => {
    expect(hasDoubaoDownloadIcon(withIconPaths(DOWNLOAD_ICON_D))).toBe(true);
    expect(hasDoubaoDownloadIcon(withIconPaths("  " + DOWNLOAD_ICON_D))).toBe(true);
  });

  it("不误认其它图标", () => {
    // 预览工具条上的「更多」和标注工具用的是完全不同的路径。
    expect(hasDoubaoDownloadIcon(withIconPaths("M4.03125 10C5.1356 10.5 6 11"))).toBe(false);
    expect(hasDoubaoDownloadIcon(withIconPaths("M12.0596 22.9451C11.65 22.4"))).toBe(false);
    expect(hasDoubaoDownloadIcon(withIconPaths())).toBe(false);
  });
});
