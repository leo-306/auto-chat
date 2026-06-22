# AGENTS.md

## 语言
- 始终用中文回复用户。

## 项目定位
- 本仓库是 GPT/Gemini 生图自动化系统：本地 Fastify 服务 + Chrome MV3 插件 + CLI。
- agent 不应直接用浏览器/Chrome skill 逐步控制 GPT/Gemini 页面；优先通过本地服务、CLI、SSE 和 webhook 感知任务。
- 所有项目代码都在当前仓库内，默认数据目录是 `data/`。

## 常用命令
```bash
npm install
npm run build
npm run check
npm test
npm link
auto-chat start
auto-chat status
auto-chat stop
```

加载插件目录：

```text
apps/extension/dist
```

任务 CLI：

```bash
auto-chat add examples/job.json
auto-chat add examples/gemini-job.json --platform gemini
auto-chat add examples/gemini-text-job.json --platform gemini
auto-chat add examples/job.json --auto-id
auto-chat add examples/job.json --replace
auto-chat list
auto-chat show <jobId>
auto-chat doctor <jobId>
auto-chat listen <jobId>
auto-chat retry <jobId>
auto-chat open <jobId>
```

调试和自举必须使用 `npm link` 后的真实全局 `auto-chat` CLI。不要用 `npm run job:*`、直接导入服务模块、直接启动 `node apps/server/dist/index.js` 或 `npm run dev:server` 作为调试链路；`npm run build/check/test` 只用于开发验证。

任务服务必须通过 CLI 后台启动和停止：`auto-chat start`、`auto-chat status`、`auto-chat stop`。

## Agent 感知规则
- 插件默认暂停，不应自动 claim 队列；点击“执行调度”只执行一次调度。
- 点击“继续”会开启自动调度，后台定时器会继续 claim 队列任务。
- 用 `auto-chat doctor <jobId>` 做一次性诊断。
- 用 `auto-chat listen <jobId>` 接收 SSE 推送，避免轮询。
- 用 `data/jobs/<jobId>/events.jsonl` 查完整事件历史。
- 用 `data/jobs/<jobId>/outputs/` 读取最终图片。
- 用 `image_order` 事件确认 `output-01`、`output-02`、`output-03`、`output-04` 与提示词顺序的映射。

## 状态判断
- `done`：成功，读取 `outputFiles` 和 `image_order`。
- `failed_retryable`：可重试，优先执行 `auto-chat retry <jobId>`。
- `needs_manual`：需要人工接管，打开 `conversationUrl` 或执行 `auto-chat open <jobId>`。
- `stalled` / `refreshing`：恢复中，继续 `job:listen`。
- 其他状态视为运行中。
- 如果 `auto-chat add` 返回重复 id，使用 `--auto-id` 创建新任务，或使用 `--replace` 覆盖旧任务。

## 输出顺序规则
- 导出图片文件名固定为 `output-01.*`、`output-02.*`、`output-03.*`、`output-04.*`。
- 图片顺序必须和提示词中“图1/图2/图3/图4”一致。
- GPT 任务按生成图片卡片顺序采集，并按 estuary `file_...` 去重；Gemini 多图任务按串行轮次采集。
- Gemini 一次对话只生成一张图片，多图任务必须串行拆成多次新对话。
- 不要只按页面 `<img>` 数量判断顺序，因为同一张图可能有主图、缩略图、模糊背景等多个 DOM 节点。

## 修改要求
- 改代码前先读相关文件。
- 改完必须至少跑：
```bash
npm run build
npm run check
npm test
```
- 如果改依赖或服务暴露面，额外跑：
```bash
npm audit --audit-level=moderate
```

## 更多协议
- 详细集成协议见 `docs/agent-integration.md`。
