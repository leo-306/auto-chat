# 自动重试（Auto Retry）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 任务进入 `failed_retryable` 状态时，在全局开关开启且未超过设定的最大重试次数时自动重新排队执行，无需人工调用 `auto-chat retry`。

**Architecture:** 在共享 schema（`packages/shared/src/index.ts`）新增 `autoRetry`/`maxRetries` 两个全局配置字段（开启时必须同时提供上限）；在 `JobStore.updateStatus()`（`apps/server/src/store.ts`）里拦截 `failed_retryable` 状态写入，若满足自动重试条件则复用现有 `retryJob()` 逻辑重新排队并调用 `requestDispatch()`；在 CLI（`apps/server/src/cli.ts`）新增 `auto-chat autoretry [N]` 命令管理该开关，风格对齐现有 `auto-chat concurrency [1-8]`。

**Tech Stack:** TypeScript, Zod（schema 校验）, Vitest（测试）, sql.js（JobStore 持久化）。

---

## 背景说明（给实现者）

- `Job.attempt` 字段在 `createJob()` 时初始化为 `0`（见 `apps/server/src/store.ts:96`，insert 语句里 `attempt` 位置写死 `0`）。`retryJob()` 每次调用会把 `attempt` 设为 `existing.attempt + 1`。
- 「maxRetries 语义 = 额外重试次数上限」的设计决策，换算成代码判据是：**`job.attempt < maxRetries` 时才自动重试**。例：`maxRetries=2`，任务第一次失败时 `attempt=0`（`0 < 2` → 触发重试，重试后 `attempt=1`），若重试后又失败 `attempt=1`（`1 < 2` → 触发重试，重试后 `attempt=2`），若再次失败 `attempt=2`（`2 < 2` 为 false → 不再自动重试，保持 `failed_retryable`）。总计尝试 3 次（1 次原始 + 2 次自动重试），与设计文档中「额外重试 2 次，共尝试 3 次」的语义一致。
- **重要的 Zod API 限制（已用 Node 脚本实测确认，不是假设）：** `ConfigSchema` 目前用 `.superRefine()` 校验「`autoRetry=true` 时 `maxRetries` 必填」，这会让 `ConfigSchema` 的类型从 `ZodObject` 变成 `ZodEffects`。`ZodEffects` **没有** `.partial()` 方法（`typeof schema.partial === 'undefined'`）。而 `apps/server/src/api.ts:57` 现在写的是 `ConfigSchema.partial().parse(request.body)`，加上 `superRefine` 后这行会直接编译失败，必须修改。
  - 修法**不是**简单换成 `ConfigSchema.innerType().partial()`：`innerType()` 拿到的是原始 `ZodObject`，`.partial()` 之后完全不带 `superRefine` 的跨字段校验（已实测：`innerType().partial().parse({ autoRetry: true })` 不报错，`maxRetries` 会是 `undefined`）。如果只做这一步替换，`PATCH /config` 就会允许「开启 autoRetry 但没有 maxRetries」这种非法状态写入库，违反核心约束。
  - 正确修法：`api.ts` 里 `PATCH /config` 的 handler 改用 `ConfigSchema.innerType().partial().parse(request.body)` 只做「单字段类型」的浅校验，取到 `patch` 对象；真正的跨字段约束校验挪到 `store.updateConfig()` 内部——合并 `patch` 到当前 `config` 之后，用完整的 `ConfigSchema.parse(merged)`（非 partial）再校验一次合并后的完整对象，校验失败就抛错。这样无论调用方传了哪些字段、是否记得带上 `maxRetries`，最终落库前都会有一次完整规则兜底，不依赖调用方“记得同时传两个字段”的约定。
- `updateConfig()` 目前是简单的浅合并（`{ ...this.config, ...patch }`，见 `apps/server/src/store.ts:302`），Task 1 会改造它，加入合并后校验。

---

## Task 1: 共享 schema 新增 autoRetry / maxRetries 字段，并加固 updateConfig 校验

**Files:**
- Modify: `packages/shared/src/index.ts:30-52`
- Modify: `apps/server/src/api.ts:56-59`（`PATCH /config` handler）
- Modify: `apps/server/src/store.ts:301-308`（`updateConfig` 方法）与 import 列表
- Test: `packages/shared/test/index.test.ts`（若不存在则新建）
- Test: `apps/server/test/store.test.ts`

