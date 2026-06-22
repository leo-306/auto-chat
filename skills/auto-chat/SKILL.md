---
name: auto-chat
description: Use when working with the local ChatGPT automation system, especially starting or stopping the task service, creating jobs, listening to jobs, validating Chrome extension behavior, or documenting Agent integration. Requires real installed auto-chat CLI flows instead of npm run shortcuts.
---

# auto-chat

## Core Rule

Use the installed `auto-chat` CLI as the source of truth for local debugging and self-tests.

Do not validate user-facing workflows through `npm run job:*` or direct service imports. Keep `npm run build`, `npm run check`, and `npm test` for development verification only.

## Setup

For production-style local use, install the package globally and initialize the agent integration:

```bash
npm install -g <package-or-tarball>
auto-chat init
auto-chat status
```

`auto-chat init` installs this skill into common global agent skill directories and starts the background service.

For repository development only:

```bash
npm install
npm run build
npm pack
npm install -g ./wechat-topic-*.tgz
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

Create and inspect jobs through the real CLI:

```bash
auto-chat add examples/text-job.json --replace
auto-chat add examples/job.json --replace
auto-chat list
auto-chat show <jobId>
auto-chat doctor <jobId>
auto-chat dispatch
auto-chat listen <jobId>
```

Use `auto-chat listen <jobId> --json` when raw SSE event shape matters.

Text output lives at `data/jobs/<jobId>/outputs/output-01.txt`. Image output lives under `data/jobs/<jobId>/outputs/`; use `image_order` events to confirm image order.

## Chrome Extension

After extension or shared protocol changes:

```bash
npm run build
```

Reload Chrome from:

```text
apps/extension/dist
```

The extension should automate only the user's own logged-in ChatGPT page. Do not drive ChatGPT manually through browser tooling when the local service, CLI, SSE, or job files can provide the needed state.

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
auto-chat list
auto-chat show text_test_001
auto-chat doctor text_test_001
auto-chat stop
```
