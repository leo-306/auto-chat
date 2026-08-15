# Agent 集成协议

本文档说明 Codex 或其他 agent 如何与 auto-chat 交互。

## 架构

```text
Agent / Codex
  -> CLI / HTTP / SSE / webhook
  -> 本地服务 127.0.0.1:17321
  -> Chrome 插件
  -> GPT / Gemini 页面
```

agent 的机器接口是真实安装后的 `auto-chat` CLI、本地服务和 SSE；不是 GPT/Gemini 网页 DOM。调试和自举必须先 `npm link`，再通过全局 `auto-chat` 命令执行。

## 启动与加载

```bash
npm install
npm run build
npm link
auto-chat --version
auto-chat init
auto-chat status
```

`auto-chat --version`（或 `-v`）输出当前 CLI 版本号，读取自打包后的 `package.json`，用于确认 `PATH` 上运行的是哪个构建。

`auto-chat init` 会安装 agent skill、启动本地服务，并每次打开 `chrome://extensions`，提示用户从 GitHub 或本机 npm 包里的 `auto-chat-extension.zip` 解压安装插件。

运行数据默认保存在系统用户数据目录：macOS 使用 `~/Library/Application Support/auto-chat`，Linux 使用 `$XDG_DATA_HOME/auto-chat`（默认 `~/.local/share/auto-chat`），Windows 使用 `%LOCALAPPDATA%\auto-chat`。通过 `AUTO_CHAT_DATA_DIR` 可以覆盖默认位置。旧版当前工作区下的 `data/jobs.sqlite` 会在新目录为空时随任务文件一起非破坏性迁移；`server.pid` 和 `server.log` 不会复制。

本地开发的 Chrome 插件加载目录：

```text
apps/extension/dist
```

分发用 Chrome 插件 zip：

```bash
npm run pack:extension
```

服务健康检查：

```bash
curl http://127.0.0.1:17321/health
```

停止后台服务：

```bash
auto-chat stop
```

macOS 默认通过当前用户的 `launchd` 运行 `com.auto-chat.server`。服务异常退出时会自动重启，登录后也会自动启动；`auto-chat stop` 会卸载该 LaunchAgent，因此不会被立即重启。日志文件位于数据目录的 `server.log`，达到 10MB 后自动轮转并保留最近三份备份；其中会记录启动、退出信号和未捕获异常，排查时优先查看该文件。

插件默认处于暂停状态，不会自动 claim 队列任务。点击 popup 的“执行一次调度”会执行一次手动调度；点击“开启自动执行”才会持续自动领取队列任务。

agent 需要远程触发插件领取一轮队列时，使用 dispatch：

```bash
auto-chat dispatch
auto-chat dispatch --platform gpt
auto-chat dispatch --platform gemini
auto-chat dispatch --platform gpt <jobId>
auto-chat dispatch --platform gemini <jobId>
curl -X POST http://127.0.0.1:17321/dispatch
```

dispatch 不会开启自动执行，只会让插件在下一次后台 tick 时强制 claim 一轮。推荐 agent 同时传 `--platform` 和 `<jobId>`，避免同平台旧队列任务先被领取。只传 `--platform` 时，插件会领取该平台最早的 queued 任务；不传 `--platform` 时会唤醒所有平台。

插件调度最大并发数默认是 1，可用 CLI 查看或设置：

```bash
auto-chat concurrency
auto-chat concurrency 3
```

HTTP 也支持指定平台和任务：

```bash
curl -X POST http://127.0.0.1:17321/dispatch \
  -H 'content-type: application/json' \
  --data '{"platform":"gemini","jobId":"gemini_text_test_001"}'
```

`GET /dispatch` 会返回当前调度信号：

```json
{
  "id": 1,
  "token": "每次派发生成的新 UUID",
  "platform": "gemini",
  "jobId": "gemini_text_test_001",
  "requestedAt": "2026-06-23T00:00:00.000Z"
}
```

### 排队任务未被领取