- [ ] **Step 1: 确认共享包是否已有测试文件**

Run: `find packages/shared -iname "*.test.ts"`

若无输出，说明需要新建 `packages/shared/test/index.test.ts`。若已有文件，在现有 `describe` 块旁新增一个新的 `describe("ConfigSchema", ...)` 块。

- [ ] **Step 2: 写失败的 schema 校验测试**

在 `packages/shared/test/index.test.ts` 写入（若文件不存在则整份新建，需包含下面的 import 和内容）：

```ts
import { describe, expect, it } from "vitest";
import { ConfigSchema, DEFAULT_CONFIG } from "../src/index.js";

describe("ConfigSchema", () => {
  it("defaults autoRetry to false and allows maxRetries to be omitted", () => {
    const parsed = ConfigSchema.parse({});
    expect(parsed.autoRetry).toBe(false);
    expect(parsed.maxRetries).toBeUndefined();
  });

  it("requires maxRetries when autoRetry is enabled", () => {
    expect(() => ConfigSchema.parse({ autoRetry: true })).toThrow();
  });

  it("accepts autoRetry with a valid maxRetries", () => {
    const parsed = ConfigSchema.parse({ autoRetry: true, maxRetries: 2 });
    expect(parsed.autoRetry).toBe(true);
    expect(parsed.maxRetries).toBe(2);
  });

  it("rejects maxRetries outside 1-10", () => {
    expect(() => ConfigSchema.parse({ autoRetry: true, maxRetries: 0 })).toThrow();
    expect(() => ConfigSchema.parse({ autoRetry: true, maxRetries: 11 })).toThrow();
  });

  it("keeps DEFAULT_CONFIG.autoRetry false", () => {
    expect(DEFAULT_CONFIG.autoRetry).toBe(false);
  });
});
```

- [ ] **Step 3: 运行测试，确认失败**

Run: `cd packages/shared && npx vitest run test/index.test.ts`
Expected: FAIL — `ConfigSchema` 上没有 `autoRetry`/`maxRetries` 属性，`parsed.autoRetry` 是 `undefined` 而非 `false`；「requires maxRetries when autoRetry is enabled」这条测试也会失败（因为当前 schema 允许任意多余字段被忽略，不会抛错）。

- [ ] **Step 4: 修改 ConfigSchema 和 DEFAULT_CONFIG**

打开 `packages/shared/src/index.ts`，把第 30-52 行替换为：

```ts
export const ConfigSchema = z.object({
  maxConcurrency: z.number().int().min(1).max(8).default(1),
  stallTimeoutMs: z.number().int().min(30_000).default(120_000),
  hardTimeoutMs: z.number().int().min(60_000).default(900_000),
  maxRefreshPerJob: z.number().int().min(0).max(10).default(2),
  expectedImageCount: z.number().int().min(1).max(12).default(4),
  chatgptUrl: z.string().url().default("https://chatgpt.com/"),
  geminiUrl: z.string().url().default("https://gemini.google.com/app"),
  webhookUrls: z.array(z.string().url()).default([]),
  autoRetry: z.boolean().default(false),
  maxRetries: z.number().int().min(1).max(10).optional()
}).superRefine((value, ctx) => {
  if (value.autoRetry && value.maxRetries === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["maxRetries"],
      message: "maxRetries is required when autoRetry is enabled."
    });
  }
});

export type AppConfig = z.infer<typeof ConfigSchema>;

export const DEFAULT_CONFIG: AppConfig = {
  maxConcurrency: 1,
  stallTimeoutMs: 120_000,
  hardTimeoutMs: 900_000,
  maxRefreshPerJob: 2,
  expectedImageCount: 4,
  chatgptUrl: "https://chatgpt.com/",
  geminiUrl: "https://gemini.google.com/app",
  webhookUrls: [],
  autoRetry: false
};
```

注意：`z.object({...}).superRefine(...)` 的返回类型不再是 `ZodObject`，而是 `ZodEffects`，因此后面若有代码依赖 `ConfigSchema.shape` 会报错——运行 Step 6 的 typecheck 会捕获这类问题。

