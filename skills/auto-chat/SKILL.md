---
name: auto-chat
description: Use when working with the local GPT/Gemini browser automation system, including service lifecycle, job creation, platform dispatch, SSE listening, Chrome extension validation, or agent integration docs.
---

# auto-chat

## Core Rule

Use the real `auto-chat` CLI as the source of truth for local debugging and self-tests.

Do not validate user-facing workflows through `npm run job:*` or direct service imports. Keep `npm run build`, `npm run check`, and `npm test` for development verification only.

## Setup

For production-style local use, install the package globally and initialize the agent integration:

```bash
npm install -g <package-or-tarball>
auto-chat init
auto-chat status
```

`auto-chat init` installs this skill into common global agent skill directories, starts the background service, opens `chrome://extensions`, and always prints Chrome extension installation steps with the GitHub zip URL and local npm package zip path.

For repository development only:

```bash
npm install
npm run build
npm pack
npm install -g ./auto-chat-cli-*.tgz
auto-chat --help
```

Do not use `npm link` for production-flow testing. If the CLI output does not come from the intended installed package, rebuild, pack, and reinstall the tarball.

## Service Workflow

Start and stop the local task service only through the CLI:

```bash
auto-chat start
auto-chat status
auto-chat stop
```

The service must run in the background. Do not leave a foreground `auto-chat server`, `npm run dev:server`, or direct `node apps/server/dist/index.js` session running for normal debugging.

Use `JOB_SERVER_URL=http://127.0.0.1:<port>` only when intentionally isolating a test service on a non-default port.

## Job Workflow

Create and inspect jobs through the real CLI. Prefer platform-specific dispatch so a GPT task does not wake Gemini and a Gemini task does not wake GPT:

```bash
auto-chat add examples/text-job.json --replace
auto-chat add examples/job.json --replace
auto-chat add examples/gemini-job.json --replace
auto-chat add examples/gemini-text-job.json --replace
auto-chat list
auto-chat show <jobId>
auto-chat doctor <jobId>
auto-chat dispatch --platform gpt <jobId>
auto-chat dispatch --platform gemini <jobId>
auto-chat concurrency 3
auto-chat listen <jobId>
```

Use `auto-chat listen <jobId> --json` when raw SSE event shape matters. Prefer passing both `--platform` and `<jobId>` to `dispatch`; this asks the extension to claim that specific queued job and avoids older queued tasks on the same platform being picked first. Omitting `<jobId>` claims the oldest queued task for the selected platform. Omitting `--platform` wakes all platforms.

Use `auto-chat concurrency` to inspect the current plugin scheduler max concurrency, and `auto-chat concurrency <1-8>` to update it. The default is 1.

Text output lives at `data/jobs/<jobId>/outputs/output-01.txt`. Image output lives under `data/jobs/<jobId>/outputs/`; use `image_order` events to confirm image order.

Gemini image jobs should use `prompts: string[]` for multi-image tasks. Each array entry must describe exactly one image; the extension sends entries one by one because Gemini generates one image per conversation. GPT image jobs may still use a single multi-image prompt.

GPT and Gemini text jobs both support optional `sourceImages`; set `mode: "text"` for text output and `mode: "image"` for image output. Gemini source images are pasted directly into the composer, not uploaded through the file picker. The extension waits until Gemini's send control is no longer disabled before submitting.

For text outputs, the extension uses the platform copy action where available. If the clipboard still contains an old command beginning with `auto-chat`, treat it as stale automation text and keep waiting for a real copied response before marking the job failed.

## Persistent Tabs and Follow-up Jobs

Set `persistTab: true` to keep the browser tab open after a job finishes. Set `parentJobId` on a follow-up job to reuse the parent's existing tab (or fall back to its `conversationUrl` if the tab is closed). Both GPT and Gemini support this.

Example flow:

```bash
# Step 1: run parent job with tab kept open
auto-chat add examples/persist-tab-job.json --replace
auto-chat dispatch --platform gpt persist_test_001 && auto-chat listen persist_test_001

# Step 2: run follow-up job in same conversation thread
auto-chat add examples/followup-job.json --replace
auto-chat dispatch --platform gpt followup_test_001 && auto-chat listen followup_test_001
```

The follow-up job sends into the existing conversation — the model retains prior context. Do not close the parent tab between steps if you want guaranteed tab reuse.

## Chrome Extension

After extension or shared protocol changes:

```bash
npm run build
```

To create the committed zip that users download from GitHub:

```bash
npm run pack:extension
```

Reload Chrome from:

```text
apps/extension/dist
```

The extension should automate only the user's own logged-in GPT/Gemini pages. Do not drive GPT/Gemini manually through browser tooling when the local service, CLI, SSE, or job files can provide the needed state.

## Required Verification

Before reporting completion for code changes:

```bash
npm run build
npm run check
npm test
auto-chat --help
auto-chat init
auto-chat start
auto-chat status
auto-chat stop
```

For task-flow changes, also run a real CLI job flow against the background service and inspect the CLI output:

```bash
auto-chat start
auto-chat add examples/text-job.json --replace
auto-chat dispatch --platform gpt text_test_001
auto-chat list
auto-chat show text_test_001
auto-chat doctor text_test_001
auto-chat stop
```

For full HTTP/SSE/webhook details, use `docs/agent-integration.md`. The skill is the quick operating guide; the doc is the detailed protocol reference.
