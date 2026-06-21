# ChatGPT Image Automation

本项目实现本地任务服务、Chrome MV3 插件和 CLI，用浏览器中的 ChatGPT 会话完成生图/修图任务，并把任务状态、对话链接、图片和日志保存在当前项目目录。

## 快速开始

```bash
npm install
npm run build
npm run dev:server
```

加载插件：

1. 打开 Chrome `chrome://extensions`
2. 启用 Developer mode
3. Load unpacked
4. 选择 `apps/extension/dist`

创建任务：

```bash
npm run job:add -- --file examples/job.json
npm run job:add -- --file examples/job.json --auto-id
npm run job:add -- --file examples/job.json --replace
npm run job:list
npm run job:dispatch
npm run job:watch -- img_20260620_001
npm run job:listen -- img_20260620_001
npm run job:doctor -- img_20260620_001
```

本地服务默认监听 `http://127.0.0.1:17321`，数据保存在当前目录的 `data/`。

插件默认暂停自动执行。需要从脚本或 Codex 触发一次领取队列时，可以运行：

```bash
npm run job:dispatch
```

也可以直接调用：

```bash
curl -X POST http://127.0.0.1:17321/dispatch
```

## 回调与监听

服务端提供 SSE：

```bash
npm run job:listen -- <jobId>
```

也可以配置 webhook：

```bash
curl -X PATCH http://127.0.0.1:17321/config \
  -H 'content-type: application/json' \
  --data '{"webhookUrls":["http://127.0.0.1:18080/codex-hook"]}'
```

任务状态、事件和图片顺序都会推送到 SSE 和 webhook。