- [ ] **Step 5: 运行测试，确认通过**

Run: `cd packages/shared && npx vitest run test/index.test.ts`
Expected: PASS，全部 5 条测试通过。

- [ ] **Step 6: 修复 api.ts 中失效的 ConfigSchema.partial() 调用**

打开 `apps/server/src/api.ts`，找到第 56-59 行：

```ts
  app.patch("/config", async (request) => {
    const patch = ConfigSchema.partial().parse(request.body);
    return store.updateConfig(patch);
  });
```

替换为：

```ts
  app.patch("/config", async (request, reply) => {
    const patch = ConfigSchema.innerType().partial().parse(request.body);
    try {
      return store.updateConfig(patch);
    } catch (error) {
      return reply.code(400).send({ error: String(error) });
    }
  });
```

`ConfigSchema.innerType()` 拿回加 `superRefine` 之前的原始 `ZodObject`，`.partial()` 在其上是合法调用，只做「单字段类型是否合法」的浅校验（例如 `maxRetries` 必须是 1-10 的整数，若提供的话）。跨字段约束（「`autoRetry=true` 时必须有 `maxRetries`」）校验挪到 Step 7 的 `store.updateConfig()` 内部，用 try/catch 把校验错误转成 400 响应，避免整个进程抛出未捕获异常。

- [ ] **Step 7: 让 store.updateConfig 在合并后做完整校验**

打开 `apps/server/src/store.ts`，找到 `updateConfig` 方法（第 301-308 行）：

```ts
  updateConfig(patch: Partial<AppConfig>): AppConfig {
    this.config = { ...this.config, ...patch };
    this.run("insert or replace into config (key, value) values ('app', ?)", [
      JSON.stringify(this.config)
    ]);
    this.persist();
    return this.config;
  }
```

替换为：

```ts
  updateConfig(patch: Partial<AppConfig>): AppConfig {
    const merged = ConfigSchema.parse({ ...this.config, ...patch });
    this.config = merged;
    this.run("insert or replace into config (key, value) values ('app', ?)", [
      JSON.stringify(this.config)
    ]);
    this.persist();
    return this.config;
  }
```

在文件顶部的 import 列表（第 4-16 行）中，把 `ConfigSchema` 加入从 `"auto-chat-shared"` 导入的具名列表（按字母序插入）：

```ts
import {
  AppConfig,
  ArtifactRequest,
  ClaimJobRequest,
  ConfigSchema,
  CreateJobRequest,
  DEFAULT_CONFIG,
  DispatchState,
  Job,
  JobEvent,
  JobPlatform,
  JobStatus,
  UpdateStatusRequest
} from "auto-chat-shared";
```

这样一来，`ConfigSchema.parse(merged)` 会跑完整的 `superRefine` 规则：如果合并后 `autoRetry=true` 但 `maxRetries` 缺失（无论是因为 PATCH body 没带、还是历史数据本来就没有），这里会直接抛出 Zod 校验错误，被 Step 6 的 try/catch 捕获并转成 400，不会静默写入非法状态。

- [ ] **Step 8: 写失败的 updateConfig 校验测试**

在 `apps/server/test/store.test.ts` 文件末尾（`describe("JobStore", ...)` 块内最后一个 `it` 之后，`});` 之前）新增：

```ts
  it("rejects updateConfig when autoRetry is enabled without maxRetries", async () => {
    const store = new JobStore(tmp);
    await store.init();

    expect(() => store.updateConfig({ autoRetry: true })).toThrow();

    store.close();
  });

  it("allows updateConfig to enable autoRetry with maxRetries in one call", async () => {
    const store = new JobStore(tmp);
    await store.init();

    const updated = store.updateConfig({ autoRetry: true, maxRetries: 3 });

    expect(updated.autoRetry).toBe(true);
    expect(updated.maxRetries).toBe(3);
    store.close();
  });
```

- [ ] **Step 9: 运行测试，确认失败**

Run: `cd apps/server && npx vitest run test/store.test.ts -t "updateConfig"`
Expected: FAIL — 在实现 Step 6/7 之前，`updateConfig({ autoRetry: true })` 不会抛错（因为旧代码只是浅合并，不做校验），第一条测试的 `expect(...).toThrow()` 会失败。

