# Contributing to memware / 参与 memware

[English](#english) · [简体中文](#简体中文)

## English

memware is in pre-release validation. The most useful participation today is reproducible product feedback, documentation corrections, real use cases, and narrowly scoped, verifiable code changes.

memware is licensed under the [MIT License](LICENSE). Unless explicitly stated otherwise, contributions submitted for inclusion in memware are provided under the same license.

### Choose the right entry point

- Reproducible product or runtime problem: use the Bug form.
- New user outcome or capability: use the Feature request form.
- Missing or misleading documentation: use the Documentation report form.
- Tutorials, showcases, and questions: use GitHub Discussions.
- Security vulnerability: use [private vulnerability reporting](https://github.com/HackSing/memware/security/advisories/new), never a public Issue.

Search existing Issues first. Remove API keys, real user memory, raw conversations, personal paths, and other sensitive data from every log or screenshot.

### Local development

```sh
git clone https://github.com/HackSing/memware.git
cd memware
bun install
bun run test
bun run typecheck
bun run content:check
```

For binary or packaging changes, also run:

```sh
bun run memware:build
bun run memware:pack
```

### Pull request standard

1. Solve one clear user problem and describe the user-visible result.
2. Explain why the change is needed, what changed, how it was verified, and any compatibility or privacy impact.
3. Add tests for new behavior. Documentation-only changes must still verify links, commands, and factual claims.
4. Never commit API keys, real memory data, raw conversations, personal paths, or local databases.
5. Update the README source or `CHANGELOG.md` when user-visible behavior changes. Generated README files must not be edited directly.

## 简体中文

memware 当前处于预发布验证阶段。现阶段最有价值的参与方式是可复现的产品反馈、文档纠错、真实使用案例，以及范围清晰、可验证的代码变更。

memware 采用 [MIT 许可证](LICENSE)。除非明确另行声明，提交并合入 memware 的贡献将按同一许可证提供。

### 选择正确入口

- 可复现的产品或运行问题：使用 Bug 表单。
- 新的用户结果或能力建议：使用 Feature request 表单。
- 缺失或误导性文档：使用 Documentation report 表单。
- 教程、案例展示和问答：进入 GitHub Discussions。
- 安全漏洞：使用[私密漏洞报告](https://github.com/HackSing/memware/security/advisories/new)，不要创建公开 Issue。

提交前请搜索已有 Issue。日志和截图必须删除 API Key、真实用户记忆、原始对话、个人路径及其他敏感数据。

### 本地开发

```sh
git clone https://github.com/HackSing/memware.git
cd memware
bun install
bun run test
bun run typecheck
bun run content:check
```

涉及二进制或打包时，再运行：

```sh
bun run memware:build
bun run memware:pack
```

### Pull Request 标准

1. 只解决一个清晰用户问题，并说明用户可感知结果。
2. 解释为什么要改、改了什么、如何验证，以及兼容性或隐私影响。
3. 新行为需要测试；仅文档改动也要验证链接、命令和事实口径。
4. 不提交 API Key、真实记忆、原始会话、个人路径或本地数据库。
5. 用户可感知行为变化时，更新 README 事实源或 `CHANGELOG.md`；不要直接编辑生成的 README。