`queued` 仅表示服务端允许领取，不表示插件已经接管。插件不会领取的常见原因是：目标平台仍暂停、插件未运行或无法连接本地服务、该平台已达到 `maxConcurrency`，或者插件内存中残留了一个服务端已经不处于运行态的 worker。后者通常发生在手工把运行中任务改回 `queued`、服务/插件重载、或旧版本状态不同步之后。

先用 `auto-chat doctor <jobId>` 和插件 popup 确认平台、暂停状态及正在处理的 worker。对于仍为 `queued` 且多次定向 dispatch 后没有 `job_claimed` 事件的任务，可以调用以下恢复接口。它只清理该任务遗留的 `tabId`、`workerId`、错误信息并生成新的定向调度信号；不会修改提示词、输出或尝试次数：

```bash
curl -X POST http://127.0.0.1:17321/jobs/<jobId>/dispatch/reset
```

非 `queued` 任务会返回 `409 job_not_queued`，避免中断正在执行的工作。管理页的排队任务行也提供“解除阻塞”按钮；它等价于该接口。完整过程会写入 `job_dispatch_reset` 事件。

## 创建任务

任务 JSON 示例：

```json
{
  "id": "img_order_test_001",
  "platform": "gpt",
  "mode": "image",
  "prompt": "生成四张图，严格按顺序：图1红色外套，图2蓝色外套，图3绿色外套，图4黄色外套。",
  "expectedImageCount": 4,
  "sourceImages": []
}
```

Gemini 图片任务示例：

```json
{
  "id": "gemini_img_test_001",
  "platform": "gemini",
  "mode": "image",
  "prompt": "生成两张人物一致的单人外套图片。",
  "prompts": [
    "一位亚洲女生穿红色外套，城市街头真实生活摄影，单人半身构图，画面只包含这一张图片。",
    "同一位亚洲女生穿蓝色外套，咖啡店窗边真实生活摄影，单人半身构图，画面只包含这一张图片。"
  ],
  "expectedImageCount": 2,
  "sourceImages": []
}
```

Gemini 一次对话只生成一张图片。多图任务推荐使用 `prompts` 数组，每个元素只描述一张图片；插件按数组顺序串行生成，并按轮次保存 `output-01.*`、`output-02.*`。

常规文本任务示例：

```json
{
  "id": "text_test_001",
  "platform": "gpt",
  "mode": "text",
  "prompt": "请用一句话介绍一下太阳系。",
  "sourceImages": []
}
```

Gemini 文本任务示例：

```json
{
  "id": "gemini_text_test_001",
  "platform": "gemini",
  "mode": "text",
  "prompt": "请用一句话介绍一下你自己。",
  "sourceImages": []
}
```

`platform` 省略时默认为 `gpt`，`mode` 省略时默认为 `image`。GPT 和 Gemini 都支持文本输入，可选附带 `sourceImages`；`image` 模式输出图片，`text` 模式通过插件点击响应的复制按钮获取文本。若剪贴板仍是以 `auto-chat` 开头的旧命令文本，插件会忽略该内容并继续等待真实复制结果，仍然取不到时才失败。

Gemini 带 `sourceImages` 的任务不会打开文件选择器。插件会把参考图直接粘贴到 Gemini 输入框，等待发送按钮解除禁用后再提交。Gemini 纯文本任务也会在提交后确认当前 `JOB_ID` 的用户消息已出现在对话中。

创建任务：

```bash
auto-chat add examples/job.json
auto-chat dispatch --platform gpt img_order_test_001
auto-chat listen img_order_test_001
```

如果 JSON 里的 `id` 已存在：

```bash
auto-chat add examples/job.json --auto-id
auto-chat add examples/job.json --replace
```

`--auto-id` 会忽略 JSON 中的 `id` 并创建新任务；`--replace` 会删除旧任务和旧产物后按同一个 `id` 重建。

本地图片路径可以放入 `sourceImages`，服务端会复制到 `data/jobs/<jobId>/source/`，并转换成 localhost URL 给插件上传。

## 状态机

主要状态：

```text
queued
opening_tab
waiting_chat_ready
uploading
sending_prompt
waiting_generation
stalled
refreshing
collecting_outputs
downloading
done
failed_retryable
failed_final
needs_manual
```

agent 判断：

