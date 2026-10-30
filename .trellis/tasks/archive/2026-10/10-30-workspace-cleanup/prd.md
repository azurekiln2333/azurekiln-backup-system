# chore: 忽略 AI 工具目录并收尾工作区

## 背景

当前分支 `fix/repository-host-fallback` 上有 14 个已修改文件和一批未跟踪文件。未跟踪内容中包含多个 AI 编码工具 / IDE 生成的配置目录（`.claude/`、`.codex/`、`.cursor/`、`.pi/` 等），以及尚未提交的 Trellis 任务目录。工作区不干净，妨碍判断真实代码改动与提交。

## 目标

1. 将 AI 工具 / IDE 生成的本地配置目录加入 `.gitignore`，避免污染 `git status`。
2. 将真实的产品变更（代码 + 文档 + Trellis 记录）按逻辑分组，使用标准化（Conventional Commits）提交语句提交。
3. 收尾 `10-25-repository-host-fallback` 任务，使工作区最终干净。

## 范围

### 包含

- 更新根 `.gitignore`
- 分组提交当前未提交的产品代码、测试、文档与 Trellis spec / 任务记录
- 归档 `10-25-repository-host-fallback` 任务

### 不包含

- 不修改任何产品逻辑行为（除提交已存在的改动外）
- 不删除历史提交、不做 rebase / squash
- 不新增功能

## 验收标准

1. `git status --short` 输出为空（忽略未跟踪文件全部被 `.gitignore` 覆盖或已提交）。
2. `.gitignore` 已覆盖 `.agent/`、`.claude/`、`.codebuddy/`、`.codex/`、`.cursor/`、`.dsh/`、`.kimi-code/`、`.opencode/`、`.pi/`、`.trae/`、`.zcode/`。
3. 提交信息符合 Conventional Commits（`feat:` / `fix:` / `docs:` / `chore:` / `test:` 等），单一提交内部改动主题一致。
4. `10-25-repository-host-fallback` 已归档，其对应代码改动已在提交中包含。
5. 已有测试命令仍然通过（若本次提交触达代码，则运行相关测试）。

## 约束

- 提交语句使用英文 subject，遵循 Conventional Commits。
- 如果测试失败且与本次提交内容相关，先修复再提交。
