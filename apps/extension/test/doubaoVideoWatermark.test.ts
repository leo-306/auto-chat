import { describe, expect, it } from "vitest";
import {
  collectFallbackApis,
  collectFallbackEntries,
  countFallbackApiKeys,
  decodeMainUrl,
  findKeySeed,
  findVideoDuration,
  isAllowedFallbackApiUrl,
  isDoubaoMediaResponseUrl,
  isVideoInfoRequestUrl,
  jsonMayContainFallbackApi,
  matchResolvedVideo,
  pickBestVideoEntry,
  resolveUnwatermarkedVideo,
  resolveVideoObjectIds,
  unwatermarkedVideoInfoUrl,
  videoIdOf,
  videoObjectIdOf
} from "../src/doubaoVideoWatermark.js";
import type { DoubaoResolvedVideo } from "../src/doubaoVideoWatermark.js";

// 线上真实形状：fallback_api 是服务端签好名的视频信息接口，签名只覆盖 sign/expire 这些，
// 不覆盖 logo_type，所以只换清晰度/台标参数依然能用。
const FALLBACK_API = "https://www.doubao.com/samantha/media/video_info" +
  "?video_id=v0abc&sign=deadbeef&expire=1793404800&logo_type=watermarked&codec_type=0";

describe("无水印视频信息地址", () => {
  it("只换 logo_type/channel/codec_type，签名参数原样保留", () => {
    const url = new URL(unwatermarkedVideoInfoUrl(FALLBACK_API));
    expect(url.searchParams.get("logo_type")).toBe("unwatermarked");
    expect(url.searchParams.get("channel")).toBe("no");
    expect(url.searchParams.get("codec_type")).toBe("8");
    expect(url.searchParams.get("sign")).toBe("deadbeef");
    expect(url.searchParams.get("expire")).toBe("1793404800");
    expect(url.searchParams.get("video_id")).toBe("v0abc");
  });

  it("签名值里没转义的 / : + 原样保留（URLSearchParams 会把它们转义掉）", () => {
    const raw = "https://www.doubao.com/samantha/media/video_info" +
      "?video_id=v0abc&sign=a/b:c+d&logo_type=watermarked&codec_type=0";
    expect(unwatermarkedVideoInfoUrl(raw)).toBe(
      "https://www.doubao.com/samantha/media/video_info" +
      "?video_id=v0abc&sign=a/b:c+d&logo_type=unwatermarked&codec_type=8&channel=no"
    );
  });
});

describe("fallback_api 域名白名单", () => {
  it("只认豆包自己那几个域", () => {
    for (const host of ["www.doubao.com", "doubao.com", "api.dola.com", "byteintlapi.com", "x.snssdk.com"]) {
      expect(isAllowedFallbackApiUrl(`https://${host}/samantha/media/video_info`), host).toBe(true);
    }
  });

  it("拒绝第三方域名和非 http 协议", () => {
    for (const url of [
      "https://evil.com/samantha/media/video_info",
      "https://notdoubao.com/video_info",
      "https://doubao.com.evil.com/video_info",
      "ftp://www.doubao.com/video_info",
      "not a url"
    ]) {
      expect(isAllowedFallbackApiUrl(url), url).toBe(false);
    }
  });
});
describe("认出页面自己发的 video_info 请求", () => {
  it("路径像 video_info 且带 video_id/logo_type 的豆包地址才算", () => {
    expect(isVideoInfoRequestUrl(FALLBACK_API)).toBe(true);
    expect(isVideoInfoRequestUrl("https://www.doubao.com/samantha/media/video_info?video_id=v0abc")).toBe(true);
    // 域名不对、路径不对、缺少 video_id/logo_type 的都不算。
    expect(isVideoInfoRequestUrl("https://evil.com/samantha/media/video_info?video_id=v0abc")).toBe(false);
    expect(isVideoInfoRequestUrl("https://www.doubao.com/im/chain/single?cursor=1")).toBe(false);
    expect(isVideoInfoRequestUrl("https://www.doubao.com/samantha/media/video_info")).toBe(false);
  });

  it("聊天记录相关的接口才做响应体兜底扫描", () => {
    expect(isDoubaoMediaResponseUrl("https://www.doubao.com/im/chain/single")).toBe(true);
    expect(isDoubaoMediaResponseUrl("https://www.doubao.com/samantha/media/video_info?video_id=v0abc")).toBe(true);
    expect(isDoubaoMediaResponseUrl("https://www.doubao.com/static/main.js")).toBe(false);
    expect(isDoubaoMediaResponseUrl("https://evil.com/im/chain/single")).toBe(false);
  });

  it("从候选地址上取 video_id 只为进日志", () => {
    expect(videoIdOf(FALLBACK_API)).toBe("v0abc");
    expect(videoIdOf("not a url")).toBe("");
  });
});