- [ ] **Step 10: 运行 workspace 级别的类型检查和测试，确认全部通过**

Run: `npm run check`
Expected: 无 TypeScript 错误（`ConfigSchema.innerType().partial()` 和 `ConfigSchema.parse()` 均为合法调用）。

Run: `cd apps/server && npx vitest run test/store.test.ts`
Expected: PASS，包括 Step 8 新增的 2 条测试和原有全部测试。

Run: `cd packages/shared && npx vitest run test/index.test.ts`
Expected: PASS，Task 1 Step 2 的 5 条测试仍然通过。

- [ ] **Step 11: 提交**

```bash
git add packages/shared/src/index.ts packages/shared/test/index.test.ts apps/server/src/api.ts apps/server/src/store.ts apps/server/test/store.test.ts
git commit -m "feat: add autoRetry and maxRetries to AppConfig schema"
```

---

## Task 2: JobStore 在 failed_retryable 时自动重试

**Files:**
- Modify: `apps/server/src/store.ts:161-188`（`updateStatus` 方法）
- Test: `apps/server/test/store.test.ts`

- [ ] **Step 1: 写失败的自动重试测试**

在 `apps/server/test/store.test.ts` 文件末尾（`describe("JobStore", ...)` 块最后一个 `it` 之后、块的收尾 `});` 之前——即 Task 1 Step 8 新增的两条 `updateConfig` 测试之后）新增：

```ts
  it("does not auto-retry when autoRetry is disabled", async () => {
    const store = new JobStore(tmp);
    await store.init();
    store.createJob({ id: "no_auto_retry", prompt: "hello", sourceImages: [], metadata: {} });

    const result = store.updateStatus("no_auto_retry", {
      status: "failed_retryable",
      errorMessage: "boom"
    });

    expect(result.status).toBe("failed_retryable");
    expect(result.attempt).toBe(0);
    store.close();
  });

  it("auto-retries failed_retryable jobs up to maxRetries, then stops", async () => {
    const store = new JobStore(tmp);
    await store.init();
    store.updateConfig({ autoRetry: true, maxRetries: 2 });
    store.createJob({ id: "auto_retry_job", platform: "gpt", prompt: "hello", sourceImages: [], metadata: {} });

    const afterFirstFailure = store.updateStatus("auto_retry_job", {
      status: "failed_retryable",
      errorMessage: "first failure"
    });
    expect(afterFirstFailure.status).toBe("queued");
    expect(afterFirstFailure.attempt).toBe(1);
    expect(afterFirstFailure.tabId).toBeNull();
    expect(afterFirstFailure.errorMessage).toBeNull();

    const afterSecondFailure = store.updateStatus("auto_retry_job", {
      status: "failed_retryable",
      errorMessage: "second failure"
    });
    expect(afterSecondFailure.status).toBe("queued");
    expect(afterSecondFailure.attempt).toBe(2);

    const afterThirdFailure = store.updateStatus("auto_retry_job", {
      status: "failed_retryable",
      errorMessage: "third failure"
    });
    expect(afterThirdFailure.status).toBe("failed_retryable");
    expect(afterThirdFailure.attempt).toBe(2);
    expect(afterThirdFailure.errorMessage).toBe("third failure");

    store.close();
  });

  it("requests dispatch for the retried job's platform when auto-retrying", async () => {
    const store = new JobStore(tmp);
    await store.init();
    store.updateConfig({ autoRetry: true, maxRetries: 1 });
    store.createJob({ id: "auto_retry_dispatch", platform: "gemini", prompt: "hello", sourceImages: [], metadata: {} });

    const dispatchBefore = store.getDispatch();
    store.updateStatus("auto_retry_dispatch", { status: "failed_retryable" });
    const dispatchAfter = store.getDispatch();

    expect(dispatchAfter.id).toBe(dispatchBefore.id + 1);
    expect(dispatchAfter.platform).toBe("gemini");
    expect(dispatchAfter.jobId).toBe("auto_retry_dispatch");
    store.close();
  });
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `cd apps/server && npx vitest run test/store.test.ts -t "auto-retr"`
Expected: FAIL —「auto-retries failed_retryable jobs up to maxRetries」测试里 `afterFirstFailure.status` 会是 `"failed_retryable"` 而不是 `"queued"`（因为当前 `updateStatus` 没有自动重试逻辑）。「does not auto-retry」这条会 PASS（因为默认行为本来就不重试），属于回归保护，不用管它现在就过。

- [ ] **Step 3: 实现自动重试逻辑**

打开 `apps/server/src/store.ts`，找到 `updateStatus` 方法（第 161-188 行）。将方法体的最后一段：

```ts
    if (nextConversationUrl) fs.writeFileSync(this.paths.jobFile(id, "conversation.url"), nextConversationUrl);
    this.appendEvent(id, { type: "status", payload: input });
    this.writeMeta(id);
    this.persist();
    return this.mustGet(id);
  }
