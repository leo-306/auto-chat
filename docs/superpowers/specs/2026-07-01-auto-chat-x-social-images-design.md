# auto-chat X 配图设计

## 目标

为 auto-chat 的 X 发布帖制作三张 16:9 横版双语配图，分别说明产品优势、交互链路和 Agent 集成方式。图片应在时间线缩略图中保持清晰，并准确对应仓库现有能力。

## 统一视觉

- 风格：现代编辑式科技海报，采用瑞士平面设计式网格和克制的信息层级。
- 背景：浅灰米白；主文字：深蓝黑；点缀：亮橙和电光蓝。
- 标题：统一使用 `AUTO CHAT`，英文为主视觉，中文作为解释层。
- 图形：扁平几何、细线连接、终端窗口和流程节点；不使用第三方 Logo。
- 禁止：赛博朋克、霓虹夜景、复杂 3D、照片人物、装饰性乱码、水印。
- 文案：只使用规格中列出的文字；优先保证短句准确和可读。

## 图 1：产品优势

标题：`AUTOMATE GPT & GEMINI / 自动化 GPT 与 Gemini`

核心信息：

- `0 API TOKEN COST / 0 API Token 消耗`
- `ANY AGENT / 任意 Agent 集成`
- `CLI FIRST / CLI 化操作`
- `LOCAL FIRST / 本地优先`
- `TEXT + IMAGE / 文本与图片任务`
- `SSE · RETRY · MANUAL TAKEOVER / 监听 · 重试 · 人工接管`

构图：左侧为大号 `0` 和终端命令片段，右侧为六项能力卡片。底部用一行小字表达 `Use your own logged-in ChatGPT or Gemini page / 使用你已登录的网页`。

准确性约束：`0 API TOKEN COST` 指不调用模型 API、无需 API Key；不得表达为 ChatGPT/Gemini 订阅免费或无限生成。

## 图 2：交互链路

标题：`HOW AUTO CHAT WORKS / AUTO CHAT 如何工作`

主链路：

`Agent / CLI / Script` → `Local Fastify Service` → `Chrome MV3 Extension` → `ChatGPT / Gemini Page` → `Local Outputs`

辅助信息：

- `CLI · HTTP · SSE · Webhook`
- `127.0.0.1:17321`
- `data/jobs/<jobId>/outputs/`
- `Credentials stay in your browser / 凭据留在浏览器`

构图：中央为从左到右的五段链路，使用编号、箭头和分区底色；下方单独显示本地事件与文件回流路径。

## 图 3：Agent 集成

标题：`BUILT FOR AGENTS / 为 Agent 而生`

接入方：`Codex`、`Claude Code`、`Cursor`、`Your Script / 你的脚本`。

中心接口：`auto-chat CLI`、`SSE`、`HTTP`、`Webhook`。

任务生命周期：

`add` → `dispatch` → `listen` → `done`

异常分支：

- `failed_retryable` → `retry`
- `needs_manual` → `open`

构图：上方多个 Agent 入口汇入中央 auto-chat 接口，下方展开任务生命周期；用蓝色表示正常路径、橙色表示恢复和人工接管路径。

## 输出与验收

- 输出目录：`docs/social/x/`
- 文件名：`01-auto-chat-advantages.png`、`02-auto-chat-flow.png`、`03-auto-chat-agent-integration.png`
- 每张图必须是独立文件，横版 16:9，三张视觉一致。
- 检查标题、关键英文、中文语义、箭头方向和状态分支。
- 若生成模型无法稳定呈现全部小字，优先删减辅助文字，不修改技术链路。
