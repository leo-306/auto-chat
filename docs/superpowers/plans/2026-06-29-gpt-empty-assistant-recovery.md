# GPT Empty Assistant Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 GPT 问题提交 3 秒后执行一次 assistant 空状态检查，并根据 URL 是否变化选择刷新后仅监听或重新发送。

**Architecture:** 新增独立的纯判定与一次性延迟检查模块，内容脚本只负责采集 DOM 状态并上报恢复模式。后台继续负责刷新计数、状态更新和标签页重载，并将恢复模式传回内容脚本以明确选择监听或重发路径。

**Tech Stack:** TypeScript、Chrome MV3 APIs、Vitest、npm workspaces

---

## 文件结构

- 新建 `apps/extension/src/recovery.ts`：定义恢复模式、空 assistant 判定、一次性 3 秒检查和启动行为判定。
- 新建 `apps/extension/test/recovery.test.ts`：覆盖计时、空状态、URL 分支和刷新后启动行为。
- 修改 `apps/extension/src/types.ts`：在进度消息和启动消息中携带恢复模式。
- 修改 `apps/extension/src/content.ts`：记录发送前 URL，安排一次检查，并按恢复模式选择监听或重发。
- 修改 `apps/extension/src/background.ts`：刷新后将恢复模式原样传回内容脚本。

### Task 1: 新增可测试的恢复判定

**Files:**
- Create: `apps/extension/src/recovery.ts`
- Create: `apps/extension/test/recovery.test.ts`

- [ ] **Step 1: 写失败测试**

创建测试，使用 Vitest fake timers 验证 2999ms 前不检查、3000ms 时只检查一次；同时覆盖 GPT/非 GPT、assistant 缺失、空节点、有文本、有图片以及 URL 两个分支。核心断言如下：

```ts
expect(inspect).not.toHaveBeenCalled();
await vi.advanceTimersByTimeAsync(2999);
expect(inspect).not.toHaveBeenCalled();
await vi.advanceTimersByTimeAsync(1);
expect(inspect).toHaveBeenCalledTimes(1);
await vi.advanceTimersByTimeAsync(3000);
expect(inspect).toHaveBeenCalledTimes(1);

expect(selectEmptyAssistantRecovery({
  platform: "gpt",
  beforeSendUrl: "https://chatgpt.com/",
  currentUrl: "https://chatgpt.com/c/1",
  assistantExists: false,
  assistantText: "",
  imageCount: 0
})).toBe("monitor_only");

expect(selectEmptyAssistantRecovery({
  platform: "gpt",
  beforeSendUrl: "https://chatgpt.com/",
  currentUrl: "https://chatgpt.com/",
  assistantExists: true,
  assistantText: "",
  imageCount: 0
})).toBe("resubmit");
```

- [ ] **Step 2: 运行测试并确认失败**

Run: `npm test --workspace apps/extension -- recovery.test.ts`

Expected: FAIL，提示无法导入 `../src/recovery.js`。

- [ ] **Step 3: 实现最小判定模块**

实现以下公共接口：

```ts
import type { JobPlatform } from "auto-chat-shared";

export const GPT_EMPTY_ASSISTANT_CHECK_DELAY_MS = 3000;
export type EmptyAssistantRecoveryMode = "monitor_only" | "resubmit";

export type EmptyAssistantSnapshot = {
  assistantExists: boolean;
  assistantText: string;
  imageCount: number;
};

export function selectEmptyAssistantRecovery(input: EmptyAssistantSnapshot & {
  platform: JobPlatform;
  beforeSendUrl: string;
  currentUrl: string;
}): EmptyAssistantRecoveryMode | null {
  if (input.platform !== "gpt") return null;
  const isEmpty = !input.assistantExists || (!input.assistantText.trim() && input.imageCount === 0);
  if (!isEmpty) return null;
  return input.currentUrl === input.beforeSendUrl ? "resubmit" : "monitor_only";
}

export async function waitForEmptyAssistantRecovery(options: {
  platform: JobPlatform;
  beforeSendUrl: string;
  signal: AbortSignal;
  inspect: () => Promise<EmptyAssistantSnapshot>;
  currentUrl: () => string;
}): Promise<EmptyAssistantRecoveryMode | null> {
  if (options.platform !== "gpt") return null;
  await new Promise(resolve => setTimeout(resolve, GPT_EMPTY_ASSISTANT_CHECK_DELAY_MS));
  if (options.signal.aborted) return null;
  const snapshot = await options.inspect();
  return selectEmptyAssistantRecovery({
    platform: options.platform,
    beforeSendUrl: options.beforeSendUrl,
    currentUrl: options.currentUrl(),
    ...snapshot
  });
}

```

- [ ] **Step 4: 运行单测并确认通过**

Run: `npm test --workspace apps/extension -- recovery.test.ts`

Expected: PASS，所有 recovery 测试通过。

- [ ] **Step 5: 提交纯判定模块**