```

替换为：

```ts
    if (nextConversationUrl) fs.writeFileSync(this.paths.jobFile(id, "conversation.url"), nextConversationUrl);
    this.appendEvent(id, { type: "status", payload: input });
    this.writeMeta(id);
    this.persist();

    if (input.status === "failed_retryable" && this.config.autoRetry && this.config.maxRetries !== undefined) {
      const failedJob = this.mustGet(id);
      if (failedJob.attempt < this.config.maxRetries) {
        const retried = this.retryJob(id);
        this.requestDispatch(retried.platform, retried.id);
        return retried;
      }
    }

    return this.mustGet(id);
  }
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `cd apps/server && npx vitest run test/store.test.ts`
Expected: PASS，包括新增的 3 条测试和原有全部测试（回归无破坏）。

- [ ] **Step 5: 提交**

```bash
git add apps/server/src/store.ts apps/server/test/store.test.ts
git commit -m "feat: auto-retry failed_retryable jobs when configured"
```

---

## Task 3: CLI `auto-chat autoretry` 命令

**Files:**
- Modify: `apps/server/src/cli.ts`（新增 command 分支、`parseAutoRetryArg`、`formatAutoRetryResult`、`usage()` 帮助文本）
- Test: `apps/server/test/cli-format.test.ts`

- [ ] **Step 1: 写失败的格式化函数测试**

在 `apps/server/test/cli-format.test.ts`，找到第 218-223 行的 `it("parses and formats max concurrency settings", ...)` 测试块之后，新增一条同级测试：

```ts
  it("parses and formats auto-retry settings", () => {
    expect(parseAutoRetryArg("0")).toEqual({ autoRetry: false });
    expect(parseAutoRetryArg("2")).toEqual({ autoRetry: true, maxRetries: 2 });
    expect(parseAutoRetryArg("10")).toEqual({ autoRetry: true, maxRetries: 10 });
    expect(() => parseAutoRetryArg("11")).toThrow("自动重试次数必须是 0 到 10 的整数（0 表示关闭）");
    expect(() => parseAutoRetryArg("-1")).toThrow("自动重试次数必须是 0 到 10 的整数（0 表示关闭）");
    expect(() => parseAutoRetryArg("1.5")).toThrow("自动重试次数必须是 0 到 10 的整数（0 表示关闭）");

    expect(formatAutoRetryResult({ autoRetry: false, maxRetries: undefined })).toBe("自动重试: 关闭");
    expect(formatAutoRetryResult({ autoRetry: true, maxRetries: 3 })).toBe("自动重试: 开启（最多重试 3 次）");
  });
```

并在文件顶部的 import 列表（第 4-18 行）里补充 `formatAutoRetryResult` 和 `parseAutoRetryArg`，按字母序插入到现有列表中：

