import { describe, expect, it } from "vitest";
import rulesJson from "../src/doubao-image-rules.json";
import { isRawImageUrl, isWatermarkedImageUrl } from "../src/doubaoWatermark.js";

// declarativeNetRequest 的正则编译后有 2KB 上限，RE2 实际只分到约一百多条指令的预算。
// 之前把整条 URL（含 `.*` 和签名参数）写进 regexFilter，Chrome 直接跳过规则并在
// chrome://extensions 报 "exceeded the 2KB memory limit"。这里把长度也当断言，防止
// 以后又被合并成一条长正则。
const MAX_REGEX_LENGTH = 60;

interface Rule {
  id: number;
  priority: number;
  action: { type: string; redirect: { regexSubstitution: string } };
  condition: {
    regexFilter: string;
    isUrlFilterCaseSensitive?: boolean;
    requestDomains?: string[];
    resourceTypes: string[];
  };
}

const rules: Rule[] = rulesJson;

const VALID_RESOURCE_TYPES = new Set([
  "main_frame", "sub_frame", "stylesheet", "script", "image", "font", "object",
  "xmlhttprequest", "ping", "csp_report", "media", "websocket", "webtransport", "webbundle", "other"
]);

const SIGN = "?rk3s=8e244e95&x-expires=1793404800&x-signature=abc%3D";
const PREFIX = "https://p9-flow-imagex-sign.byteimg.com/tos-cn-i-a9rns2rl98/rc_gen_image/7f3c1d.png~tplv-a9rns2rl98-";
const raw = `${PREFIX}image_raw_b.png${SIGN}`;

// 只替换命中的那一段，URL 前缀和签名参数由 Chrome 原样保留。
function applyRules(url: string): string | null {
  for (const rule of rules) {
    const match = new RegExp(rule.condition.regexFilter).exec(url);
    if (!match) continue;
    const replacement = rule.action.redirect.regexSubstitution.replace(
      /\\([0-9])/g,
      (_, digit: string) => match[Number(digit)] ?? ""
    );
    return url.slice(0, match.index) + replacement + url.slice(match.index + match[0].length);
  }
  return null;
}

describe("豆包图片重定向规则", () => {
  it("每条规则都足够短，且不含会撑爆编译预算的 .*", () => {
    expect(rules.length).toBeGreaterThan(0);
    for (const rule of rules) {
      expect(rule.condition.regexFilter.length, rule.condition.regexFilter).toBeLessThanOrEqual(MAX_REGEX_LENGTH);
      expect(rule.condition.regexFilter).not.toContain(".*");
      expect(() => new RegExp(rule.condition.regexFilter)).not.toThrow();
    }
  });

  it("规则 id 唯一，动作和条件字段合法", () => {
    expect(new Set(rules.map(rule => rule.id)).size).toBe(rules.length);
    for (const rule of rules) {
      expect(rule.action.type).toBe("redirect");
      expect(rule.condition.requestDomains).toEqual(["byteimg.com"]);
      expect(rule.condition.isUrlFilterCaseSensitive).toBe(true);
      for (const type of rule.condition.resourceTypes) expect(VALID_RESOURCE_TYPES).toContain(type);
    }
  });

  it("线上出现过的水印模板都会被重定向到原图", () => {
    for (const template of [
      "image_pre_watermark_1_5b.png",
      "downsize_watermark_1_5_b.png",
      "hcg_watermark_1_5.png",
      "image_dld_watermark_1_5b.png",
      "img_pre_mark_1_5b_resize.png",
      "img_pre_mark_1_5b_resize.heic",
      "ds_wm.png",
      "hcg_wm.png",
      "i_pre_wm.png",
      "i_dld_wm.png"
    ]) {
      expect(applyRules(`${PREFIX}${template}${SIGN}`), template).toBe(raw);
    }
  });

  it("不动原图和无关图片", () => {
    expect(applyRules(raw)).toBeNull();
    expect(applyRules("https://www.doubao.com/logo.png")).toBeNull();
    expect(applyRules(`${PREFIX}image_ori.png${SIGN}`)).toBeNull();
  });

  it("规则命中的地址与页面脚本的判定一致", () => {
    const hit = `${PREFIX}image_dld_watermark_1_5b.png${SIGN}`;
    expect(isWatermarkedImageUrl(hit)).toBe(true);
    expect(isRawImageUrl(applyRules(hit) as string)).toBe(true);
  });
});
