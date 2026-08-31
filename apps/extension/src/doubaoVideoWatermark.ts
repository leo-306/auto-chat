// 豆包视频的水印和图片一样不是烧进像素里的，只是取的转码流不同：聊天消息里带着一个
// 服务端自己签好名的「视频信息查询接口」地址 fallback_api，把它的 query 换成
// logo_type=unwatermarked 再请求一次，拿回来的就是同一条视频的无水印转码流。签名没有
// 覆盖这几个参数，所以只改参数依然可用 —— 和图片只换 tplv 模板名是同一个道理
// （见 doubaoWatermark.ts）。
//
// 接口返回的 video_list 里 main_url 不一定是明文地址，线上三种形态都出现过：
//   1. 本身就是 http(s) 地址；
//   2. base64 过的地址，且可能把 + / = 替换成 $ @ #；
//   3. `qAAB` 开头的密文，用同一份响应里的 key_seed 派生 AES-128-CBC 的 key/iv 解密。
//
// 这个文件只放纯逻辑（含 WebCrypto 解密）：从页面响应里捞 fallback_api 在
// doubaoWatermarkPage.ts，真正发请求取字节在 background.ts。

// fallback_api 是从页面响应里捞出来的地址，只允许打到豆包自己这几个域，
// 避免响应里被塞进第三方地址后我们照着请求。
const FALLBACK_API_HOST_SUFFIXES = ["doubao.com", "dola.com", "byteintlapi.com", "snssdk.com"];

// 换成无水印转码流的三个参数：logo_type 决定有没有台标，另外两个跟着一起换才是
// 线上验证过的组合（channel=no 去掉渠道标识，codec_type=8 指定编码）。
export const UNWATERMARKED_VIDEO_QUERY = {
  channel: "no",
  codec_type: "8",
  logo_type: "unwatermarked"
} as const;

// qAAB 密文派生 key/iv 用的固定盐，抄自线上实现，改一个字节就解不出来。
const QAAB_SALT_HEX =
  "4dd4c2e6b83162090e52b3c7a6733ba4" +
  "1cb2462b829ab58a196b39db57177524" +
  "f49baf7f08e8d68d26a72e37c1a95a2f" +
  "1f05a51892aef2949732b62a38aadd58";

export type DoubaoVideoEntry = { token: string; width: number; height: number; bitrate: number };
export type DoubaoUnwatermarkedVideo = { url: string; width: number; height: number; bitrate: number };

// 一条候选（fallback_api）解出来的无水印视频，不含字节，只够拿来和页面上的卡片对号。
// objectId 是无水印那档的对象 id，objectIds 是同一条视频「带台标」那几档的对象 id：
// 页面 <video> 播的是带台标的转码流，所以真正能和卡片对上号的是后者。
// messageId 是这条 fallback_api 在响应里所属的消息 id，DOM 卡片祖先上也挂着同一个值
// （data-message-id），两边一对就不必再靠宽高/时长这类间接指纹去猜。
export type DoubaoResolvedVideo = {
  fallbackApi: string;
  width: number;
  height: number;
  bitrate: number;
  duration: number;
  objectId: string;
  objectIds?: string[];
  messageId?: string;
};

// 一条 fallback_api 连同它所属的消息 id（认不出来时是空串）。
export type DoubaoFallbackEntry = { url: string; messageId: string };

// 页面上那张卡片能量到的信息：<video> 的原生宽高、时长、它自己那条带台标直链，
// 以及卡片祖先上的 data-message-id。
export type DoubaoVideoTarget = {
  width: number;
  height: number;
  duration: number;
  objectId: string;
  messageId?: string;
};

export type DoubaoVideoMatchReason = "message_id" | "object_id" | "duration" | "size" | "only_candidate";
export type DoubaoVideoMatch<T extends DoubaoResolvedVideo = DoubaoResolvedVideo> = {
  video: T;
  reason: DoubaoVideoMatchReason;
};

// 同一条视频的时长两边都对得上，但一个是播放器报的浮点、一个是接口给的整数，留点余量。
const DURATION_TOLERANCE_SECONDS = 0.4;