```text
done -> 成功
failed_retryable -> 可自动重试
needs_manual / failed_final -> 人工接管
stalled / refreshing -> 继续监听
其他 -> 运行中
```

## Codex 诊断命令

一次性诊断：

```bash
auto-chat doctor <jobId>
```

输出分类：

```text
OK
RUNNING
RECOVERING
RETRYABLE
NEEDS_MANUAL
```

查看详情：

```bash
auto-chat show <jobId>
cat data/jobs/<jobId>/events.jsonl
```

## 非轮询监听

CLI：

```bash
auto-chat listen <jobId>
```

非 JSON 模式会在连接事件流前输出安全的运行环境与任务上下文，包括
`JOB_SERVER_URL` 的取值来源、数据目录、平台、模式、当前状态、是否为
reload-only、父任务/标签页复用、停滞与硬超时、刷新上限和自动重试配置。
关键状态会附带当前阶段说明；发生可处理异常时会直接给出完整的
`retry -> dispatch -> listen` 或 `doctor -> open` 命令。

`--json` 模式保持纯 JSON/NDJSON，不会混入上述说明文字。连接事件流前会先
输出一条 `type: "job_snapshot"` 的当前任务快照；如果任务已经结束，输出快照后
立即退出，不会在 SSE 上空等：

```bash
auto-chat listen <jobId> --json
```

如果出现 `Prompt was filled but no submitted ... user turn appeared`，说明插件
没有确认当前 `JOB_ID` 的用户消息已经进入对话。此类错误应执行 `retry` 重新
提交，不应执行 `reload`；`reload` 只重新打开并监控已经提交的对话，不会发送
提示词。reload-only 恢复若找不到对应用户消息，会立即转为 `failed_retryable`，
不再空等到刷新次数耗尽。

监听全部任务：

```bash
auto-chat listen
```

底层 SSE：

```text
GET http://127.0.0.1:17321/events
```

每条事件格式：

```json
{
  "type": "status",
  "jobId": "img_001",
  "job": {
    "id": "img_001",
    "status": "waiting_generation"
  },
  "event": {
    "type": "status",
    "payload": {
      "status": "waiting_generation"
    },
    "at": "2026-06-20T00:00:00.000Z"
  },
  "at": "2026-06-20T00:00:00.000Z"
}
```

### 扩展诊断追踪

每个任务的重要插件决策都会额外写入 `extension_trace` 事件，包括 content script 的首个监控快照、显式错误/中断判断、恢复选择，以及后台的刷新、重启和产物采集。追踪数据只记录状态、图片计数、签名和错误摘要，不重复写入提示词。

排查图片任务时先查看：

```bash
auto-chat listen <jobId>
rg 'extension_trace' ~/Library/Application\ Support/auto-chat/jobs/<jobId>/events.jsonl
```

其中 `component` 为 `content` 或 `background`，`stage` 表示具体决策点；例如 `content.monitor_recovery_selected` 会记录触发恢复的页面快照和原因，`background.stall_refresh_requested` 会记录消耗的刷新额度。

## Webhook

配置回调：

```bash
curl -X PATCH http://127.0.0.1:17321/config \
  -H 'content-type: application/json' \
  --data '{"webhookUrls":["http://127.0.0.1:18080/codex-hook"]}'
```

清空回调：

```bash
curl -X PATCH http://127.0.0.1:17321/config \
  -H 'content-type: application/json' \
  --data '{"webhookUrls":[]}'
```

服务端会对每个任务事件异步 POST 同一份 ServerEvent JSON。Webhook 失败不会阻塞任务流程。

## 输出文件与顺序

文本模式输出：

```text
data/jobs/<jobId>/outputs/output-01.txt
```

任务详情中的 `textOutputFile` 会指向该文件。

图片模式输出目录：

输出目录：

```text
data/jobs/<jobId>/outputs/
```

文件名：

```text
output-01.*
output-02.*
output-03.*
output-04.*
```

顺序规则：

- `output-01` 对应提示词中的图1。
- `output-02` 对应提示词中的图2。
- `output-03` 对应提示词中的图3。
- `output-04` 对应提示词中的图4。

