import { describe, expect, it } from "vitest";
import {
  DoubaoRawImageIndex,
  doubaoImageKey,
  isRawImageUrl,
  isWatermarkedImageUrl,
  jsonMayContainImageUrls,
  swapToRawTemplate
} from "../src/doubaoWatermark.js";

// 线上真实形状：同一张图靠 /rc_gen_image/<文件名> 归组，尾部 tplv 模板名决定有无水印。
const SIGN = "?rk3s=8e244e95&x-expires=1793404800&x-signature=abc%3D";
const PREFIX = "https://p9-flow-imagex-sign.byteimg.com/tos-cn-i-a9rns2rl98/rc_gen_image/7f3c1d.png~tplv-a9rns2rl98-";

const raw = `${PREFIX}image_raw_b.png${SIGN}`;
const watermarked = `${PREFIX}image_dld_watermark_1_5b.png${SIGN}`;

describe("豆包图片 URL 分类", () => {
  it("认出线上出现过的所有水印模板", () => {
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
      expect(isWatermarkedImageUrl(`${PREFIX}${template}${SIGN}`), template).toBe(true);
    }
  });

  it("unpaid_image_raw_dld 里带 image_raw 也不算原图", () => {
    const trap = `${PREFIX}unpaid_image_raw_dld.png${SIGN}`;
    expect(isWatermarkedImageUrl(trap)).toBe(true);
    expect(isRawImageUrl(trap)).toBe(false);
  });

  it("原图模板才算原图", () => {
    expect(isRawImageUrl(raw)).toBe(true);
    expect(isRawImageUrl(`${PREFIX}image_raw.png${SIGN}`)).toBe(true);
    expect(isRawImageUrl(watermarked)).toBe(false);
  });

  it("按文件名归组同一张图的不同模板", () => {
    expect(doubaoImageKey(raw)).toBe("7f3c1d.png");
    expect(doubaoImageKey(watermarked)).toBe("7f3c1d.png");
    expect(doubaoImageKey("https://www.doubao.com/logo.png")).toBeNull();
  });
});

describe("模板名兜底替换", () => {
  it("只换模板段，签名参数原样保留", () => {
    expect(swapToRawTemplate(watermarked)).toBe(raw);
    expect(swapToRawTemplate(`${PREFIX}img_pre_mark_1_5b_resize.heic`)).toBe(`${PREFIX}image_raw_b.png`);
  });

  it("不动非水印 URL", () => {
    expect(swapToRawTemplate(raw)).toBeNull();
    expect(swapToRawTemplate("https://www.doubao.com/logo.png")).toBeNull();
  });
});

describe("原图索引", () => {
  it("接口给过原图地址时优先用它替换水印地址", () => {
    const index = new DoubaoRawImageIndex();
    expect(index.record(raw)).toBe(true);
    expect(index.rewrite(watermarked)).toBe(raw);
    expect(index.rewrite(raw)).toBe(raw);
  });

  it("没记录过也能靠换模板名兜底", () => {
    const index = new DoubaoRawImageIndex();
    expect(index.rewrite(watermarked)).toBe(raw);
  });

  it("不收录水印地址，也不动无关 URL", () => {
    const index = new DoubaoRawImageIndex();
    expect(index.record(watermarked)).toBe(false);
    expect(index.size).toBe(0);
    expect(index.rewrite("https://www.doubao.com/chat/123")).toBe("https://www.doubao.com/chat/123");
    expect(index.rewrite(`不是 URL ${raw}`)).toBe(`不是 URL ${raw}`);
  });

  it("同一张图的其它水印模板复用已记录的原图", () => {
    const index = new DoubaoRawImageIndex();
    index.record(raw);
    expect(index.rewrite(`${PREFIX}image_pre_watermark_1_5b.png`)).toBe(raw);
  });
});

describe("接口响应改写", () => {
  it("收集原图字段后把主图和缩略图都指向原图", () => {
    const response = {
      data: {
        items: [
          {
            image: {
              image_raw: { url: raw },
              url: watermarked,
              image_thumb: { url: `${PREFIX}downsize_watermark_1_5_b.png${SIGN}` },
              thumbnail: { url: `${PREFIX}hcg_watermark_1_5.png${SIGN}` }
            }
          }
        ]
      }
    };

    const index = new DoubaoRawImageIndex();
    index.absorb(response);

    const image = response.data.items[0].image;
    expect(image.url).toBe(raw);
    expect(image.image_thumb.url).toBe(raw);
    expect(image.thumbnail.url).toBe(raw);
  });

  it("原图字段和水印地址不在同一个对象里也能替换", () => {
    const response = {
      images: [{ image_raw_b: raw }],
      display: { cover: watermarked },
      list: [watermarked]
    };

    const index = new DoubaoRawImageIndex();
    index.absorb(response);

    expect(response.display.cover).toBe(raw);
    expect(response.list[0]).toBe(raw);
  });

  it("循环引用不会死循环", () => {
    const node: Record<string, unknown> = { url: watermarked };
    node.self = node;
    const index = new DoubaoRawImageIndex();
    index.absorb(node);
    expect(node.url).toBe(raw);
  });

  it("只对可能含图片地址的响应做深度遍历", () => {
    expect(jsonMayContainImageUrls(`{"a":"${raw}"}`)).toBe(true);
    expect(jsonMayContainImageUrls(`{"a":"${watermarked}"}`)).toBe(true);
    expect(jsonMayContainImageUrls('{"message":"hello"}')).toBe(false);
    expect(jsonMayContainImageUrls(undefined)).toBe(false);
  });
});
