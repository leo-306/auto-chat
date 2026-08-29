// 豆包生图的水印不是烧进像素里的，而是 CDN URL 尾部的 tplv 模板后缀决定的：
// 同一张图把 `~tplv-<hash>-image_dld_watermark_1_5b.png` 换成
// `~tplv-<hash>-image_raw_b.png`，拿到的就是同一张无水印原图（签名参数
// rk3s/x-expires 不跟模板绑定，所以只换模板名依然可用）。
//
// 这里只放纯逻辑：判断一个 URL 是原图还是水印图、从接口响应里收集原图地址、
// 把水印 URL 换成同一张图的原图。把它挂到页面的 JSON.parse / fetch / canvas
// 上的注入脚本在 doubaoWatermarkPage.ts。

// 原图模板：`image_raw`、`image_raw_b` 等。
const RAW_TEMPLATE = /~tplv-[^?#~]*image_raw[^?#~]*/;

// 带水印的模板全集（线上出现过的写法）。注意 `unpaid_image_raw_dld` 里也含
// `image_raw`，所以任何判断都必须先查水印再查原图，否则它会被误认成原图。
const WATERMARK_TEMPLATE =
  /~tplv-[^?#~]*(?:(?:image|img)_(?:pre|dld)_watermark|downsize_watermark|hcg_watermark|img_pre_mark|(?:ds|hcg|i_(?:pre|dld))_wm|unpaid_image_raw_dld)[^?#~]*/;

// 生图资源统一挂在 /rc_gen_image/ 下，用来把豆包生成的图片和站内其它图片区分开。
const GENERATED_IMAGE_PATH = /\/rc_gen_image\/[^?#\s"'{}[\]]+/i;

// 同一张图的所有模板变体共用这个文件名，拿它当「同一张图」的 key。
const IMAGE_KEY = /\/rc_gen_image\/([^/?#~]+\.(?:jpe?g|png|webp))/i;

// tplv 模板段，用于在没拿到接口原图地址时直接把模板名换成原图模板。
const TEMPLATE_SEGMENT = /~tplv-([a-z0-9]+)-[^?#~]+/i;

// 接口里原图地址出现过的字段名，值可能是字符串，也可能是 { url } 对象。
const RAW_URL_FIELDS = ["image_raw", "image_raw_b", "raw", "raw_url", "origin", "original", "original_url"];

// 同一个对象里跟着主图一起给出的低清/缩略字段，一并指向原图，避免页面拿缩略图导出。
const DERIVED_IMAGE_FIELDS = ["image_ori", "image_thumb", "image_thumbnail", "thumbnail", "detail"];

export function isUrlLike(value: string): boolean {
  if (value.trim() !== value) return false;
  if (/[\s"'{}[\]]/.test(value)) return false;
  return /^(?:https?:)?\/\//.test(value) || value.startsWith("data:image/");
}

export function isGeneratedImageUrl(value: string): boolean {
  return GENERATED_IMAGE_PATH.test(value);
}

export function isWatermarkedImageUrl(value: string): boolean {
  return WATERMARK_TEMPLATE.test(value);
}

export function isRawImageUrl(value: string): boolean {
  return !WATERMARK_TEMPLATE.test(value) && RAW_TEMPLATE.test(value);
}

export function doubaoImageKey(value: string): string | null {
  return value.match(IMAGE_KEY)?.[1] ?? null;
}

// 兜底：接口没给原图地址时，按 declarative_net_request 规则做的同一件事——
// 只换模板名。仅对已识别的水印模板动手，作用范围和那两条重定向规则一致。
export function swapToRawTemplate(value: string): string | null {
  if (!isWatermarkedImageUrl(value)) return null;
  const swapped = value.replace(TEMPLATE_SEGMENT, (_match, hash: string) => `~tplv-${hash}-image_raw_b.png`);
  return swapped === value ? null : swapped;
}

// 快速筛掉绝大多数与图片无关的 JSON 响应，避免每个接口都走一遍深度遍历。
export function jsonMayContainImageUrls(text: unknown): boolean {
  return typeof text === "string" &&
    (text.includes("image_raw") || text.includes("image_ori") || text.includes("watermark"));
}

// 记录「图片 key -> 原图 URL」，并用它改写水印 URL。
// 一个页面一个实例即可：豆包会话里同一张图的原图地址在接口响应里先出现，
// 之后展示和下载用的水印地址才用到。
export class DoubaoRawImageIndex {
  private readonly rawByKey = new Map<string, string>();

  get size(): number {
    return this.rawByKey.size;
  }

  record(value: string): boolean {
    if (!isUrlLike(value) || !isRawImageUrl(value)) return false;
    const key = doubaoImageKey(value);
    if (!key) return false;
    this.rawByKey.set(key, value);
    return true;
  }

  rawFor(value: string): string | null {
    const key = doubaoImageKey(value);
    return (key && this.rawByKey.get(key)) || null;
  }

  // 拿到干净原图地址：优先用接口给的，其次自己换模板名。返回 null 表示这个
  // URL 本来就不是需要处理的水印图。
  cleanUrlFor(value: string): string | null {
    if (!isUrlLike(value)) return null;
    if (isRawImageUrl(value)) return value;
    if (isWatermarkedImageUrl(value)) return this.rawFor(value) ?? swapToRawTemplate(value);
    if (isGeneratedImageUrl(value)) return this.rawFor(value);
    return null;
  }

  rewrite(value: string): string {
    if (!value) return value;
    return this.cleanUrlFor(value) ?? value;
  }

  // 先收集原图地址再改写：同一个响应里原图字段和水印地址常常并排出现，
  // 分两遍走才能保证改写时表已经建好。
  absorb(value: unknown): void {
    this.harvest(value);
    this.rewriteTree(value);
  }

  harvest(value: unknown): void {
    const seen = new WeakSet<object>();
    const walk = (node: unknown): void => {
      if (typeof node === "string") {
        this.record(node);
        return;
      }
      if (!isObject(node) || seen.has(node)) return;
      seen.add(node);
      const raw = this.rawFieldUrl(node);
      if (raw) this.record(raw);
      for (const child of Object.values(node)) walk(child);
    };
    walk(value);
  }

  rewriteTree(value: unknown): void {
    const seen = new WeakSet<object>();
    const walk = (node: unknown): void => {
      if (!isObject(node) || seen.has(node)) return;
      seen.add(node);
      this.pointFieldsAtRaw(node);
      if (isObject(node.image)) this.pointFieldsAtRaw(node.image);
      if (Array.isArray(node)) {
        node.forEach((item, index) => {
          if (typeof item === "string") node[index] = this.rewrite(item);
          else walk(item);
        });
        return;
      }
      for (const [key, child] of Object.entries(node)) {
        if (typeof child === "string") (node as Record<string, unknown>)[key] = this.rewrite(child);
        else walk(child);
      }
    };
    walk(value);
  }

  // 这个对象自带原图字段时，把它的主 url 和缩略字段一起指向原图。
  private pointFieldsAtRaw(node: Record<string, unknown>): void {
    const raw = this.rawFieldUrl(node);
    if (!raw) return;
    this.record(raw);
    for (const field of DERIVED_IMAGE_FIELDS) {
      const derived = node[field];
      if (isObject(derived) && typeof derived.url === "string") derived.url = raw;
    }
    if (typeof node.url === "string") node.url = raw;
  }

  private rawFieldUrl(node: Record<string, unknown>): string | null {
    for (const field of RAW_URL_FIELDS) {
      const value = node[field];
      const url = typeof value === "string" ? value : isObject(value) && typeof value.url === "string" ? value.url : null;
      if (url && isRawImageUrl(url)) return url;
    }
    return null;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