```bash
git add apps/extension/src/recovery.ts apps/extension/test/recovery.test.ts
git commit -m "test: define GPT empty assistant recovery"
```

### Task 2: 接入内容脚本和后台刷新链路

**Files:**
- Modify: `apps/extension/src/types.ts`
- Modify: `apps/extension/src/content.ts`
- Modify: `apps/extension/src/background.ts`
- Test: `apps/extension/test/recovery.test.ts`

- [ ] **Step 1: 补充启动行为失败测试**

为 `shouldMonitorWithoutSubmit` 添加断言，证明 `monitor_only` 即使没有 assistant 也只监听，`resubmit` 即使已有 assistant 也重新发送：

```ts
expect(shouldMonitorWithoutSubmit({
  recoveryMode: "monitor_only",
  reloadOnly: false,
  hasExistingAssistant: false
})).toBe(true);

expect(shouldMonitorWithoutSubmit({
  recoveryMode: "resubmit",
  reloadOnly: false,
  hasExistingAssistant: true
})).toBe(false);
```

- [ ] **Step 2: 运行测试并确认失败**

Run: `npm test --workspace apps/extension -- recovery.test.ts`

Expected: FAIL，启动行为尚未满足恢复模式断言。

- [ ] **Step 3: 实现启动行为判定**

在 `recovery.ts` 增加：

```ts
export function shouldMonitorWithoutSubmit(input: {
  recoveryMode?: EmptyAssistantRecoveryMode;
  reloadOnly: boolean;
  hasExistingAssistant: boolean;
}): boolean {
  if (input.recoveryMode === "monitor_only") return true;
  if (input.recoveryMode === "resubmit") return false;
  return input.reloadOnly || input.hasExistingAssistant;
}
```

- [ ] **Step 4: 扩展消息类型**

在 `StartJobMessage` 和 `JobProgressMessage` 增加可选字段：

```ts
import type { EmptyAssistantRecoveryMode } from "./recovery.js";

recoveryMode?: EmptyAssistantRecoveryMode;
```

- [ ] **Step 5: 内容脚本安排一次检查并停止旧监听**

调整 `startJob` 接收恢复模式。使用 `shouldMonitorWithoutSubmit` 决定直接监听还是执行发送流程；`resubmit` 必须绕过已有 assistant 快捷路径。

GPT 发送前保存 `const beforeSendUrl = location.href`，提交后并行启动正常 `monitorJob` 和一次性恢复检查：

```ts
void waitForEmptyAssistantRecovery({
  platform: job.platform,
  beforeSendUrl,
  signal: monitorAbort.signal,
  inspect: async () => {
    const state = await inspectJob(job.id);
    return {
      assistantExists: state.assistantExists,
      assistantText: state.assistantText,
      imageCount: state.loadedImages.length
    };
  },
  currentUrl: () => location.href
}).then(async recoveryMode => {
  if (!recoveryMode || monitorAbort.signal.aborted) return;
  monitorAbort.abort();
  await sendProgress({
    type: "JOB_PROGRESS",
    jobId: job.id,
    status: "stalled",
    recoveryMode,
    errorMessage: "GPT assistant remained empty 3 seconds after prompt submission."
  });
});
```

`inspectJob` 的返回值增加 `assistantExists`，确保节点不存在优先判为空。

- [ ] **Step 6: 后台透传恢复模式**

`sendStartMessage` 接收可选恢复模式并写入 `START_JOB`。处理 `stalled` 时沿用原有最大刷新次数判断、`refreshing` 状态和 `chrome.tabs.reload`，刷新完成后把 `message.recoveryMode` 传入 `sendStartMessage`：

```ts
await sendStartMessage(tabId, job, message.recoveryMode);
```

- [ ] **Step 7: 运行扩展测试、类型检查和构建**

Run: `npm test --workspace apps/extension -- recovery.test.ts`

Expected: PASS。

Run: `npm run check`

Expected: exit 0，无 TypeScript 错误。

Run: `npm run build`

Expected: exit 0，扩展构建成功。

- [ ] **Step 8: 提交接线修改**

```bash
git add apps/extension/src/types.ts apps/extension/src/content.ts apps/extension/src/background.ts apps/extension/test/recovery.test.ts
git commit -m "fix: recover empty GPT assistant after submit"
```

### Task 3: 全量验证

**Files:**
- Verify: `apps/extension/src/recovery.ts`
- Verify: `apps/extension/src/types.ts`
- Verify: `apps/extension/src/content.ts`
- Verify: `apps/extension/src/background.ts`
- Verify: `apps/extension/test/recovery.test.ts`

- [ ] **Step 1: 检查差异**

Run: `git diff HEAD~2 --check`

Expected: exit 0，无空白错误。

- [ ] **Step 2: 执行项目要求的完整验证**

Run: `npm run build && npm run check && npm test`

Expected: 三个命令均 exit 0，全部测试通过。

- [ ] **Step 3: 检查最终状态**

Run: `git status --short`

Expected: 只包含计划文档的未提交改动，或工作区干净。
