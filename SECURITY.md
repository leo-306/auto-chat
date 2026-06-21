# Security Policy

## Supported Versions

当前项目处于早期阶段，安全修复会优先落到主分支。

## Reporting a Vulnerability

如果你发现安全问题，请不要公开发布可利用细节。请通过 GitHub Security Advisory 或维护者公开的私有联系方式报告。

报告中请包含：

- 影响范围
- 复现步骤
- 可能泄露或破坏的数据
- 你建议的修复方向

## Local Data

auto-chat 默认把任务数据、输出文件和本地数据库写入项目目录下的 `data/`。该目录不应提交到仓库，也不应分享给不可信第三方。

Chrome 插件只应自动化用户自己的 ChatGPT 浏览器页面。项目不托管 ChatGPT 账号、不保存登录凭据，也不绕过 ChatGPT 的登录或权限机制。
