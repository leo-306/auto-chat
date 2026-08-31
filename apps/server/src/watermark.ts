// Gemini 的星芒 logo 是烧进像素里的，跟豆包那条「把 URL 里的 tplv 模板换成
// image_raw 就拿到无水印原图」的路子（见 apps/extension/src/doubaoWatermark.ts）
// 完全不是一回事，只能真做检测 + 逆 alpha 混合。算法整包用
// @pilio/gemini-watermark-remover（MIT），这里只负责三件事：喂给它编解码器、
// 判断该不该动这张图、以及守住「失败就原样保存」的底线。
//
// 编解码故意不用官方示例里的 sharp，而是纯 JS 的 pngjs / jpeg-js：本项目至今
// 没有任何 native 依赖，为一个可选后处理引入预编译二进制不值得。代价是不支持
// webp —— 遇到 webp 直接跳过，保持原图。
//
// 注意算法核心是同步 CPU 计算（removeWatermarkFromImageDataSync），单张 1~6 秒
// 期间会占住事件循环。本项目是本机单人工具、maxConcurrency 默认 1，插件那边的
// 轮询也没设超时，所以这点阻塞可以接受；MAX_PIXELS 用来挡住超大图把主线程占太久。
import path from "node:path";
import { PNG } from "pngjs";
import jpeg from "jpeg-js";
import type { WatermarkMeta } from "@pilio/gemini-watermark-remover";
import type { NodeCodecContext } from "@pilio/gemini-watermark-remover/node";

// 运行时的 meta 比包里的 .d.ts 声明得更全，这几个字段是判断成品质量用的。
type RuntimeWatermarkMeta = WatermarkMeta & {
  qualityStatus?: string | null;
  selectionConfidence?: number | null;
};

type ImageDataLike = { width: number; height: number; data: Uint8ClampedArray };

export type WatermarkRemoval = {
  buffer: Buffer;
  meta: RuntimeWatermarkMeta;
};

// 超过这个像素量就不处理了：2.6 亿像素的图算下来要几十秒，不值得为它卡住服务。
const MAX_PIXELS = 40_000_000;

// 重新编码 JPEG 必然二次压缩，所以只在真去掉了水印时才写回；质量对齐官方 CLI。
const JPEG_QUALITY = 95;

type SupportedFormat = "png" | "jpeg";

/** 只认 png / jpeg；webp 和其它格式返回 null，调用方原样保存。 */
function resolveFormat(filename: string, contentType?: string): SupportedFormat | null {
  const ext = path.extname(filename).toLowerCase();
  if (ext === ".png") return "png";
  if (ext === ".jpg" || ext === ".jpeg") return "jpeg";
  if (ext) return null;
  // 少数情况下 filename 没带扩展名，退回 content-type。
  if (!contentType) return null;
  if (/png/i.test(contentType)) return "png";
  if (/jpe?g/i.test(contentType)) return "jpeg";
  return null;
}

function decodeImageData(input: Buffer | Uint8Array | ArrayBuffer, format: SupportedFormat): ImageDataLike {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input as ArrayBuffer);
  if (format === "jpeg") {
    // formatAsRGBA 保证拿到 4 通道，算法按 RGBA 步长索引，少一个通道就全错。
    const decoded = jpeg.decode(buffer, { formatAsRGBA: true, useTArray: true });
    return { width: decoded.width, height: decoded.height, data: Uint8ClampedArray.from(decoded.data) };
  }
  const decoded = PNG.sync.read(buffer);
  return { width: decoded.width, height: decoded.height, data: Uint8ClampedArray.from(decoded.data) };
}

function encodeImageData(imageData: ImageDataLike, format: SupportedFormat): Buffer {
  if (format === "jpeg") {
    return jpeg.encode(
      { data: Buffer.from(imageData.data), width: imageData.width, height: imageData.height },
      JPEG_QUALITY
    ).data;
  }
  const png = new PNG({ width: imageData.width, height: imageData.height });
  png.data = Buffer.from(imageData.data);
  return PNG.sync.write(png);
}

// 45MB 的包大头全在视频用的 wasm/onnx 上，图片这条链只有几十个纯 JS 文件。
// 懒加载是为了让服务启动不为一个可选功能付钱，也让包坏掉时只影响去水印本身。
let sdkPromise: Promise<typeof import("@pilio/gemini-watermark-remover/node")> | null = null;

function loadSdk(): Promise<typeof import("@pilio/gemini-watermark-remover/node")> {
  sdkPromise ??= import("@pilio/gemini-watermark-remover/node");
  return sdkPromise;
}

/**
 * 便宜的前置判断：调用方拿到的是 base64，先用文件名筛一遍，
 * 免得为一个 mp4 白解一次几 MB 的 base64。
 */
export function canRemoveGeminiImageWatermark(filename: string, contentType?: string): boolean {
  return resolveFormat(filename, contentType) !== null;
}

/**
 * 去掉 Gemini 生图右下角的星芒水印。
 *
 * 返回 null 表示「这张图不该动或没能动」——格式不支持、尺寸过大、没检测到水印、
 * 或者算法认为再动下去会伤画面。调用方遇到 null 一律原样保存。
 */
export async function removeGeminiImageWatermark(
  input: Buffer,
  hint: { filename: string; contentType?: string }
): Promise<WatermarkRemoval | null> {
  const format = resolveFormat(hint.filename, hint.contentType);
  if (!format) return null;

  const { removeWatermarkFromBuffer } = await loadSdk();
  const probe = decodeImageData(input, format);
  if (probe.width * probe.height > MAX_PIXELS) return null;

  const result = await removeWatermarkFromBuffer(input, {
    // 已经解过一次码了，别让 SDK 再解一遍。
    decodeImageData: (_buffer: Buffer | Uint8Array | ArrayBuffer, _context: NodeCodecContext) => probe,
    encodeImageData: (imageData: ImageDataLike) => encodeImageData(imageData, format),
    filePath: hint.filename,
    adaptiveMode: "auto"
  });

  const meta = result.meta as RuntimeWatermarkMeta;
  // applied 是唯一权威开关：false 表示一个像素都没改，这时候重新编码只会白掉画质。
  if (!meta.applied) return null;
  // 管线是 fail-closed 的，宁可留着水印也不能糊画面。
  if (meta.qualityStatus === "possible-content-damage") return null;

  return { buffer: Buffer.isBuffer(result.buffer) ? result.buffer : Buffer.from(result.buffer), meta };
}