```ts
import {
  defaultSkillInstallDirs,
  formatAddResult,
  formatAutoRetryResult,
  formatConcurrencyResult,
  formatDoctor,
  formatExtensionInstallInstructions,
  formatJobSummary,
  formatListRow,
  formatReloadResult,
  formatSkillInstallResults,
  normalizeCommand,
  parseAutoRetryArg,
  parseMaxConcurrencyArg,
  positionalArgs,
  shouldStopListeningForPayload
} from "../src/cli.js";
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `cd apps/server && npx vitest run test/cli-format.test.ts -t "auto-retry settings"`
Expected: FAIL — `parseAutoRetryArg`/`formatAutoRetryResult` 未定义，报 TypeScript/运行时错误（`is not a function` 或 import 解析失败）。

- [ ] **Step 3: 实现 parseAutoRetryArg 和 formatAutoRetryResult**

打开 `apps/server/src/cli.ts`，在 `parseMaxConcurrencyArg`（第 588-594 行）和 `formatConcurrencyResult`（第 596-598 行）之后新增：

```ts
export function parseAutoRetryArg(value: string): { autoRetry: boolean; maxRetries?: number } {
  const maxRetries = Number(value);
  if (!Number.isInteger(maxRetries) || maxRetries < 0 || maxRetries > 10) {
    throw new Error("自动重试次数必须是 0 到 10 的整数（0 表示关闭）");
  }
  return maxRetries === 0 ? { autoRetry: false } : { autoRetry: true, maxRetries };
}

export function formatAutoRetryResult(config: Pick<AppConfig, "autoRetry" | "maxRetries">): string {
  return config.autoRetry
    ? `自动重试: 开启（最多重试 ${config.maxRetries} 次）`
    : "自动重试: 关闭";
}
```

- [ ] **Step 4: 运行格式化函数测试，确认通过**

Run: `cd apps/server && npx vitest run test/cli-format.test.ts`
Expected: PASS，全部测试通过。

- [ ] **Step 5: 接入 CLI 命令分支**

打开 `apps/server/src/cli.ts`，找到 `concurrency` 命令分支（第 68-75 行）：

```ts
  if (command === "concurrency") {
    const value = positionalArgs(args)[0];
    const config = value
      ? await request<AppConfig>("/config", { method: "PATCH", body: { maxConcurrency: parseMaxConcurrencyArg(value) } })
      : await request<AppConfig>("/config");
    print(options.json ? JSON.stringify(config, null, 2) : formatConcurrencyResult(config));
    return;
  }
```

在其后紧接着新增：

```ts
  if (command === "autoretry") {
    const value = positionalArgs(args)[0];
    const config = value
      ? await request<AppConfig>("/config", { method: "PATCH", body: parseAutoRetryArg(value) })
      : await request<AppConfig>("/config");
    print(options.json ? JSON.stringify(config, null, 2) : formatAutoRetryResult(config));
    return;
  }
```

注意：`parseAutoRetryArg` 在关闭时返回 `{ autoRetry: false }`（不含 `maxRetries` 字段）。这是安全的：`store.updateConfig()`（Task 1 Step 7）会把 patch 合并到当前 config 后再用完整 `ConfigSchema.parse()` 校验，`autoRetry: false` 时 `superRefine` 里 `value.autoRetry && value.maxRetries === undefined` 这个条件直接短路为 `false`，不会报错，`maxRetries` 保留合并前的历史值即可（不需要清空）。开启场景 `parseAutoRetryArg` 保证 `maxRetries` 一定跟 `autoRetry: true` 同时返回，合并后完整校验也会通过。因此 CLI 层不需要额外做「记住历史 maxRetries 再拼接」之类的处理，`parseAutoRetryArg` 的返回值可以直接作为 PATCH body。

- [ ] **Step 6: 更新 usage() 帮助文本**

打开 `apps/server/src/cli.ts`，找到 `usage()` 函数（第 685-707 行），在 `auto-chat concurrency [1-8] [--json]` 那一行之后新增一行：

```ts
  auto-chat concurrency [1-8] [--json]
  auto-chat autoretry [0-10] [--json]
