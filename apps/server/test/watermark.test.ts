import { describe, expect, it } from "vitest";
import { PNG } from "pngjs";
import { canRemoveGeminiImageWatermark, removeGeminiImageWatermark } from "../src/watermark.js";

function solidPng(width: number, height: number, rgb: [number, number, number]): Buffer {
  const png = new PNG({ width, height });
  for (let i = 0; i < width * height; i++) {
    png.data[i * 4] = rgb[0];
    png.data[i * 4 + 1] = rgb[1];
    png.data[i * 4 + 2] = rgb[2];
    png.data[i * 4 + 3] = 255;
  }
  return PNG.sync.write(png);
}

describe("canRemoveGeminiImageWatermark", () => {
  it("accepts png and jpeg", () => {
    expect(canRemoveGeminiImageWatermark("output-01.png")).toBe(true);
    expect(canRemoveGeminiImageWatermark("output-01.jpg")).toBe(true);
    expect(canRemoveGeminiImageWatermark("output-01.JPEG")).toBe(true);
  });

  // webp 没有纯 JS 的可靠编解码器，视频压根不走这条路，两者都必须原样放过。
  it("rejects formats we cannot round-trip", () => {
    expect(canRemoveGeminiImageWatermark("output-01.webp")).toBe(false);
    expect(canRemoveGeminiImageWatermark("output-01.mp4")).toBe(false);
    expect(canRemoveGeminiImageWatermark("notes.txt")).toBe(false);
  });

  it("falls back to content-type when the filename has no extension", () => {
    expect(canRemoveGeminiImageWatermark("blob", "image/png")).toBe(true);
    expect(canRemoveGeminiImageWatermark("blob", "image/webp")).toBe(false);
    expect(canRemoveGeminiImageWatermark("blob")).toBe(false);
  });
});

describe("removeGeminiImageWatermark", () => {
  it("returns null for formats it does not handle", async () => {
    await expect(removeGeminiImageWatermark(Buffer.from("not an image"), { filename: "a.webp" }))
      .resolves.toBeNull();
  });

  // 没有水印的图必须原样返回：一旦返回了 buffer，调用方就会把它写回磁盘，
  // JPEG 会白掉一轮画质，PNG 也会无谓地重写文件。
  it("keeps a watermark-free image untouched", async () => {
    const result = await removeGeminiImageWatermark(solidPng(320, 240, [90, 120, 200]), {
      filename: "output-01.png"
    });
    expect(result).toBeNull();
  });

  // 坏图让它照常抛，由 api.ts 那层 catch 成「保留原图」，这里只钉住不会静默返回垃圾。
  it("throws on a corrupt image instead of returning garbage", async () => {
    await expect(removeGeminiImageWatermark(Buffer.from("ffffffff", "hex"), { filename: "output-01.png" }))
      .rejects.toThrow();
  });
});