describe("从接口响应里收集 fallback_api", () => {
  it("不含 fallback_api 的响应直接跳过深度遍历", () => {
    expect(jsonMayContainFallbackApi('{"data":{"video_list":{}}}')).toBe(false);
    expect(jsonMayContainFallbackApi(`{"fallback_api":"${FALLBACK_API}"}`)).toBe(true);
    expect(jsonMayContainFallbackApi(null)).toBe(false);
  });

  it("能从嵌套成字符串的消息内容里捞出来，并反转义 \\u0026 和 \\/", () => {
    const escaped = "https:\\/\\/www.doubao.com\\/samantha\\/media\\/video_info?video_id=v0abc\\u0026sign=deadbeef";
    const payload = { messages: [{ content: JSON.stringify({ video: { fallback_api: escaped } }) }] };
    expect(collectFallbackApis(payload)).toEqual([
      "https://www.doubao.com/samantha/media/video_info?video_id=v0abc&sign=deadbeef"
    ]);
  });

  it("那层字符串 parse 不出来时靠原文正则兜底", () => {
    const rawText = `event: message\ndata: {\\"fallback_api\\":\\"${FALLBACK_API}\\"}`;
    expect(collectFallbackApis(null, rawText)).toEqual([FALLBACK_API]);
  });

  it("去重且保持出现顺序，第三方域名不收", () => {
    const other = "https://api.dola.com/samantha/media/video_info?video_id=v0def";
    const payload = {
      list: [
        { fallback_api: FALLBACK_API },
        { fallback_api: "https://evil.com/samantha/media/video_info" },
        { fallback_api: other },
        { fallback_api: FALLBACK_API }
      ]
    };
    expect(collectFallbackApis(payload)).toEqual([FALLBACK_API, other]);
  });

  it("循环引用不会转不出来", () => {
    const node: Record<string, unknown> = { fallback_api: FALLBACK_API };
    node.self = node;
    expect(collectFallbackApis(node)).toEqual([FALLBACK_API]);
  });

  // 线上 /im/chain/single 的响应体里，消息内容是转义了好几轮的字符串，逐层 parse 走不通：
  // 日志里 body_hit 命中了 fallback_api 字面量，结构遍历却一条都没捞到。
  it("转义好几轮、parse 不出来的响应也能捞出来", () => {
    const twice = FALLBACK_API.replace(/\//g, "\\\\/").replace(/&/g, "\\\\u0026");
    const rawText = `{"data":{"messages":[{"content":"{\\\\"video\\\\":{\\\\"fallback_api\\\\":\\\\"${twice}\\\\"}}"}]}}`;
    expect(rawText).not.toContain('"fallback_api":"https');
    expect(collectFallbackApis(null, rawText)).toEqual([FALLBACK_API]);
  });

  it("按响应里最近的 message_id 认领归属", () => {
    const other = "https://api.dola.com/samantha/media/video_info?video_id=v0def";
    const rawText = `{"messages":[` +
      `{"message_id":"53994836681651714","content":"{\\"fallback_api\\":\\"${FALLBACK_API}\\"}"},` +
      `{"message_id":"53994836681651999","content":"{\\"fallback_api\\":\\"${other}\\"}"}` +
      `]}`;
    expect(collectFallbackEntries(null, rawText)).toEqual([
      { url: FALLBACK_API, messageId: "53994836681651714" },
      { url: other, messageId: "53994836681651999" }
    ]);
  });

  it("结构遍历拿到的 message_id 会补到正则先捞出的那条上", () => {
    const payload = { data: { message_id: "53994836681651714", video: { fallback_api: FALLBACK_API } } };
    expect(collectFallbackEntries(payload)).toEqual([
      { url: FALLBACK_API, messageId: "53994836681651714" }
    ]);
  });

  // 19 位的消息 id 超出 double 的安全整数范围，JSON.parse 出来已经丢了末位（…714 → …710）。
  it("数字形态的大消息 id 不采信，改由原文正则给出精确值", () => {
    const payload = { data: { message_id: 53994836681651714, video: { fallback_api: FALLBACK_API } } };
    expect(collectFallbackEntries(payload)).toEqual([{ url: FALLBACK_API, messageId: "" }]);
    const rawText = `{"message_id":53994836681651714,"fallback_api":"${FALLBACK_API}"}`;
    expect(collectFallbackEntries(payload, rawText)).toEqual([
      { url: FALLBACK_API, messageId: "53994836681651714" }
    ]);
  });

  it("键出现次数用来判断提取是不是漏了", () => {
    expect(countFallbackApiKeys(`{"a":{"fallback_api":"x"},"b":{"fallback_api":"y"}}`)).toBe(2);
    expect(countFallbackApiKeys(null)).toBe(0);
  });
});
describe("视频指纹", () => {
  it("从 CDN 路径里认出 32 位十六进制的对象 id", () => {
    expect(videoObjectIdOf("https://v3-default.douyin.com/3C440FB7421AD95ABF1448E6FDC331AA/video.mp4?sign=x"))
      .toBe("3c440fb7421ad95abf1448e6fdc331aa");
    // 长度不对、非十六进制都不算。
    expect(videoObjectIdOf("https://v3-default.douyin.com/abc123/video.mp4")).toBe("");
    expect(videoObjectIdOf("https://v3-default.douyin.com/zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz/v.mp4")).toBe("");
  });

  it("时长秒和毫秒都认，字段藏多深都能翻出来", () => {
    expect(findVideoDuration({ data: { video_info: { duration: 10.4 } } })).toBeCloseTo(10.4);
    // 超过 600 的按毫秒算。
    expect(findVideoDuration({ list: [{ duration: 10_400 }] })).toBeCloseTo(10.4);
    expect(findVideoDuration({ a: { b: { duration_ms: 5_000 } } })).toBe(5);
    expect(findVideoDuration({ nothing: true })).toBe(0);
  });
});

describe("把候选和页面上那条视频对号", () => {
  const video = (patch: Partial<DoubaoResolvedVideo>): DoubaoResolvedVideo => ({
    fallbackApi: FALLBACK_API,
    width: 720,
    height: 1280,
    bitrate: 2_000_000,
    duration: 10,
    objectId: "",
    ...patch
  });
  const beach = video({ fallbackApi: "a", objectId: "a".repeat(32), duration: 10 });
  const cat = video({ fallbackApi: "b", objectId: "b".repeat(32), width: 1280, height: 720, duration: 5 });

  it("对象 id 一致时直接认这条", () => {
    const target = { width: 0, height: 0, duration: 0, objectId: "a".repeat(32) };
    expect(matchResolvedVideo([cat, beach], target)).toEqual({ video: beach, reason: "object_id" });
  });

  // message_id 是两边唯一同源的标识，比宽高/时长/对象 id 都硬。
  it("message_id 对上时优先认它，宽高时长全对不上也算", () => {
    const tagged = video({ fallbackApi: "m", objectId: "m".repeat(32), messageId: "53994836681651714" });
    const target = { width: 0, height: 0, duration: 0, objectId: "", messageId: "53994836681651714" };
    expect(matchResolvedVideo([cat, beach, tagged], target)).toEqual({ video: tagged, reason: "message_id" });
  });

  it("同一条消息的多份候选（刷新一次换一份签名）仍然认得出来", () => {
    const first = video({ fallbackApi: "m1", objectId: "m".repeat(32), messageId: "530001" });
    const again = video({ fallbackApi: "m2", objectId: "m".repeat(32), messageId: "530001" });
    const target = { width: 0, height: 0, duration: 0, objectId: "", messageId: "530001" };
    expect(matchResolvedVideo([first, again, cat], target)).toEqual({ video: first, reason: "message_id" });
  });

  it("message_id 对不上就退回指纹层，不会误认成同消息那条", () => {
    const tagged = video({ fallbackApi: "m", objectId: "m".repeat(32), messageId: "530001" });
    const target = { width: 720, height: 1280, duration: 10, objectId: "", messageId: "530999" };
    expect(matchResolvedVideo([tagged, cat], target)).toEqual({ video: tagged, reason: "duration" });
  });

  it("对象 id 对不上时按宽高，再不行按时长", () => {
    const bySize = matchResolvedVideo([cat, beach], { width: 720, height: 1280, duration: 0, objectId: "" });
    expect(bySize).toEqual({ video: beach, reason: "size" });

    const sameSize = video({ fallbackApi: "c", duration: 20 });
    const byDuration = matchResolvedVideo([sameSize, beach], {
      width: 720, height: 1280, duration: 10.2, objectId: ""
    });
    expect(byDuration).toEqual({ video: beach, reason: "duration" });
  });

  it("只有一条候选时无条件认它", () => {
    expect(matchResolvedVideo([cat], null)).toEqual({ video: cat, reason: "only_candidate" });
  });

  it("对不上号就返回 null，绝不在多条候选里瞎猜", () => {
    // 两条同宽高同时长、但对象 id 不同的候选，指纹分不开 —— 宁可退回带水印的下载。
    const twin = video({ fallbackApi: "c", objectId: "c".repeat(32) });
    expect(matchResolvedVideo([beach, twin], { width: 720, height: 1280, duration: 10, objectId: "" })).toBeNull();
    // 页面那条量不到指纹，候选又是两条不同视频。
    expect(matchResolvedVideo([beach, cat], null)).toBeNull();
    expect(matchResolvedVideo([], { width: 720, height: 1280, duration: 10, objectId: "" })).toBeNull();
  });

  // 消息流每刷新一次就带一份新签名的 fallback_api，同一条视频于是被收成好几条候选。
  // 之前 `候选数 === 1` 的判断在这里直接判成对不上号，点下载就退回了带水印的那条。
  it("同一条视频的多份候选按身份去重后仍然认得出来", () => {
    const again = video({ fallbackApi: "a-again", objectId: "a".repeat(32), duration: 10 });
    const target = { width: 720, height: 1280, duration: 10, objectId: "" };
    expect(matchResolvedVideo([beach, again], target)).toEqual({ video: beach, reason: "duration" });
    expect(matchResolvedVideo([beach, again], null)).toEqual({ video: beach, reason: "only_candidate" });
  });

  it("卡片量到的是带台标那档的对象 id，落在 objectIds 里也算对上", () => {
    // 无水印那档换了转码，objectId 和播放器在用的那条不是同一个。
    const withVariants = video({
      fallbackApi: "d",
      objectId: "d".repeat(32),
      objectIds: ["e".repeat(32), "f".repeat(32)]
    });
    const target = { width: 0, height: 0, duration: 0, objectId: "f".repeat(32) };
    expect(matchResolvedVideo([cat, withVariants], target)).toEqual({ video: withVariants, reason: "object_id" });
  });
});

describe("挑清晰度最高的那档", () => {
  it("先比分辨率，分辨率相同再比码率", () => {
    const payload = {
      data: {
        video_info: {
          data: {
            video_list: {
              video_1: { main_url: "https://cdn/low.mp4", vwidth: 720, vheight: 1280, bitrate: 900_000 },
              video_2: { main_url: "https://cdn/high.mp4", vwidth: 1080, vheight: 1920, bitrate: 800_000 },
              video_3: { main_url: "https://cdn/high2.mp4", vwidth: 1080, vheight: 1920, bitrate: 2_400_000 }
            }
          }
        }
      }
    };
    expect(pickBestVideoEntry(payload)).toEqual({
      token: "https://cdn/high2.mp4",
      width: 1080,
      height: 1920,
      bitrate: 2_400_000
    });
  });

  it("没有 video_list 时退化到当前这一层，play_url 也认", () => {
    expect(pickBestVideoEntry({ play_url: "https://cdn/only.mp4", width: 480, height: 640 })).toEqual({
      token: "https://cdn/only.mp4",
      width: 480,
      height: 640,
      bitrate: 0
    });
  });

  it("一条可用地址都没有时返回 null", () => {
    expect(pickBestVideoEntry({ data: { video_list: { video_1: { main_url: "  " } } } })).toBeNull();
  });
});

describe("key_seed", () => {
  it("字段和挂在地址 query 上两种写法都认", () => {
    expect(findKeySeed({ data: { key_seed: " seedValue== " } })).toBe("seedValue==");
    expect(findKeySeed({ url: "https://cdn/x.mp4?key_seed=seed%3D%3D&a=1" })).toBe("seed==");
    expect(findKeySeed({ nothing: 1 })).toBe("");
  });
});
// main_url 的三种形态。qAAB 那条是在测试里按线上同样的方式加密出来的：
// 盐在这里刻意写死一份，改动源码里的常量就会立刻测挂。
const QAAB_SALT_HEX =
  "4dd4c2e6b83162090e52b3c7a6733ba4" +
  "1cb2462b829ab58a196b39db57177524" +
  "f49baf7f08e8d68d26a72e37c1a95a2f" +
  "1f05a51892aef2949732b62a38aadd58";

// 长度刻意让 base64 带上 "=" 补位，好走到把 + / = 换成 $ @ # 的那个变体。
const PLAIN_URL = "https://v26-default.douyinvod.com/tos-cn/video/abc123/def.mp4?a=1&b=2&c=3";

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function textToBase64(text: string): string {
  return bytesToBase64(new TextEncoder().encode(text));
}

function looseBase64(text: string): string {
  return textToBase64(text)
    .replace(/\+/g, "$").replace(/\//g, "@").replace(/=/g, "#");
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

async function makeQaabToken(url: string, seed: Uint8Array): Promise<string> {
  const seedDigest = new Uint8Array(await crypto.subtle.digest("SHA-512", seed.slice(0, 32)));
  const salt = hexToBytes(QAAB_SALT_HEX);
  const salted = new Uint8Array(seedDigest.length + salt.length);
  salted.set(seedDigest, 0);
  salted.set(salt, seedDigest.length);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-512", salted));
  const key = await crypto.subtle.importKey("raw", digest.slice(0, 16), "AES-CBC", false, ["encrypt"]);
  const cipher = new Uint8Array(await crypto.subtle.encrypt(
    { name: "AES-CBC", iv: digest.slice(16, 32) },
    key,
    new TextEncoder().encode(url)
  ));
  // 头四个字节 a8 00 01 00 base64 出来正好是 "qAAB"。
  const token = new Uint8Array(4 + cipher.length);
  token.set([0xa8, 0x00, 0x01, 0x00], 0);
  token.set(cipher, 4);
  return bytesToBase64(token);
}

describe("解 main_url", () => {
  it("本身是 http 地址就原样返回", async () => {
    await expect(decodeMainUrl(PLAIN_URL)).resolves.toBe(PLAIN_URL);
  });

  it("标准 base64 和 $@# 变体都能解", async () => {
    const standard = textToBase64(PLAIN_URL);
    await expect(decodeMainUrl(standard)).resolves.toBe(PLAIN_URL);
    const loose = looseBase64(PLAIN_URL);
    expect(loose).toMatch(/[$@#]/);
    await expect(decodeMainUrl(loose)).resolves.toBe(PLAIN_URL);
  });

  it("qAAB 密文用 key_seed 派生 key/iv 解出地址", async () => {
    const seed = new Uint8Array(32);
    for (let index = 0; index < seed.length; index += 1) seed[index] = (index * 7 + 11) & 0xff;
    const keySeed = bytesToBase64(seed);
    const token = await makeQaabToken(PLAIN_URL, seed);
    expect(token.startsWith("qAAB")).toBe(true);
    await expect(decodeMainUrl(token, keySeed)).resolves.toBe(PLAIN_URL);
  });

  it("没有 key_seed 或 seed 不对时当成失败，交给调用方退回原路径", async () => {
    const seed = new Uint8Array(32).fill(3);
    const token = await makeQaabToken(PLAIN_URL, seed);
    await expect(decodeMainUrl(token)).resolves.toBe("");
    await expect(decodeMainUrl(token, bytesToBase64(new Uint8Array(32).fill(9))))
      .resolves.toBe("");
  });
});

describe("一份 video_info 响应到无水印直链", () => {
  it("挑最高清那档并解出地址", async () => {
    const payload = {
      data: {
        key_seed: bytesToBase64(new Uint8Array(32).fill(5)),
        video_info: {
          data: {
            video_list: {
              video_1: { main_url: looseBase64(PLAIN_URL), vwidth: 1080, vheight: 1920, bitrate: 2_000_000 },
              video_2: { main_url: "https://cdn/low.mp4", vwidth: 480, vheight: 854, bitrate: 500_000 }
            }
          }
        }
      }
    };
    await expect(resolveUnwatermarkedVideo(payload)).resolves.toEqual({
      url: PLAIN_URL,
      width: 1080,
      height: 1920,
      bitrate: 2_000_000
    });
  });

  it("解不出地址时返回 null", async () => {
    await expect(resolveUnwatermarkedVideo({ data: { video_list: {} } })).resolves.toBeNull();
  });
});

describe("收集一份响应里所有档位的对象 id", () => {
  it("每一档都解一次地址，去重后按出现顺序给出", async () => {
    const objectA = "a".repeat(32);
    const objectB = "b".repeat(32);
    const payload = {
      data: {
        video_info: {
          data: {
            video_list: {
              video_1: { main_url: looseBase64(`https://cdn/tos-cn/${objectA}/low.mp4?a=1`) },
              video_2: { main_url: `https://cdn/tos-cn/${objectB}/high.mp4` },
              // 同一个对象的另一档，不重复收。
              video_3: { main_url: `https://cdn/tos-cn/${objectA}/mid.mp4` },
              // 解不出地址的那档跳过，不影响其他档。
              video_4: { main_url: "qAABnotDecodable" }
            }
          }
        }
      }
    };
    await expect(resolveVideoObjectIds(payload)).resolves.toEqual([objectA, objectB]);
  });
});




