# auto-chat

<div align="center">

## Browser AI Automation for Local Agents

**Automate ChatGPT & Gemini in your own browser — no API key, no credentials, no cloud.**

[![npm](https://img.shields.io/npm/v/auto-chat-cli?color=blue&label=npm)](https://www.npmjs.com/package/auto-chat-cli)
[![license](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![platform](https://img.shields.io/badge/platform-GPT%20%2B%20Gemini-purple)](https://github.com/leo-306/auto-chat)

[中文](README.md) · [Agent Integration](docs/agent-integration.md) · [Skill Docs](skills/auto-chat/SKILL.md)

</div>

---

**auto-chat** is a local GPT/Gemini browser automation tool. It manages a task queue via a local service, lets a Chrome extension take over your already-logged-in ChatGPT or Gemini tab, and hands results back to your Agent or script via CLI, SSE, and local files.

Use cases:

- Let local Agents (Claude Code, Codex, Cursor) call GPT/Gemini pages to complete tasks.
- Batch-submit image generation, image understanding, and text Q&A tasks, saving results as local files.
- Wire browser AI capabilities into local automation workflows without exposing credentials or managing web state.
- Build secondary development on top for your own content pipelines, asset generation, and test systems.

## Why auto-chat?

| | auto-chat | Official API |
|---|---|---|
| Cost | Uses your existing subscription | Per-token billing |
| Image gen access | GPT-4o, Gemini native | API may differ |
| Setup | Chrome extension + local server | API key required |
| Privacy | Local only, no cloud relay | Requests leave your machine |

## Key Features

- **Local-first**: Tasks, input images, and output files all live in `data/` by default — no remote task platform needed.
- **GPT + Gemini**: One CLI schedules both platforms; the `platform` field in the task JSON selects the target.
- **Text and image**: `mode: "text"` writes `output-01.txt`; `mode: "image"` writes `output-01.*` image files.
- **Agent-friendly**: `auto-chat dispatch/listen/doctor/open` — Agents never need to touch browser DOM directly.
- **Targeted dispatch**: `auto-chat dispatch --platform gemini <jobId>` prevents older queued jobs from being picked up by mistake.
- **Observable, diagnosable, retryable**: SSE pushes real-time status; use `doctor`, `retry`, or `open` on failure.
- **Persistent tabs**: Set `persistTab: true` on a job to keep the browser tab open after completion, ready for follow-up.
- **Multi-turn conversations**: Set `parentJobId` on a new job to reuse the parent job's existing tab and append to the same conversation thread. Works on both GPT and Gemini.
- **Stable Gemini image input**: Reference images are pasted directly into the Gemini input box; the extension waits for the send button to become active before submitting.
- **Reliable text collection**: Text is collected via the page's copy-response button; stale `auto-chat`-prefixed clipboard content is ignored.

## How It Works

```text
Agent / CLI / Script
  → auto-chat local service  127.0.0.1:17321
  → Chrome MV3 extension
  → ChatGPT / Gemini tab
  → data/jobs/<jobId>/outputs/
```

auto-chat does **not** manage your GPT/Gemini credentials. The browser tab still uses your own login session.

Extension popup panel:

![Extension popup](docs/插件.png)

## Quick Start

### Install via Agent (recommended)

If you're using Claude Code, Codex, or Cursor, just ask:

```text
Help me install https://github.com/leo-306/auto-chat — including the CLI and Chrome extension — then start the service.
```

The Agent will handle npm install, `auto-chat init`, and the extension setup steps automatically.

### Manual install

Install the CLI:

```bash
npm install -g auto-chat-cli
```

Initialize the local service and Agent skill:

```bash
auto-chat init
```

`auto-chat init` starts the background service, opens the Chrome extensions page, and prints the plugin download path and install guide. Unzip [auto-chat-extension.zip](auto-chat-extension.zip) to a fixed directory, enable Developer mode at [chrome://extensions](chrome://extensions), then click **Load unpacked**.

Install the Chrome extension:

1. Download or locate [auto-chat-extension.zip](auto-chat-extension.zip).
2. Unzip it to a fixed directory.
3. Open [chrome://extensions](chrome://extensions) and enable **Developer mode**.
4. Click **Load unpacked** and select the unzipped directory.

Task dashboard: `http://127.0.0.1:17321/`

![Task list](docs/任务列表.png)

Service management:

```bash
auto-chat status
auto-chat start
auto-chat stop
```

The extension is paused by default and won't auto-pick from the queue. Click "Run dispatch once" in the popup, or trigger via CLI.

## Agent Integration

### Claude Code example

After installing the skill via `auto-chat init`, send a natural-language request:

```text
Use auto-chat to generate a minimalist white coffee shop interior image with ChatGPT. Tell me where the image is saved when done.
```

Claude Code example (Gemini image generation, full flow):

![Claude Code call 1](docs/claude%20调用%201.png)

![Claude Code call 2](docs/claude%20调用%202.png)

### Codex example

```text
Use auto-chat to generate a cyberpunk-style cat avatar with Gemini. Send me the image file path when done.
```

![Gemini task execution](docs/Gemini%20任务执行.png)

### Other Agents / scripts

HTTP dispatch:

```bash
curl -X POST http://127.0.0.1:17321/dispatch \
  -H 'content-type: application/json' \
  --data '{"platform":"gemini","jobId":"gemini_text_test_001"}'
```

SSE event stream:

```text
GET http://127.0.0.1:17321/events
```

Full protocol: [docs/agent-integration.md](docs/agent-integration.md)

## Commands

```bash
auto-chat start
auto-chat status
auto-chat stop

auto-chat add <job.json> [--replace] [--auto-id]
auto-chat add <job.json> --platform gpt
auto-chat add <job.json> --platform gemini

auto-chat list
auto-chat show <jobId>
auto-chat show <jobId> --json

auto-chat dispatch
auto-chat dispatch --platform gpt
auto-chat dispatch --platform gemini
auto-chat dispatch --platform gpt <jobId>
auto-chat dispatch --platform gemini <jobId>

auto-chat concurrency
auto-chat concurrency 3

auto-chat listen [jobId]
auto-chat listen [jobId] --json
auto-chat doctor <jobId>
auto-chat retry <jobId>
auto-chat reload <jobId>
auto-chat open <jobId>
```

Recommended for Agents and scripts:

```bash
auto-chat dispatch --platform <gpt|gemini> <jobId>
```

This makes the extension pick up the specific job, avoiding accidental dispatch of older queued jobs on the same platform.

The default max concurrency is 1. To handle multiple tasks simultaneously:

```bash
auto-chat concurrency        # view current setting
auto-chat concurrency 3      # set to 3 (range: 1–8)
```

The setting is persisted to the local service config; the extension picks it up on the next dispatch cycle.

## Your First Task

GPT text task:

```bash
auto-chat add examples/text-job.json --replace
auto-chat dispatch --platform gpt text_test_001
auto-chat listen text_test_001
```

Output:

```text
data/jobs/text_test_001/outputs/output-01.txt
```

Gemini text task:

```bash
auto-chat add examples/gemini-text-job.json --replace
auto-chat dispatch --platform gemini gemini_text_test_001
auto-chat listen gemini_text_test_001
```

Image task:

```bash
auto-chat add examples/job.json --replace
auto-chat dispatch --platform gpt img_order_test_002
auto-chat listen img_order_test_002
```

Images are written to:

```text
data/jobs/<jobId>/outputs/output-01.*
data/jobs/<jobId>/outputs/output-02.*
```

## Task Types

### Text task

```json
{
  "id": "text_test_001",
  "platform": "gpt",
  "mode": "text",
  "prompt": "Describe the solar system in one sentence.",
  "sourceImages": []
}
```

For Gemini, change `platform` to `"gemini"`:

```json
{
  "id": "gemini_text_test_001",
  "platform": "gemini",
  "mode": "text",
  "prompt": "Introduce yourself in one sentence.",
  "sourceImages": []
}
```

Text is collected via the page's copy-response button. If the clipboard content starts with `auto-chat`, it's treated as a stale command string and ignored; the extension keeps waiting for the real response.

### Text task with reference images

```json
{
  "id": "gemini_text_image_001",
  "platform": "gemini",
  "mode": "text",
  "prompt": "Identify and briefly describe the content of this image.",
  "sourceImages": ["/absolute/path/to/input.png"]
}
```

Both GPT and Gemini support `sourceImages`. For Gemini, the extension pastes images directly into the input box (no file picker) and waits for the send button to become active before submitting.

### Persistent tabs and follow-up conversations

By default the extension closes the tab when a job finishes. To continue in the same conversation thread:

1. Set `persistTab: true` on the parent job — the tab stays open after completion.
2. Set `parentJobId` on the follow-up job — the extension reuses the parent's open tab. If the tab is gone it falls back to the parent's recorded `conversationUrl`.

```json
{
  "id": "parent_001",
  "platform": "gpt",
  "mode": "text",
  "prompt": "Describe the solar system in one sentence.",
  "sourceImages": [],
  "persistTab": true
}
```

```json
{
  "id": "followup_001",
  "platform": "gpt",
  "mode": "text",
  "prompt": "You just described the solar system. Now describe the Milky Way in one sentence.",
  "sourceImages": [],
  "parentJobId": "parent_001",
  "persistTab": true
}
```

Works on both GPT and Gemini. The follow-up job sends into the existing conversation — the model retains the prior context.

### Image task

```json
{
  "id": "img_order_test_002",
  "platform": "gpt",
  "mode": "image",
  "prompt": "Generate an image: red dress. Keep the character consistent across images.",
  "expectedImageCount": 1,
  "sourceImages": []
}
```

### Gemini multi-image task

Gemini generates one image per conversation. For multiple images, use a `prompts` array — each element describes one image:

```json
{
  "id": "gemini_img_test_001",
  "platform": "gemini",
  "mode": "image",
  "prompt": "Generate two images of the same character in different outfits.",
  "prompts": [
    "An Asian woman in a red dress standing outside a street café, realistic lifestyle photography, half-body to full-body shot, single subject only.",
    "The same Asian woman in a blue dress sitting by a café window, realistic lifestyle photography, half-body shot, single subject only."
  ],
  "expectedImageCount": 2,
  "sourceImages": []
}
```

The extension generates them serially in array order and saves them as `output-01.*`, `output-02.*`.

## Output & Status

Text output:

```text
data/jobs/<jobId>/outputs/output-01.txt
```

Image output:

```text
data/jobs/<jobId>/outputs/output-01.*
data/jobs/<jobId>/outputs/output-02.*
```

Image ordering rules:

- GPT: collected in page card order, deduplicated by `file_...` key.
- Gemini multi-image: collected by serial round index.
- `events.jsonl` records an `image_order` event to confirm the sequence.

Status guide:

```text
done              → success, read outputs/
failed_retryable  → auto-chat retry <jobId>
has conversation URL, just needs reload check
                  → auto-chat reload <jobId>
needs_manual / failed_final
                  → auto-chat open <jobId>
stalled / refreshing
                  → auto-chat listen <jobId>
other             → still running
```

Diagnose:

```bash
auto-chat doctor <jobId>
auto-chat show <jobId>
cat data/jobs/<jobId>/events.jsonl
```

## Development

Repository layout:

```text
apps/server      Local Fastify service, CLI, task storage, SSE
apps/extension   Chrome MV3 extension, page automation, result collection
packages/shared  Shared types, protocol schema, prompt helpers
examples         Example task JSON files
skills/auto-chat Agent skill
docs             Integration protocol docs
```

Dev commands:

```bash
npm install
npm run build
npm run check
npm test
```

Dev tips:

- After changing the extension or shared protocol, run `npm run build` and reload `apps/extension/dist` in Chrome.
- The service must be managed via `auto-chat start` / `auto-chat stop`; don't run `node apps/server/dist/index.js` directly.
- Use the global `auto-chat` CLI for real task flows; don't treat the browser page as the primary state source.
- When changing the task protocol, state machine, or HTTP API, keep [docs/agent-integration.md](docs/agent-integration.md) and [skills/auto-chat/SKILL.md](skills/auto-chat/SKILL.md) in sync.

Package and install locally:

```bash
npm run build
npm pack
npm install -g ./auto-chat-cli-*.tgz
auto-chat init
```

Pack the Chrome extension zip:

```bash
npm run pack:extension
```

The generated `auto-chat-extension.zip` has `manifest.json` at the root. Commit it alongside the code so users can download and unzip it directly from GitHub.

## Security

- Only automates your own already-logged-in GPT/Gemini tabs.
- Never stores platform passwords or cookies.
- Never bypasses platform login, captcha, or permission mechanisms.
- All task data writes to local `data/` (excluded from Git).