```

- [ ] **Step 7: 手动验证 CLI 命令行为**

先按 skill 要求启动服务：

Run: `auto-chat start`
Expected: 服务启动成功。

Run: `auto-chat autoretry`
Expected: 输出 `自动重试: 关闭`（默认值）。

Run: `auto-chat autoretry 2`
Expected: 输出 `自动重试: 开启（最多重试 2 次）`。

Run: `auto-chat autoretry 0`
Expected: 输出 `自动重试: 关闭`。

Run: `auto-chat autoretry 11`
Expected: 报错退出，错误信息包含「自动重试次数必须是 0 到 10 的整数（0 表示关闭）」。

Run: `auto-chat stop`
Expected: 服务停止。

- [ ] **Step 8: 提交**

```bash
git add apps/server/src/cli.ts apps/server/test/cli-format.test.ts
git commit -m "feat: add auto-chat autoretry CLI command"
```

---

## Task 4: 全量验证

**Files:** 无新增文件，仅运行验证命令。

- [ ] **Step 1: 运行完整构建**

Run: `npm run build`
Expected: 无错误，`apps/server/dist`、`apps/extension/dist`、`packages/shared/dist` 均正常产出（本功能不涉及 extension，但 build 是全 workspace 命令，仍需通过）。

- [ ] **Step 2: 运行类型检查**

Run: `npm run check`
Expected: 无 TypeScript 错误。

- [ ] **Step 3: 运行全部测试**

Run: `npm test`
Expected: 全部测试通过，包括 Task 1-3 新增的测试用例。

- [ ] **Step 4: 按 skill 要求做一次真实 CLI 回归**

Run:
```bash
auto-chat start
auto-chat add examples/text-job.json --replace
auto-chat autoretry 1
auto-chat dispatch --platform gpt text_test_001
auto-chat list
auto-chat show text_test_001
auto-chat doctor text_test_001
auto-chat autoretry 0
auto-chat stop
```

Expected: 全程无异常报错；`auto-chat autoretry 1` 输出「自动重试: 开启（最多重试 1 次）」；`auto-chat autoretry 0` 输出「自动重试: 关闭」。此步骤主要验证 CLI 命令不破坏现有 job 流程，不强制要求真实触发 GPT 失败重试（真实触发需要真实的 ChatGPT 报错场景，超出本次自动化验证范围）。

- [ ] **Step 5: 提交（若有遗留改动）**

Run: `git status`
若无未提交改动，跳过本步骤。若有遗留改动（例如 Step 1-4 过程中修复了 lint 或格式问题），执行：

```bash
git add -A
git commit -m "chore: finalize auto-retry verification"
```

---

## Self-Review Notes（供实现前参考，无需重复执行）

- **Spec 覆盖检查：** 设计文档中的 5 项确认点（额外重试次数语义、仅全局配置、仅覆盖 `failed_retryable`、达上限后保持 `failed_retryable`、立即重试无延迟）均已体现在 Task 1（schema）、Task 2（store 判据 `attempt < maxRetries` 与不改变终态）、Task 3（仅全局 CLI 命令，无单任务覆盖）中。`auto-chat doctor` 提示语按设计决策不改动，因此本计划未包含相关任务。
- **Placeholder 扫描：** 全部步骤含完整代码块和精确命令，无 TBD / TODO / "add appropriate handling" 等占位表述。
- **类型一致性：** `parseAutoRetryArg` 返回类型 `{ autoRetry: boolean; maxRetries?: number }` 与 `store.updateConfig()` 接收的 `Partial<AppConfig>` 字段名/类型一致（`autoRetry: boolean`，`maxRetries: number | undefined`）。`formatAutoRetryResult` 入参类型 `Pick<AppConfig, "autoRetry" | "maxRetries">` 与 `formatConcurrencyResult` 的 `Pick<AppConfig, "maxConcurrency">` 风格一致。Task 2 中 `store.updateStatus` 内部调用的 `this.retryJob(id)` 与 `this.requestDispatch(retried.platform, retried.id)` 均为 `JobStore` 已有方法，签名未变。
- **实测发现的 API 陷阱（Task 1 Step 6/7 的由来）：** 最初设计文档假设 `ConfigSchema.partial()` 在加了 `superRefine` 之后仍可直接使用，但实测 `ZodEffects`（`superRefine` 的返回类型）没有 `.partial()` 方法，这在计划撰写阶段已用 Node 脚本验证并修正——`api.ts` 改用 `ConfigSchema.innerType().partial()` 做单字段浅校验，`store.updateConfig()` 改为合并后用完整 `ConfigSchema.parse()` 兜底校验跨字段约束。这个修正保证了「开启 autoRetry 必须同时设置 maxRetries」这条约束无法被任何调用路径绕过，不依赖 CLI 层「记得同时传两个字段」的自觉性。
