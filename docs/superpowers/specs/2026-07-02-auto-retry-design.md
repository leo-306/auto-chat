# 自动重试（Auto Retry）设计

## 背景

任务失败后当前只能停在 `failed_retryable`，需要人工或外部 agent 调用 `POST /jobs/:id/retry`（或 `auto-chat retry <jobId>`）才会重新排队。用户希望增加一个可选的全局开关，让 `failed_retryable` 的任务在设定的最大重试次数内自动重新排队执行，且开启开关时必须同时设置最大重试次数。

## 目标

- 新增全局配置项 `autoRetry`（布尔）与 `maxRetries`（正整数，1-10）。
- `autoRetry=true` 时，`maxRetries` 必须同时提供；不允许「开启但不设上限」。
- 任务状态变为 `failed_retryable` 时，若 `autoRetry` 开启且未超过 `maxRetries`，自动执行等价于手动 `retry` 的逻辑（重置为 `queued`，`attempt+1`）并请求插件调度。
- `maxRetries` 语义为「额外重试次数上限」：`maxRetries=2` 表示失败后最多再自动重试 2 次，总尝试次数最多 3 次。
- 超过上限后保持 `failed_retryable`，不引入新状态，用户仍可手动 `auto-chat retry`。
- 仅提供全局开关，不支持单任务覆盖。
- 自动重试范围仅覆盖 `failed_retryable`，不包括 `stalled`、`needs_manual`、`failed_final`。
- 触发时机为立即重试，不引入延迟/退避机制。

## 非目标

- 不做指数退避或延迟重试。
- 不做单任务级别的重试次数覆盖。
- 不改变 `auto-chat doctor` 的提示文案。
- 不覆盖 `stalled` 状态的自动恢复（该状态的成因更复杂，继续依赖现有 `auto-chat reload` / 人工介入）。

## 设计

### 1. 配置 schema（`packages/shared/src/index.ts`）

在 `ConfigSchema` 新增：

```ts
autoRetry: z.boolean().default(false),
maxRetries: z.number().int().min(1).max(10).optional()
```

并追加 `.superRefine` 校验：`autoRetry === true` 时 `maxRetries` 必须存在，否则报错（校验模式参考现有 `CreateJobSchema` 的 `superRefine` 用法）。

`DEFAULT_CONFIG` 新增 `autoRetry: false`，`maxRetries` 不设默认值（`undefined`）。

### 2. Store 逻辑（`apps/server/src/store.ts`）

`updateStatus()` 方法末尾，在完成常规状态写入之后新增判断：

```ts
if (input.status === "failed_retryable" && this.config.autoRetry && this.config.maxRetries) {
  const job = this.mustGet(id);
  if (job.attempt <= this.config.maxRetries) {
    const retried = this.retryJob(id);
    this.requestDispatch(retried.platform, retried.id);
    return retried;
  }
}
return this.mustGet(id);
```

复用现有 `retryJob(id)`：重置 `status=queued`、`tabId=null`、`workerId=null`、`errorMessage=null`、清除 `metadata.autoChatReloadOnly`、`attempt+1`，并写入 `job_retry` 事件。自动触发与手动触发共用同一条事件类型，`attempt` 字段本身即可追溯是第几次尝试，不额外区分「自动」或「手动」来源。

紧接着调用 `requestDispatch(platform, jobId)`，让插件端的调度感知立即生效，无需等待下一轮轮询。

### 3. CLI 命令（`apps/server/src/cli.ts`）

新增 `auto-chat autoretry [N]` 命令，位置参数风格与现有 `auto-chat concurrency [1-8]` 一致：

```
auto-chat autoretry              # 查看当前 autoRetry / maxRetries 状态
auto-chat autoretry 0            # 关闭自动重试（autoRetry=false，maxRetries 保留原值不清空）
auto-chat autoretry 2            # 开启自动重试，maxRetries=2（合法范围 1-10）
```

实现：

- 无参数 → `GET /config`，格式化输出当前状态（类似 `formatConcurrencyResult`）。
- 参数为 `0` → `PATCH /config { autoRetry: false }`。
- 参数为 1-10 的整数 → `PATCH /config { autoRetry: true, maxRetries: N }`。
- 参数越界或非数字 → 报错提示合法用法，复用 `parseMaxConcurrencyArg` 的校验风格新增 `parseAutoRetryArg`。

`usage()` 帮助文本追加一行 `auto-chat autoretry [0-10] [--json]`。

### 4. `auto-chat doctor` 提示语

不改动。`failed_retryable` 分支的 `下一步: auto-chat retry ${job.id}` 提示保持不变——由于自动重试是同步立即触发的，`doctor` 观察到 `failed_retryable` 时要么是已达上限的最终失败态，要么是极短暂的中间态（即将被自动重置为 `queued`），提示手动 `retry` 在两种情况下都成立。

## 数据流

```
插件上报 status=failed_retryable
  -> POST /jobs/:id/status
    -> store.updateStatus()
      -> 写入 failed_retryable（常规落库、appendEvent、persist）
      -> 若 autoRetry && maxRetries && attempt <= maxRetries:
           -> store.retryJob(id)   // status=queued, attempt+1
           -> store.requestDispatch(platform, id)
      -> 返回最终 job 状态（queued 或 failed_retryable）
```

## 测试计划

- `ConfigSchema`：`autoRetry=true` 且缺少 `maxRetries` 时校验失败；`autoRetry=false` 时 `maxRetries` 可省略。
- `store.updateStatus`：
  - `autoRetry=false` 时，`failed_retryable` 不触发重试（保持现状行为，回归测试）。
  - `autoRetry=true, maxRetries=2`：第 1、2 次失败自动重试（`attempt` 变为 2、3），第 3 次失败（`attempt=3 > maxRetries=2`）保持 `failed_retryable`。
  - 自动重试后 `tabId`/`workerId`/`errorMessage` 被清空，`status` 变为 `queued`。
  - 自动重试会调用 `requestDispatch`（可通过 dispatch 状态的 `id` 递增或 `jobId` 字段验证）。
- CLI `autoretry` 命令：无参查看、设置 0 关闭、设置 1-10 开启、越界报错。
- 端到端：按 skill 要求的 `auto-chat start/add/dispatch/list/show/doctor/stop` 流程补一次手动验证（开启 autoretry 后用 debug 模拟 GPT 报错，确认任务自动重新排队直至上限）。