// fallback_api 只有主世界的注入脚本能看到（接口响应在那边解析），下载又只能在
// content script / background 里发起，所以用 window.postMessage 把地址递过去。
export const DOUBAO_FALLBACK_API_MESSAGE = "auto-chat:doubao-fallback-api";

// 带视频信息的聊天消息走这个接口，主世界只对它做响应体兜底扫描。
export const DOUBAO_MESSAGE_CHAIN_PATH = "/im/chain/single";

// 主世界看到的请求/响应概况，只为排查「候选为什么没收全」，不参与下载逻辑。
export const DOUBAO_VIDEO_DIAG_MESSAGE = "auto-chat:doubao-video-diag";

// 页面渲染视频卡片时自己就会请求一次这个签好名的接口去拿播放地址 —— 那条 URL 本身
// 就是这张卡片的 fallback_api。直接把它收下来，比从消息响应里翻要准得多：消息响应
// 可能压根不经过主世界（在 worker 里发的请求我们钩不到）。
export function isVideoInfoRequestUrl(value: string): boolean {
  if (!isAllowedFallbackApiUrl(value)) return false;
  try {
    const url = new URL(value);
    if (!/video_info|\/media\/video/i.test(url.pathname)) return false;
    return url.searchParams.has("video_id") || url.searchParams.has("logo_type");
  } catch {
    return false;
  }
}

// 消息体兜底扫描的范围：聊天记录相关的接口都扫，只靠 fallback_api 字面量筛成本已经够低。
export function isDoubaoMediaResponseUrl(value: string): boolean {
  try {
    const url = new URL(value, "https://www.doubao.com");
    if (!isAllowedFallbackApiUrl(url.href)) return false;
    return /chain|message|conversation|history|media|samantha/i.test(url.pathname);
  } catch {
    return false;
  }
}

// 只用来把候选写进日志，签名参数太长不适合整条记下来。
export function videoIdOf(value: string): string {
  try {
    return new URL(value).searchParams.get("video_id") ?? "";
  } catch {
    return "";
  }
}

export function isHttpUrl(value: unknown): boolean {
  return typeof value === "string" && /^https?:\/\//i.test(value);
}

export function isAllowedFallbackApiUrl(value: string): boolean {
  const hostname = httpHostname(value);
  return hostname !== "" &&
    FALLBACK_API_HOST_SUFFIXES.some(suffix => hostname === suffix || hostname.endsWith(`.${suffix}`));
}

// 快速筛掉与视频无关的响应，避免每个接口都走一遍深度遍历。
export function jsonMayContainFallbackApi(text: unknown): boolean {
  return typeof text === "string" && text.includes("fallback_api");
}

// 排查用：响应体里 fallback_api 这个键出现了几次。和收集到的条数一对比就知道
// 是「响应里真的只有这么几条」还是「我们的提取漏了」。
export function countFallbackApiKeys(text: unknown): number {
  if (typeof text !== "string") return 0;
  return text.split("fallback_api").length - 1;
}

