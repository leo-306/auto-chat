# auto-chat

auto-chat 是一个本地 ChatGPT 任务自动化工具：本地 Fastify 服务负责队列和文件，Chrome MV3 插件负责在你自己的 ChatGPT 页面里发送任务并采集结果，CLI 负责创建、监听和诊断任务。

它支持两种模式：

- `image`：图片生成/修图任务，输出图片文件。
- `text`：常规聊天任务，输出文本文件。

两种模式都可以附带可选参考图片。项目不会托管 ChatGPT 账号、不保存登录凭据，也不绕过 ChatGPT 的登录或权限机制。

## 安装

```bash
npm install
npm run build
```

本地开发时可以直接用：

```bash
node apps/server/dist/cli.js --help
```

如果你在仓库内执行 `npm link`，也可以使用：

```bash
npm link
auto-chat --help
```

## 启动服务

```bash
auto-chat start
auto-chat status
```

服务默认监听：

```text
http://127.0.0.1:17321
```

任务数据默认写入当前仓库的 `data/`，该目录不应提交到 Git。

停止后台服务：

```bash
auto-chat stop
```

## 加载 Chrome 插件

1. 打开 Chrome `chrome://extensions`
2. 启用 Developer mode
3. 选择 Load unpacked
4. 加载目录：

```text
apps/extension/dist
```

插件默认暂停，不会自动领取队列。你可以在 popup 中点击“执行一次调度”，或使用：

```bash
auto-chat dispatch
```

## 创建文本任务

```bash
auto-chat add examples/text-job.json --replace
auto-chat dispatch
auto-chat listen text_test_001
```

完成后文本结果会写入：

```text
data/jobs/<jobId>/outputs/output-01.txt
```

任务详情中的 `textOutputFile` 会指向该文件。

## 创建图片任务

```bash
auto-chat add examples/job.json --replace
auto-chat dispatch
auto-chat listen img_order_test_002
```

完成后图片结果会写入：

```text
data/jobs/<jobId>/outputs/
```

图片文件名固定为 `output-01.*`、`output-02.*`，顺序对应提示词中的图 1、图 2。完整顺序映射记录在 `events.jsonl` 的 `image_order` 事件中。

## 常用命令

```bash
auto-chat start
auto-chat status
auto-chat stop
auto-chat add <job.json> [--replace] [--auto-id]
auto-chat list
auto-chat show <jobId>
auto-chat show <jobId> --json
auto-chat listen [jobId]
auto-chat listen [jobId] --json
auto-chat dispatch
auto-chat doctor <jobId>
auto-chat retry <jobId>
auto-chat open <jobId>
```

旧的 `npm run job:*` 脚本仍保留用于兼容已有工作流；本地调试和自举请使用 `npm link` 后的真实 `auto-chat` CLI。

## 任务 JSON

图片任务：

```json
{
  "id": "img_order_test_002",
  "mode": "image",
  "prompt": "生成一张图，要求严格按顺序：红色裙子。每张图人物一致。",
  "expectedImageCount": 1,
  "sourceImages": []
}
```

文本任务：

```json
{
  "id": "text_test_001",
  "mode": "text",
  "prompt": "请用一句话介绍一下太阳系。",
  "sourceImages": []
}
```

`mode` 省略时默认为 `image`。

## 诊断

查看任务摘要：

```bash
auto-chat doctor <jobId>
```

如果任务需要人工接管：

```bash
auto-chat open <jobId>
```

如果任务是可重试失败：

```bash
auto-chat retry <jobId>
auto-chat dispatch
auto-chat listen <jobId>
```

## 开发

```bash
npm run build
npm run check
npm test
```

详细 agent/自动化集成协议见 `docs/agent-integration.md`。
