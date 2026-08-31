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
//
// 视频走另一条路：水印不在像素里，而是服务端签好名的「视频信息查询接口」
// fallback_api 换个 logo_type 参数就能拿到无水印转码流（见 doubaoVideoWatermark.ts）。
// 这个地址只出现在主世界解析的接口响应里，所以这里顺手把它收集下来 postMessage 给
// 隔离世界的 content.ts，真正的下载在 background.ts 里发起。

import { DoubaoRawImageIndex, isGeneratedImageUrl, jsonMayContainImageUrls } from "./doubaoWatermark.js";
import {
  DOUBAO_FALLBACK_API_MESSAGE,
  DOUBAO_VIDEO_DIAG_MESSAGE,
  collectFallbackEntries,
  countFallbackApiKeys,
  isAllowedFallbackApiUrl,
  isDoubaoMediaResponseUrl,
  isVideoInfoRequestUrl,
  jsonMayContainFallbackApi
} from "./doubaoVideoWatermark.js";

const INSTALL_FLAG = "__autoChatDoubaoWatermarkInstalled__";

// 只有点击之后的这段窗口期才认为 canvas 导出是「用户/自动化在存图」。
// 常驻改写会把页面平时的 canvas 用途（比如裁剪预览）也一起改掉。
const DOWNLOAD_WINDOW_MS = 4_000;

const index = new DoubaoRawImageIndex();
const canvasSources = new WeakMap<HTMLCanvasElement, string>();
// 必须在装钩子之前留一份原生 JSON.parse：reportFallbackApis 自己也要 parse，
// 用被钩过的那个会无限递归。
const nativeJsonParse = JSON.parse;
// 已经报出去的地址 → 当时认出的 message_id。同一条地址会被好几个钩子看到
// （XHR 内部自己 parse 会先触发 JSON.parse 钩子），只有那一份能认出 message_id
// 的才算数，所以带 id 的允许补报一次。
const reportedFallbackApis = new Map<string, string>();
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
  // 首屏消息可能是随 HTML 一起内嵌下来的（那样就没有任何我们钩得到的请求），
  // 所以再扫一遍页面里的 <script>。等一会儿再扫是为了让首屏脚本先落地。
  for (const delay of [1_500, 5_000]) window.setTimeout(sweepInlineData, delay);
}

function sweepInlineData(): void {
  try {
    for (const script of document.querySelectorAll("script")) {
      const text = script.textContent ?? "";
      if (!jsonMayContainFallbackApi(text)) continue;
      reportDiag("inline_script", window.location.href, { length: text.length });
      reportFallbackApis(text, parseJsonSafely(text), "inline_script");
    }
  } catch {
    // 扫内嵌数据失败不影响其他路径。
  }
}

function hookJsonParse(): void {
  JSON.parse = ((text: string, reviver?: Parameters<typeof JSON.parse>[1]) => {
    const parsed = nativeJsonParse.call(JSON, text, reviver);
    reportFallbackApis(text, parsed, "json_parse");
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

// 把响应里新出现的 fallback_api 地址（连同它所属的消息 id）递给隔离世界，重复的不再发。
function reportFallbackApis(text: unknown, parsed: unknown, source: string): void {
  if (!jsonMayContainFallbackApi(text)) return;
  try {
    const rawText = typeof text === "string" ? text : "";
    const entries = collectFallbackEntries(parsed, rawText);
    // 键出现次数和实际收到的条数对不上就说明提取漏了，这条差值是排查的关键。
    reportDiag(`${source}_collect`, window.location.href, {
      rawKeyCount: countFallbackApiKeys(text),
      collected: entries.length,
      withMessageId: entries.filter(entry => entry.messageId).length
    });
    for (const entry of entries) report(entry.url, source, entry.messageId);
  } catch {
    // 收集失败只是少一条无水印路径，绝不能影响页面自己的解析。
  }
}

function report(url: string, source: string, messageId: string): void {
  const known = reportedFallbackApis.get(url);
  // 报过了，且不是「这次终于认出了 message_id」的情况，就不再重复发。
  if (known !== undefined && (known !== "" || messageId === "")) return;
  reportedFallbackApis.set(url, messageId);
  window.postMessage({ type: DOUBAO_FALLBACK_API_MESSAGE, url, source, messageId }, window.location.origin);
}

// 排查用：主世界到底看见了哪些相关请求。同一条只报一次，最多报这么多条。
const DIAG_LIMIT = 40;
const diagnosed = new Set<string>();

function reportDiag(kind: string, url: string, detail?: Record<string, unknown>): void {
  const key = `${kind} ${url}`;
  if (diagnosed.has(key) || diagnosed.size >= DIAG_LIMIT) return;
  diagnosed.add(key);
  try {
    const parsed = new URL(url, window.location.href);
    window.postMessage({
      type: DOUBAO_VIDEO_DIAG_MESSAGE,
      kind,
      path: `${parsed.hostname}${parsed.pathname}`,
      videoId: parsed.searchParams.get("video_id") ?? "",
      logoType: parsed.searchParams.get("logo_type") ?? "",
      ...detail
    }, window.location.origin);
  } catch {
    // 诊断信息发不出去无所谓。
  }
}

function hookFetch(nativeFetch: typeof window.fetch): void {
  window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const requestUrl = requestUrlOf(input);
    inspectRequestUrl(requestUrl, "fetch");
    const promise = nativeFetch.call(window, rewriteRequestInput(input), init);
    // 豆包用 response.json() 读消息流，绕过了 JSON.parse 钩子，所以这里对聊天记录相关的
    // 接口再扫一遍响应体。clone() 之后独立消费，不影响页面自己的读取。
    if (isDoubaoMediaResponseUrl(requestUrl)) {
      promise.then(response => response.clone().text())
        .then(text => {
          if (jsonMayContainFallbackApi(text)) reportDiag("body_hit", requestUrl);
          reportFallbackApis(text, parseJsonSafely(text), "fetch_body");
        })
        .catch(() => {
          // 兜底扫描失败无所谓，主链路仍然返回原来的 promise。
        });
    }
    return promise;
  }) as typeof window.fetch;
}

// 页面自己请求 video_info 时那条 URL 就是这张卡片签好名的 fallback_api，直接收下。
function inspectRequestUrl(requestUrl: string, kind: string): void {
  if (!requestUrl) return;
  if (isVideoInfoRequestUrl(requestUrl)) {
    reportDiag(`${kind}_video_info`, requestUrl);
    report(requestUrl, `${kind}_request`, "");
    return;
  }
  if (isDoubaoMediaResponseUrl(requestUrl)) reportDiag(`${kind}_media`, requestUrl);
}

function requestUrlOf(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function parseJsonSafely(text: string): unknown {
  try {
    return nativeJsonParse.call(JSON, text);
  } catch {
    // 消息流是分段的 JSON，parse 不出来时靠 rawText 上的正则兜底。
    return null;
  }
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
    const requestUrl = typeof url === "string" ? url : url.href;
    inspectRequestUrl(requestUrl, "xhr");
    // fetch 那条路有 clone() 可以独立消费，XHR 这边只能等它自己读完再看一眼 responseText。
    if (isDoubaoMediaResponseUrl(requestUrl)) {
      this.addEventListener("load", () => {
        try {
          if (this.responseType !== "" && this.responseType !== "text") return;
          const text = this.responseText;
          if (jsonMayContainFallbackApi(text)) reportDiag("xhr_body_hit", requestUrl);
          reportFallbackApis(text, parseJsonSafely(text), "xhr_body");
        } catch {
          // 读不到响应文本就算了。
        }
      });
    }
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
