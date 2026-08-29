// 在豆包页面主世界（world: MAIN）跑的注入脚本，负责把无水印原图接到页面的
// 图片链路上。必须 document_start 注入，且必须在主世界——豆包自己的 JS 解析
// 接口响应、导出下载文件都在主世界，隔离世界的 content.ts 钩不到。
//
// 覆盖的四条路径：
//   1. JSON.parse：从接口响应里收集原图地址，并把响应里的水印地址改成原图；
//   2. fetch / XMLHttpRequest：请求发出前把水印 URL 换成原图；
//   3. DOM：img.src、srcset、a[href] 里的水印地址；
//   4. canvas：豆包保存图片时会把展示用的图重绘进 canvas 再 toBlob 导出，
//      这一步会带上水印，改成直接取原图的字节。
//
// declarative_net_request 里的重定向规则负责图片资源级别的兜底，两者互补：规则管纯
// 图片请求（含 CSS 背景图这类我们钩不到的发起方），这里管 JSON、下载和 canvas 导出。
// 规则的正则编译后有 2KB 硬上限（实测只够一百多条指令），所以那边刻意一个模板一条
// 短正则，靠 requestDomains 收窄域名，不要再合并成一条长正则。

import { DoubaoRawImageIndex, isGeneratedImageUrl, jsonMayContainImageUrls } from "./doubaoWatermark.js";

const INSTALL_FLAG = "__autoChatDoubaoWatermarkInstalled__";

// 只有点击之后的这段窗口期才认为 canvas 导出是「用户/自动化在存图」。
// 常驻改写会把页面平时的 canvas 用途（比如裁剪预览）也一起改掉。
const DOWNLOAD_WINDOW_MS = 4_000;

const index = new DoubaoRawImageIndex();
const canvasSources = new WeakMap<HTMLCanvasElement, string>();
let downloadWindowUntil = 0;
let sweepScheduled = false;

install();

function install(): void {
  const scope = window as unknown as Record<string, unknown>;
  if (scope[INSTALL_FLAG]) return;
  scope[INSTALL_FLAG] = true;

  const nativeFetch = window.fetch;

  hookJsonParse();
  hookFetch(nativeFetch);
  hookXhrOpen();
  hookCanvas(nativeFetch);

  // 捕获阶段：要在豆包自己的下载处理器之前把 a[href] 换掉。
  document.addEventListener("click", () => {
    downloadWindowUntil = Date.now() + DOWNLOAD_WINDOW_MS;
    sweepDom();
  }, true);

  scheduleSweep();
}

function hookJsonParse(): void {
  const nativeParse = JSON.parse;
  JSON.parse = ((text: string, reviver?: Parameters<typeof JSON.parse>[1]) => {
    const parsed = nativeParse.call(JSON, text, reviver);
    if (!jsonMayContainImageUrls(text)) return parsed;
    try {
      if (typeof parsed === "string") return index.rewrite(parsed);
      index.absorb(parsed);
      scheduleSweep();
    } catch {
      // 接口数据的形状不受我们控制，改写失败也必须原样返回解析结果。
    }
    return parsed;
  }) as typeof JSON.parse;
}

function hookFetch(nativeFetch: typeof window.fetch): void {
  window.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
    nativeFetch.call(window, rewriteRequestInput(input), init)) as typeof window.fetch;
}

function rewriteRequestInput(input: RequestInfo | URL): RequestInfo | URL {
  if (typeof input === "string" || input instanceof URL) return rewriteUrlValue(input);
  const rewritten = index.rewrite(input.url);
  return rewritten === input.url ? input : new Request(rewritten, input);
}

function rewriteUrlValue(url: string | URL): string | URL {
  if (typeof url === "string") return index.rewrite(url);
  const rewritten = index.rewrite(url.href);
  return rewritten === url.href ? url : new URL(rewritten);
}

function hookXhrOpen(): void {
  type XhrOpen = (this: XMLHttpRequest, method: string, url: string | URL, ...rest: unknown[]) => void;
  const nativeOpen = XMLHttpRequest.prototype.open as unknown as XhrOpen;
  // 用 rest 转发剩余参数：三参形式必须保持三参，显式补一个 undefined 的
  // async 会被当成同步请求。
  const open: XhrOpen = function (this: XMLHttpRequest, method, url, ...rest) {
    nativeOpen.call(this, method, rewriteUrlValue(url), ...rest);
  };
  XMLHttpRequest.prototype.open = open as unknown as typeof XMLHttpRequest.prototype.open;
}

function hookCanvas(nativeFetch: typeof window.fetch): void {
  const nativeDrawImage = CanvasRenderingContext2D.prototype.drawImage;
  CanvasRenderingContext2D.prototype.drawImage = function (
    this: CanvasRenderingContext2D,
    ...args: Parameters<typeof CanvasRenderingContext2D.prototype.drawImage>
  ) {
    try {
      const source = args[0];
      const url = source instanceof HTMLImageElement
        ? source.currentSrc || source.src
        : source instanceof HTMLCanvasElement
          ? canvasSources.get(source)
          : undefined;
      if (url && isGeneratedImageUrl(url)) canvasSources.set(this.canvas, url);
    } catch {
      // 记录来源失败不能影响正常绘制。
    }
    return nativeDrawImage.apply(this, args);
  } as typeof CanvasRenderingContext2D.prototype.drawImage;

  const nativeToBlob = HTMLCanvasElement.prototype.toBlob;
  HTMLCanvasElement.prototype.toBlob = function (
    this: HTMLCanvasElement,
    callback: BlobCallback,
    type?: string,
    quality?: number
  ) {
    const source = canvasSources.get(this);
    const clean = source && Date.now() < downloadWindowUntil ? index.cleanUrlFor(source) : null;
    if (!clean) {
      nativeToBlob.call(this, callback, type, quality);
      return;
    }
    const fallback = () => nativeToBlob.call(this, callback, type, quality);
    nativeFetch.call(window, clean)
      .then(response => {
        if (!response.ok) throw new Error(`clean image fetch failed: ${response.status}`);
        return response.blob();
      })
      .then(blob => callback(blob))
      // 原图取不到就退回页面自己的导出结果，宁可带水印也不能让保存动作失败。
      .catch(fallback);
  };
}

function scheduleSweep(): void {
  if (sweepScheduled) return;
  sweepScheduled = true;
  window.setTimeout(() => {
    sweepScheduled = false;
    sweepDom();
  }, 0);
}

function sweepDom(): void {
  for (const image of document.querySelectorAll("img")) {
    const rewritten = index.rewrite(image.src);
    if (rewritten !== image.src) image.src = rewritten;
  }
  for (const element of document.querySelectorAll<HTMLImageElement | HTMLSourceElement>("img[srcset], source[srcset]")) {
    const rewritten = rewriteSrcset(element.srcset);
    if (rewritten !== element.srcset) element.srcset = rewritten;
  }
  for (const anchor of document.querySelectorAll<HTMLAnchorElement>("a[href]")) {
    const rewritten = index.rewrite(anchor.href);
    if (rewritten !== anchor.href) anchor.href = rewritten;
  }
}

function rewriteSrcset(srcset: string): string {
  return srcset.split(",").map(candidate => {
    const trimmed = candidate.trim();
    if (!trimmed) return candidate;
    const [url, ...descriptors] = trimmed.split(/\s+/);
    const rewritten = index.rewrite(url);
    return rewritten === url ? candidate : [rewritten, ...descriptors].join(" ");
  }).join(", ");
}