// 从一份接口响应里收集所有 fallback_api，保持出现顺序，并尽量标出它属于哪条消息。
//
// 结构遍历会把嵌套的 JSON 字符串再 parse 一层（豆包常把消息内容整块塞成字符串），
// 但实测 /im/chain/single 的响应体里 fallback_api 藏得比这更深：外层 parse 出来之后
// 消息内容还是转义了好几轮的字符串，逐层 parse 走不通（日志里 body_hit 命中了字面量，
// 结构遍历却一条都没捞到）。所以真正管用的是先把整段原文深度反转义再上正则 ——
// 不管嵌套几层、parse 成不成功，只要字面量在文本里就能捞出来。
export function collectFallbackEntries(json: unknown, rawText = ""): DoubaoFallbackEntry[] {
  const entries: DoubaoFallbackEntry[] = [];
  const add = (value: unknown, messageId: string): void => {
    if (typeof value !== "string" || !value) return;
    const url = decodeJsonEscapedFragment(value);
    if (!isAllowedFallbackApiUrl(url)) return;
    const existing = entries.find(entry => entry.url === url);
    if (existing) {
      // 同一条地址先由正则捞到、后由结构遍历补出 message_id 时，把 id 填上。
      if (!existing.messageId && messageId) existing.messageId = messageId;
      return;
    }
    entries.push({ url, messageId });
  };

  const seen = new WeakSet<object>();
  const walk = (value: unknown, depth: number, messageId: string): void => {
    if (depth > 12 || value == null) return;
    if (typeof value === "string") {
      const parsed = parseJsonString(value);
      if (parsed !== null) walk(parsed, depth + 1, messageId);
      return;
    }
    if (typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    const node = value as Record<string, unknown>;
    const scoped = directMessageId(node) || messageId;
    if (!Array.isArray(node) && Object.prototype.hasOwnProperty.call(node, "fallback_api")) {
      const candidates = Array.isArray(node.fallback_api) ? node.fallback_api : [node.fallback_api];
      for (const candidate of candidates) add(candidate, scoped);
    }
    for (const child of Object.values(node)) walk(child, depth + 1, scoped);
  };
  walk(json, 0, "");

  const unescaped = unescapeDeep(rawText);
  const messageIds = messageIdPositions(unescaped);
  for (const match of unescaped.matchAll(/"fallback_api"\s*:\s*"([^"]+)"/g)) {
    add(match[1], nearestMessageId(messageIds, match.index ?? 0));
  }
  return entries;
}

// 老调用方只要地址列表。
export function collectFallbackApis(json: unknown, rawText = ""): string[] {
  return collectFallbackEntries(json, rawText).map(entry => entry.url);
}

