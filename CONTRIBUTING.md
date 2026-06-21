# Contributing

感谢你愿意改进 auto-chat。

## 开发流程

```bash
npm install
npm run build
npm run check
npm test
```

本项目包含本地 Fastify 服务、Chrome MV3 插件和共享类型包。改动前请先阅读相关文件，尽量保持改动聚焦。

## 提交前检查

- 不要提交 `data/`、任务输出、截图、日志或本地数据库。
- 如果改了任务协议、CLI 输出或插件行为，请同步更新 README 和 `docs/agent-integration.md`。
- 如果改了服务端存储或共享 schema，请补充测试。

## 插件开发

构建后从 Chrome 加载：

```text
apps/extension/dist
```

插件自动化的是用户自己已登录的 ChatGPT 页面，不应收集、上传或保存用户账号凭据。
