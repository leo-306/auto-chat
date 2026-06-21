# AGENTS.md

## 语言
- 始终用中文回复用户。

## 项目定位
- 本仓库是 ChatGPT 生图自动化系统：本地 Fastify 服务 + Chrome MV3 插件 + CLI。
- agent 不应直接用浏览器/Chrome skill 逐步控制 ChatGPT 页面；优先通过本地服务、CLI、SSE 和 webhook 感知任务。
- 所有项目代码都在当前仓库内，默认数据目录是 `data/`。

## 常用命令
```bash
npm install
npm run build
npm run check
npm test
npm run dev:server
```

加载插件目录：

```text
apps/extension/dist
```

任务 CLI：

```bash
npm run job:add -- --file examples/job.json
npm run job:add -- --file examples/job.json --auto-id
npm run job:add -- --file examples/job.json --replace
npm run job:list
npm run job:show -- <jobId>
npm run job:doctor -- <jobId>
npm run job:listen -- <jobId>
npm run job:retry -- <jobId>
npm run job:open -- <jobId>
```

## Agent 感知规则
- 插件默认暂停，不应自动 claim 队列；点击“执行调度”只执行一次调度。
- 点击“继续”会开启自动调度，后台定时器会继续 claim 队列任务。
- 用 `npm run job:doctor -- <jobId>` 做一次性诊断。
- 用 `npm run job:listen -- <jobId>` 接收 SSE 推送，避免轮询。
- 用 `data/jobs/<jobId>/events.jsonl` 查完整事件历史。
- 用 `data/jobs/<jobId>/outputs/` 读取最终图片。
- 用 `image_order` 事件确认 `output-01`、`output-02`、`output-03`、`output-04` 与提示词顺序的映射。

## 状态判断
- `done`：成功，读取 `outputFiles` 和 `image_order`。
- `failed_retryable`：可重试，优先执行 `npm run job:retry -- <jobId>`。
- `needs_manual`：需要人工接管，打开 `conversationUrl` 或执行 `npm run job:open -- <jobId>`。
- `stalled` / `refreshing`：恢复中，继续 `job:listen`。
- 其他状态视为运行中。
- 如果 `job:add` 返回重复 id，使用 `--auto-id` 创建新任务，或使用 `--replace` 覆盖旧任务。

## 输出顺序规则
- 导出图片文件名固定为 `output-01.*`、`output-02.*`、`output-03.*`、`output-04.*`。
- 图片顺序必须和提示词中“图1/图2/图3/图4”一致。
- 插件按 ChatGPT 生成图片卡片顺序采集，并按 estuary `file_...` 去重。
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
