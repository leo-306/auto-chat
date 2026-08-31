// 插件端去水印，跟 apps/server/src/watermark.ts 是同一套算法的两个宿主。
//
// 为什么值得在插件里再做一遍：
// 1. 编解码用 Chrome 自己的（createImageBitmap + OffscreenCanvas），所以 webp 也能处理。
//    服务端那条路是纯 JS 的 pngjs / jpeg-js，webp 只能跳过。
// 2. 图片在离开浏览器之前就干净了，插件里任何预览、以及走 HTTP 传出去的 base64
//    都不再带水印。
// 3. 原生编解码比纯 JS 快，省掉服务端那 1~6 秒里相当一部分是解码/编码的开销。
//
// 代价是这套算法进了 service worker 的包（未压缩 +824KB），每次 SW 冷启动都要解析；
// 而且计算是同步的，跑的时候插件自己的轮询和 dispatch 会一起停住。
//
// 服务端那份不会删：它才是真正的收口（任何不经插件写 artifact 的路径都还得靠它）。
// 插件处理成功后会在 artifact 上带 watermarkHandled，服务端见到就跳过，不重复算。
import { removeWatermarkFromImageDataSync } from "@pilio/gemini-watermark-remover/image-data";
import type { WatermarkMeta } from "@pilio/gemini-watermark-remover";

// 运行时的 meta 比包里的 .d.ts 声明得更全，这几个字段是判断成品质量用的。
type RuntimeWatermarkMeta = WatermarkMeta & {
  qualityStatus?: string | null;
};

export type WatermarkRemoval = {
  dataBase64: string;
  meta: RuntimeWatermarkMeta;
  elapsedMs: number;
};

// 跟服务端同一个上限：2.6 亿像素的图算下来要几十秒，不值得为它卡住 service worker。
const MAX_PIXELS = 40_000_000;

// 重新编码有损格式必然二次压缩，所以只在真去掉了水印时才写回；质量对齐服务端。
const LOSSY_QUALITY = 0.95;

// png 无损，jpeg / webp 有损但 Chrome 原生能编，所以三种都收。
const SUPPORTED_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

function resolveType(filename: string, contentType?: string): string | null {
  const normalized = contentType?.split(";")[0]?.trim().toLowerCase();
  if (normalized && SUPPORTED_TYPES.has(normalized)) return normalized;
  if (normalized === "image/jpg") return "image/jpeg";
  // content-type 不可信时退回扩展名。
  const ext = filename.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  if (ext === "png") return "image/png";
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  if (ext === "webp") return "image/webp";
  return null;
}

/** 便宜的前置判断：先按文件名/类型筛一遍，免得为一个 mp4 白解一次几 MB 的 base64。 */
export function canRemoveGeminiImageWatermark(filename: string, contentType?: string): boolean {
  return resolveType(filename, contentType) !== null;
}

function base64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function bytesToBase64(bytes: Uint8Array): string {
  // 一次性 apply 整个数组会爆栈，按块拼。
  let binary = "";
  const chunk = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk));
  }
  return btoa(binary);
}

/**
 * 去掉 Gemini 生图右下角的星芒水印。
 *
 * 返回 null 表示「这张图不该动或没能动」——格式不支持、尺寸过大、没检测到水印、
 * 或者算法认为再动下去会伤画面。调用方遇到 null 一律按原图上传。
 */
export async function removeGeminiImageWatermark(
  dataBase64: string,
  hint: { filename: string; contentType?: string }
): Promise<WatermarkRemoval | null> {
  const type = resolveType(hint.filename, hint.contentType);
  if (!type) return null;

  const startedAt = Date.now();
  const bitmap = await createImageBitmap(new Blob([base64ToBytes(dataBase64)], { type }));
  try {
    if (bitmap.width * bitmap.height > MAX_PIXELS) return null;

    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    // willReadFrequently 让 Chrome 走软件光栅化，省掉 getImageData 的 GPU 回读。
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) return null;
    context.drawImage(bitmap, 0, 0);
    const imageData = context.getImageData(0, 0, bitmap.width, bitmap.height);

    const result = removeWatermarkFromImageDataSync(imageData, { adaptiveMode: "auto" });
    const meta = result.meta as RuntimeWatermarkMeta;
    // applied 是唯一权威开关：false 表示一个像素都没改，这时候重新编码只会白掉画质。
    if (!meta.applied) return null;
    // 管线是 fail-closed 的，宁可留着水印也不能糊画面。
    if (meta.qualityStatus === "possible-content-damage") return null;

    context.putImageData(new ImageData(
      new Uint8ClampedArray(result.imageData.data),
      result.imageData.width,
      result.imageData.height
    ), 0, 0);
    const blob = await canvas.convertToBlob(
      type === "image/png" ? { type } : { type, quality: LOSSY_QUALITY }
    );
    return {
      dataBase64: bytesToBase64(new Uint8Array(await blob.arrayBuffer())),
      meta,
      elapsedMs: Date.now() - startedAt
    };
  } finally {
    bitmap.close();
  }
}