GPT 任务按生图卡片顺序采集，并按 estuary `file_...` 去重；Gemini 多图任务按串行轮次采集。同一张图片可能在 DOM 中出现多次，不能直接按 `<img>` 数量判断。

### 自定义输出目录

创建任务时可以在 JSON 中加入可选字段 `outputDir`，指定一个额外目录，每次保存图片 artifact（`kind: "output"`）时都会额外复制一份到该目录，文件名与 `outputs/` 下相同。**该功能仅支持图片任务，且不会改变原有的 `data/jobs/<jobId>/outputs/` 存储逻辑**——这是一次纯粹的额外复制，不是替换或迁移。

```json
{
  "id": "img_order_test_003",
  "prompt": "生成两张图，要求严格按顺序：红色球、蓝色花园。",
  "expectedImageCount": 2,
  "sourceImages": [],
  "outputDir": "/Users/alice/Desktop/auto-chat-out"
}
```

- **仅对 `mode: "image"` 任务生效。** `text_output`（文本结果）不会被复制；文本任务（`mode: "text"`）设置 `outputDir` 也不会有任何效果。
- **不影响 `data/jobs/<jobId>/outputs/` 的原有落盘逻辑。** 该目录始终是每个任务的标准产物位置，写入方式与是否设置 `outputDir` 无关；`outputDir` 只是在此基础上把同一份文件再复制一份到别处。复制失败（例如目录不可写）不会导致任务失败，也不会影响 `outputs/` 中已保存的产物，只会记录一条 `output_copy_failed` 事件。
- CLI (`auto-chat add`) 会把相对路径解析为相对于当前工作目录的绝对路径后再发给服务端，因为后台服务是常驻进程，其自身工作目录与调用 `add` 时的目录通常不同；直接调用 HTTP `POST /jobs` 的 agent 需要自行传入绝对路径。
- `Job` 对象上新增 `outputDir`（string | null）和 `copiedOutputFiles`（string[]，已成功复制的文件绝对路径列表）两个字段，`auto-chat show` / `auto-chat doctor` / `auto-chat listen` 均会展示指定目录和当前复制状态。

复制相关事件：

```bash
grep -e output_copied -e output_copy_failed data/jobs/<jobId>/events.jsonl
```

示例：

```json
{"type": "output_copied", "payload": {"path": "/Users/alice/Desktop/auto-chat-out/output-01.png"}}
{"type": "output_copy_failed", "payload": {"outputDir": "/Users/alice/Desktop/auto-chat-out", "message": "Error: EACCES: permission denied, ..."}}
```

顺序映射事件：

```bash
grep image_order data/jobs/<jobId>/events.jsonl
```

示例：

```json
{
  "type": "image_order",
  "payload": {
    "images": [
      { "index": 1, "sourceId": "file_..." },
      { "index": 2, "sourceId": "file_..." }
    ]
  }
}
```

## 异常处理

```text
failed_retryable
  -> auto-chat retry <jobId>

已有对话 URL 且只需重新加载检查
  -> auto-chat reload <jobId>

needs_manual
  -> auto-chat open <jobId>

stalled / refreshing
  -> auto-chat listen <jobId>
```

常见原因：

- ChatGPT 页面出现 `Something went wrong` / `Retry`。GPT 图片任务若已在当前 `JOB_ID` 范围内发现足量图片，会优先采集并标记成功；若页面仍在生成，插件会点击一次 Stop answering 后再稳定采集。否则首次错误会进入一次 `stalled -> refreshing`，刷新已提交的对话后再尝试页内 Retry，仍失败才标记为 `failed_retryable`。
- Gemini 图片粘贴后发送按钮长期保持禁用，说明图片上传未完成或页面未接受粘贴。
- 生成状态超过默认的 5 分钟无变化。
- 总等待超过 15 分钟。
- 插件找不到输入框、上传控件或生成图片 DOM。
- Tab 被人工关闭。

## Agent 约束

- 不要把浏览器页面当作主状态源。
- 不要自行猜测图片输出顺序；读取 `output-xx` 和 `image_order`。
- 不要在未确认 `done` 时消费 outputs。
- 修改插件 DOM 检测后，必须重新构建并重新加载 Chrome 插件。