// 消息内容在响应里被转义了好几轮（`\\u0026`、`\\\"` 这种），一轮剥一层，剥到不变为止。
// 必须一次扫描里同时处理 \\ 和 \/ \" \uXXXX：分成几次 replace 顺序执行会互相打断，
// 比如 `\\u0026` 会先被当成 `&` 剥成 `\&`，剩下的反斜杠就再也剥不掉了。
function unescapeDeep(text: string): string {
  let current = text;
  for (let round = 0; round < 5; round += 1) {
    if (!current.includes("\\")) break;
    const next = current.replace(/\\(u[0-9a-fA-F]{4}|[\\/"])/g, (_match, token: string) =>
      token.startsWith("u") ? String.fromCharCode(Number.parseInt(token.slice(1), 16)) : token);
    if (next === current) break;
    current = next;
  }
  return current;
}

function directMessageId(node: Record<string, unknown>): string {
  for (const key of ["message_id", "msg_id", "messageId", "messageID"]) {
    const value = node[key];
    if (typeof value === "string" && /^\d{6,}$/.test(value.trim())) return value.trim();
    // 消息 id 是 19 位十进制，超出 double 的安全整数范围：JSON.parse 出来的数字已经
    // 丢了末位精度（…714 会变成 …710），拿它对号只会对错，直接不采信，交给原文正则。
    if (typeof value === "number" && Number.isSafeInteger(value) && value >= 100_000) return String(value);
  }
  return "";
}

// 反转义后的原文里每个 message_id 出现的位置，用来给正则捞到的 fallback_api 认领归属：
// 响应里 fallback_api 总跟在它所属消息的 message_id 后面。
function messageIdPositions(text: string): Array<{ at: number; id: string }> {
  const positions: Array<{ at: number; id: string }> = [];
  for (const match of text.matchAll(/"(?:message_id|msg_id|messageId|messageID)"\s*:\s*"?(\d{6,})/g)) {
    positions.push({ at: match.index ?? 0, id: match[1]! });
  }
  return positions;
}

function nearestMessageId(positions: ReadonlyArray<{ at: number; id: string }>, at: number): string {
  let id = "";
  for (const position of positions) {
    if (position.at > at) break;
    id = position.id;
  }
  return id;
}

// 只换那三个参数，签名参数原样保留。
export function unwatermarkedVideoInfoUrl(fallbackApi: string): string {
  let url = fallbackApi;
  for (const [key, value] of Object.entries(UNWATERMARKED_VIDEO_QUERY)) url = setQueryParam(url, key, value);
  return url;
}

// 刻意用字符串替换而不是 URLSearchParams：后者会把整个 query 重新序列化，
// 签名参数里没转义的 / : 之类会变成 %2F %3A，服务端按原文校验签名就会失败。
function setQueryParam(rawUrl: string, key: string, value: string): string {
  const existing = new RegExp(`([?&]${key}=)[^&#]*`, "i");
  if (existing.test(rawUrl)) return rawUrl.replace(existing, `$1${value}`);
  const [beforeHash, hash = ""] = splitOnce(rawUrl, "#");
  const separator = beforeHash.includes("?") ? "&" : "?";
  return `${beforeHash}${separator}${key}=${value}${hash ? `#${hash}` : ""}`;
}

function splitOnce(text: string, separator: string): [string, string?] {
  const at = text.indexOf(separator);
  return at === -1 ? [text] : [text.slice(0, at), text.slice(at + separator.length)];
}

// 响应包了好几层，且不同接口层级不一样，逐层退化到能用的那一层。
function videoData(payload: unknown): Record<string, unknown> {
  const root = asObject(payload);
  const nested = asObject(root.data);
  const info = isObject(root.video_info) ? root.video_info : isObject(nested.video_info) ? nested.video_info : root;
  return isObject(info.data) ? info.data : info;
}

// video_list 里是同一条视频的各档清晰度，按响应里的顺序全列出来。
export function listVideoEntries(payload: unknown): DoubaoVideoEntry[] {
  const data = videoData(payload);
  const list = data.video_list;
  const nodes = isObject(list) && Object.keys(list).length > 0 ? Object.values(list) : [data];
  const entries: DoubaoVideoEntry[] = [];
  for (const entry of nodes) {
    if (!isObject(entry)) continue;
    const token = typeof entry.main_url === "string" && entry.main_url.trim()
      ? entry.main_url.trim()
      : typeof entry.play_url === "string" && entry.play_url.trim() ? entry.play_url.trim() : "";
    if (!token) continue;
    entries.push({
      token,
      width: numberOf(entry.vwidth) || numberOf(entry.width),
      height: numberOf(entry.vheight) || numberOf(entry.height),
      bitrate: numberOf(entry.bitrate) || numberOf(entry.real_bitrate)
    });
  }
  return entries;
}

// 取分辨率最高的那档，分辨率相同再比码率。
export function pickBestVideoEntry(payload: unknown): DoubaoVideoEntry | null {
  let best: DoubaoVideoEntry | null = null;
  for (const candidate of listVideoEntries(payload)) {
    if (!best || isHigherQuality(candidate, best)) best = candidate;
  }
  return best;
}

// 一份 video_info 响应里所有档位的对象 id。用原样的 fallback_api（logo_type 还是
// watermarked）请求一次，拿到的就是播放器在用的那几档，它们的对象 id 正好能和卡片上
// <video> 的直链对号 —— 无水印那档换了转码，对象 id 和播放的那条不一定是同一个。
export async function resolveVideoObjectIds(payload: unknown): Promise<string[]> {
  const keySeed = findKeySeed(payload);
  const ids: string[] = [];
  for (const entry of listVideoEntries(payload)) {
    const url = await decodeMainUrl(entry.token, keySeed);
    const objectId = url ? videoObjectIdOf(url) : "";
    if (objectId && !ids.includes(objectId)) ids.push(objectId);
  }
  return ids;
}

function isHigherQuality(candidate: DoubaoVideoEntry, current: DoubaoVideoEntry): boolean {
  const candidatePixels = candidate.width * candidate.height;
  const currentPixels = current.width * current.height;
  if (candidatePixels !== currentPixels) return candidatePixels > currentPixels;
  return candidate.bitrate > current.bitrate;
}

// key_seed 可能是字段，也可能挂在某个地址的 query 上，两种都认。
export function findKeySeed(value: unknown, depth = 0): string {
  if (depth > 10 || value == null) return "";
  if (typeof value === "string") {
    const inQuery = value.match(/(?:^|[?&])key_seed=([^&"'<>\\\s]+)/i);
    if (inQuery) return decodeURIComponent(inQuery[1]!);
    const inJson = value.match(/["']key_seed["']\s*:\s*["']([^"']+)/i);
    return inJson ? decodeURIComponent(inJson[1]!) : "";
  }
  if (typeof value !== "object") return "";
  const node = value as Record<string, unknown>;
  if (typeof node.key_seed === "string" && node.key_seed.trim()) return node.key_seed.trim();
  for (const child of Object.values(node)) {
    const hit = findKeySeed(child, depth + 1);
    if (hit) return hit;
  }
  return "";
}

// 一份 video_info 响应 -> 无水印直链。取不到就返回 null，由调用方退回原来的下载路径。
export async function resolveUnwatermarkedVideo(payload: unknown): Promise<DoubaoUnwatermarkedVideo | null> {
  const entry = pickBestVideoEntry(payload);
  if (!entry) return null;
  const url = await decodeMainUrl(entry.token, findKeySeed(payload));
  if (!url) return null;
  return { url, width: entry.width, height: entry.height, bitrate: entry.bitrate };
}

// CDN 路径里那段 32 位十六进制是这条视频在对象存储上的 id，同一条视频的不同转码
// （带台标 / 不带台标）通常落在同一个 id 下，所以拿它当对号的第一优先依据。
export function videoObjectIdOf(url: string): string {
  for (const segment of url.split(/[/?&=]/)) {
    if (/^[0-9a-f]{32}$/i.test(segment)) return segment.toLowerCase();
  }
  return "";
}

// 时长字段各接口写法不一，秒和毫秒都出现过：超过 600 的一律按毫秒算（生成的视频都是十几秒）。
export function findVideoDuration(payload: unknown, depth = 0): number {
  if (depth > 8 || payload == null || typeof payload !== "object") return 0;
  const node = payload as Record<string, unknown>;
  for (const key of ["duration", "video_duration", "vduration", "duration_ms"]) {
    const seconds = durationSeconds(node[key]);
    if (seconds > 0) return seconds;
  }
  for (const child of Object.values(node)) {
    const hit = findVideoDuration(child, depth + 1);
    if (hit > 0) return hit;
  }
  return 0;
}

function durationSeconds(value: unknown): number {
  const parsed = numberOf(value);
  if (!(parsed > 0)) return 0;
  return parsed > 600 ? parsed / 1000 : parsed;
}

// 同一条视频在一页聊天记录里会被收成好几条候选：消息流每刷新一次就带一份新签名的
// fallback_api，指向的却是同一条视频。所以判「唯一」要先按视频身份去重，而不是数候选
// 条数 —— 之前正是因为 `=== 1` 这个判断，两条同一视频的候选直接把整条路径判成对不上号。
function videoIdentity(video: DoubaoResolvedVideo): string {
  const ids = video.objectIds && video.objectIds.length > 0 ? [...video.objectIds].sort().join(",") : "";
  return ids || video.objectId || video.fallbackApi;
}

// 一组候选如果全是同一条视频，就返回其中一条；混着不同视频则返回 null。
function soleVideo<T extends DoubaoResolvedVideo>(candidates: readonly T[]): T | null {
  if (candidates.length === 0) return null;
  const identity = videoIdentity(candidates[0]!);
  for (const candidate of candidates) {
    if (videoIdentity(candidate) !== identity) return null;
  }
  return candidates[0]!;
}

// 卡片量到的对象 id 来自带台标的播放流，所以先比 objectIds（带台标那几档），
// 再比 objectId（无水印那档）—— 有时两边转码落在同一个 id 下。
function hasObjectId(video: DoubaoResolvedVideo, objectId: string): boolean {
  if (video.objectIds && video.objectIds.includes(objectId)) return true;
  return video.objectId === objectId;
}

// 一页聊天记录往前翻会翻出好几条视频，候选的先后顺序完全不能当依据（之前就是照着
// 「最新一条」猜，结果存下了历史里另一条视频）。这里只认能对上号的：对不上就返回 null，
// 由调用方老老实实退回页面自己那条带台标的下载 —— 拿错视频比带水印严重得多。
export function matchResolvedVideo<T extends DoubaoResolvedVideo>(
  candidates: readonly T[],
  target: DoubaoVideoTarget | null
): DoubaoVideoMatch<T> | null {
  if (candidates.length === 0) return null;
  let pool = candidates;
  if (target) {
    // message_id 是两边唯一同源的标识：响应里 fallback_api 归在哪条消息下，DOM 卡片
    // 祖先上就挂着同一个 data-message-id。对上了就不必再看那些间接指纹。
    if (target.messageId) {
      const sameMessage = pool.filter(candidate => candidate.messageId === target.messageId);
      const sole = soleVideo(sameMessage);
      if (sole) return { video: sole, reason: "message_id" };
      // 同一条消息下居然收到了不同视频（一条消息里多个视频），那就只在这几条里继续挑。
      if (sameMessage.length > 0) pool = sameMessage;
    }
    if (target.objectId) {
      const sameObject = soleVideo(pool.filter(candidate => hasObjectId(candidate, target.objectId)));
      if (sameObject) return { video: sameObject, reason: "object_id" };
    }
    const sameSize = target.width > 0 && target.height > 0
      ? pool.filter(candidate => candidate.width === target.width && candidate.height === target.height)
      : pool;
    if (target.duration > 0) {
      const sameDuration = soleVideo(sameSize.filter(candidate =>
        candidate.duration > 0 && Math.abs(candidate.duration - target.duration) <= DURATION_TOLERANCE_SECONDS));
      if (sameDuration) return { video: sameDuration, reason: "duration" };
    }
    const bySize = soleVideo(sameSize);
    if (bySize) return { video: bySize, reason: "size" };
  }
  // 所有候选都指向同一条视频，那它必然是页面上这条。
  const only = soleVideo(pool);
  return only ? { video: only, reason: "only_candidate" } : null;
}

export async function decodeMainUrl(token: string, keySeed = ""): Promise<string> {
  if (isHttpUrl(token)) return token;
  const plain = base64Url(token);
  if (plain) return plain;
  if (token.startsWith("qAAB") && keySeed) return decodeQaabToken(token, keySeed);
  return "";
}

// WebCrypto 的入参要求底层是 ArrayBuffer（不接受 SharedArrayBuffer），
// 所以下面这些字节工具统一用这个别名，省得每处都断言。
type Bytes = Uint8Array<ArrayBuffer>;

function base64Url(token: string): string {
  const bytes = base64DecodeLoose(token);
  const text = bytes ? asciiUrlFromBytes(bytes) : "";
  return isHttpUrl(text) ? text : "";
}

// main_url 的 base64 有三种写法：标准、把 + / = 换成 $ @ #、以及换成 _ / . 的变体。
function base64DecodeLoose(text: string): Bytes | null {
  const input = String(text ?? "").trim();
  const variants = [
    input,
    input.replace(/[$@#]/g, char => ({ $: "_", "@": "/", "#": "." })[char] ?? char),
    input.replace(/[$@#]/g, char => ({ $: "+", "@": "/", "#": "=" })[char] ?? char)
  ];
  for (const candidate of new Set(variants)) {
    if (!candidate) continue;
    try {
      const padded = candidate + "=".repeat((4 - (candidate.length % 4)) % 4);
      const binary = atob(padded.replace(/-/g, "+").replace(/_/g, "/"));
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
      return bytes;
    } catch {
      // 换下一种写法再试。
    }
  }
  return null;
}

// 解出来必须是可打印 ASCII，否则说明 key/iv 猜错了，当成失败。
function asciiUrlFromBytes(bytes: Bytes): string {
  if (bytes.length === 0) return "";
  for (const byte of bytes) {
    if (byte !== 9 && byte !== 10 && byte !== 13 && (byte < 32 || byte > 126)) return "";
  }
  return new TextDecoder().decode(bytes);
}

// key/iv 都从 key_seed 派生：SHA-512(seed 前 32 字节) 接上固定盐再 SHA-512，
// 前 16 字节当 key、16~32 字节当 iv。密文前 4 字节是 a8 00 01 00 的头（base64 出来
// 正好是 "qAAB"），去掉头之后 key/iv 的组合线上出现过好几种，逐个试到解出地址为止。
async function decodeQaabToken(token: string, keySeed: string): Promise<string> {
  const data = base64DecodeLoose(token);
  const seed = base64DecodeLoose(keySeed);
  if (!data || !seed) return "";

  const seedDigest = new Uint8Array(await crypto.subtle.digest("SHA-512", seed.slice(0, 32)));
  const salted = concatBytes(seedDigest, hexToBytes(QAAB_SALT_HEX));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-512", salted));
  const key = digest.slice(0, 16);
  const iv = digest.slice(16, 32);

  const attempts: Array<{ payload: Bytes; key: Bytes; iv: Bytes }> = [];
  if (data.length >= 4 && data[0] === 0xa8 && data[1] === 0x00 && data[2] === 0x01 && data[3] === 0x00) {
    attempts.push({ payload: data.slice(4), key, iv });
    attempts.push({ payload: data.slice(4), key: iv, iv: key });
    if (data.length > 36) {
      attempts.push({ payload: data.slice(36), key, iv: data.slice(20, 36) });
      attempts.push({ payload: data.slice(36), key, iv });
    }
  } else {
    attempts.push({ payload: data, key, iv });
  }

  for (const attempt of attempts) {
    const url = await decryptAesCbcUrl(attempt.payload, attempt.key, attempt.iv);
    if (url) return url;
  }
  return "";
}

async function decryptAesCbcUrl(payload: Bytes, keyBytes: Bytes, ivBytes: Bytes): Promise<string> {
  if (payload.length === 0 || payload.length % 16 !== 0) return "";
  try {
    const key = await crypto.subtle.importKey("raw", keyBytes, "AES-CBC", false, ["decrypt"]);
    const plain = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-CBC", iv: ivBytes }, key, payload));
    const direct = asciiUrlFromBytes(plain);
    if (isHttpUrl(direct)) return direct;
    // WebCrypto 会自己剥 PKCS7；密文里再套一层 padding 时上面那步会留着尾巴。
    const stripped = asciiUrlFromBytes(stripPkcs7(plain));
    return isHttpUrl(stripped) ? stripped : "";
  } catch {
    return "";
  }
}

function stripPkcs7(bytes: Bytes): Bytes {
  const pad = bytes.at(-1) ?? 0;
  if (pad < 1 || pad > 16 || pad > bytes.length) return bytes;
  for (let index = bytes.length - pad; index < bytes.length; index += 1) {
    if (bytes[index] !== pad) return bytes;
  }
  return bytes.slice(0, bytes.length - pad);
}

function hexToBytes(hex: string): Bytes {
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function concatBytes(first: Bytes, second: Bytes): Bytes {
  const bytes = new Uint8Array(first.length + second.length);
  bytes.set(first, 0);
  bytes.set(second, first.length);
  return bytes;
}

// fallback_api 常常被转义好几层塞进 JSON 字符串里，先反转义再判断域名。
function decodeJsonEscapedFragment(value: string): string {
  let text = value;
  for (let round = 0; round < 3; round += 1) {
    try {
      const decoded = JSON.parse(`"${text.replace(/"/g, '\\"')}"`) as unknown;
      if (typeof decoded !== "string" || decoded === text) break;
      text = decoded;
    } catch {
      break;
    }
  }
  return text.replace(/\\u0026/g, "&").replace(/\\\//g, "/");
}

function parseJsonString(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function httpHostname(value: string): string {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.hostname.toLowerCase() : "";
  } catch {
    return "";
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asObject(value: unknown): Record<string, unknown> {
  return isObject(value) ? value : {};
}

function numberOf(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}
