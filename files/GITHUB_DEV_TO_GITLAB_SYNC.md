# 本地 `dev-fengfeng` 经 GitHub `dev` 自动同步到 GitLab `dev-fengfeng` 操作手册

本文用于在其他工程中复用以下方案：

- 开发者在本地 `dev-fengfeng` 分支工作，并将其推送到 GitHub 的 `dev` 分支。
- GitHub Actions 自动把同一提交推送到自建 GitLab 的 `dev-fengfeng` 分支。
- 首次迁移时，可另外把本地 `master` 推送到 GitLab。
- GitLab 仅作为同步目标，不在 GitLab 的 `dev-fengfeng` 分支直接开发。

> 当前已验证的实例：GitHub `fengfengnt/dshcloud` → GitLab `http://8.133.188.56:9091/fengfeng/dshcloud.git`。
>
> 当前 GitLab 只支持 HTTP。令牌会经 HTTP 明文传输，存在被窃取的风险。其他工程应优先给 GitLab 配置 HTTPS；只有明确接受风险时才沿用 HTTP。

## 1. 需要准备的信息

执行前替换以下占位符：

| 占位符 | 示例 | 说明 |
| --- | --- | --- |
| `<LOCAL_REPO>` | `D:\Code\example` | 本地工程目录 |
| `<GITHUB_OWNER>` | `fengfengnt` | GitHub 用户或组织 |
| `<REPO>` | `example` | 项目名 |
| `<GITLAB_BASE>` | `http://8.133.188.56:9091` | GitLab 地址 |
| `<GITLAB_NAMESPACE>` | `fengfeng` | GitLab 用户或群组 |
| `<GITLAB_HOST>` | `8.133.188.56` | GitLab 主机，用于 `NO_PROXY` |

目标地址为：

```text
GitHub: git@github.com:<GITHUB_OWNER>/<REPO>.git
GitLab: <GITLAB_BASE>/<GITLAB_NAMESPACE>/<REPO>.git
```

## 2. 检查本地仓库

在 PowerShell 中执行：

```powershell
Set-Location '<LOCAL_REPO>'
git status --short --branch
git remote -v
git branch --show-current
```

确认：

- 当前目录是独立 Git 仓库根目录。
- GitHub remote 可用，本文假设名称为 `origin`。
- 本地开发分支是 `dev-fengfeng`，GitHub 源分支是 `dev`，GitLab 目标分支是 `dev-fengfeng`。
- 工作区没有未确认的改动。

如需为当前工程单独配置提交身份：

```powershell
git config user.name 'fengfeng'
git config user.email 'fengfeng@aicaigou.online'
```

不要加 `--global`，除非确定要修改所有仓库的默认身份。

## 3. 在 GitLab 创建空项目

在 `<GITLAB_BASE>/<GITLAB_NAMESPACE>` 下创建 `<REPO>` 项目。

建议创建空项目，不要初始化 README、许可证或 `.gitignore`。如果项目已经初始化，也可以继续，但首次推送时要注意已有分支可能与本地历史无关。

添加 GitLab remote：

```powershell
git remote add gitlab '<GITLAB_BASE>/<GITLAB_NAMESPACE>/<REPO>.git'
git remote -v
```

如果 `gitlab` 已存在，先核对地址；需要修改时执行：

```powershell
git remote set-url gitlab '<GITLAB_BASE>/<GITLAB_NAMESPACE>/<REPO>.git'
```

## 4. 首次推送 `dev-fengfeng` 和 `master`

如果 Windows 配置了全局代理，而 GitLab 地址不应经过代理，可只对当前 PowerShell 进程设置：

```powershell
$env:NO_PROXY = '<GITLAB_HOST>,localhost,127.0.0.1'
```

HTTP GitLab 可能被 Git Credential Manager 判定为不安全。仅对该命令允许 HTTP 凭据：

```powershell
git -c credential.allowUnsafeRemotes=true push gitlab dev-fengfeng:dev-fengfeng
git -c credential.allowUnsafeRemotes=true push gitlab master:master
```

如果本地没有 `master`，不要凭空创建；先用下面的命令查看实际分支：

```powershell
git branch --all
```

验证远端分支：

```powershell
git -c credential.allowUnsafeRemotes=true ls-remote gitlab refs/heads/dev-fengfeng refs/heads/master
```

## 5. 创建最小权限 GitLab 项目访问令牌

进入 GitLab 项目：

```text
Settings → Access Tokens（设置 → 访问令牌）
```

建议配置：

| 字段 | 值 |
| --- | --- |
| Token name | `github-dev-sync` |
| Description | `Sync GitHub dev branch to GitLab dev-fengfeng` |
| Expiration date | 按组织策略设置，例如一年 |
| Role | `Developer` |
| Scope | 只勾选 `write_repository` |

创建后立即复制令牌。GitLab 通常只显示一次，不要把令牌写入仓库、Markdown、命令历史或工作流文件。

## 6. 把令牌保存为 GitHub Actions Secret

进入 GitHub 项目：

```text
Settings → Secrets and variables → Actions → New repository secret
```

创建：

```text
Name:   GITLAB_SYNC_TOKEN
Secret: <刚创建的 GitLab 项目访问令牌>
```

必须先创建 Secret，再推送同步工作流，避免第一次 Action 因缺少令牌而失败。

## 7. 添加 GitHub Actions 工作流

创建 `.github/workflows/sync-gitlab.yml`：

```yaml
name: Sync dev to GitLab dev-fengfeng

on:
  push:
    branches: [dev]
  workflow_dispatch:

jobs:
  sync:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - name: Push dev to GitLab dev-fengfeng
        env:
          GITLAB_SYNC_TOKEN: ${{ secrets.GITLAB_SYNC_TOKEN }}
        run: git push "<GITLAB_BASE_WITHOUT_PROTOCOL_PLACEHOLDER>" HEAD:dev-fengfeng
```

把最后一行替换为以下格式之一。

HTTPS（推荐）：

```yaml
        run: git push "https://oauth2:${GITLAB_SYNC_TOKEN}@<GITLAB_HOST>/<GITLAB_NAMESPACE>/<REPO>.git" HEAD:dev-fengfeng
```

HTTP（仅在明确接受明文风险时使用）：

```yaml
        run: git push "http://oauth2:${GITLAB_SYNC_TOKEN}@<GITLAB_HOST>:<PORT>/<GITLAB_NAMESPACE>/<REPO>.git" HEAD:dev-fengfeng
```

注意：

- 不要把真实令牌直接写进 YAML。
- 不要在脚本中启用 `set -x`，否则可能把带凭据的命令打印到日志。
- 默认不使用 `--force`。如果 GitLab `dev-fengfeng` 出现独立提交，同步会失败而不是覆盖数据。
- 若确实要求 GitHub 永远覆盖 GitLab，应先确认 GitLab `dev-fengfeng` 没有人直接开发，再单独评估强制推送策略。

## 8. 提交并推送工作流

```powershell
git add .github/workflows/sync-gitlab.yml
git diff --cached --check
git diff --cached -- .github/workflows/sync-gitlab.yml
git commit -m 'ci: sync dev branch to GitLab'
git push origin HEAD:dev
```

这次推送会触发第一次同步。

## 9. 验证同步结果

先获取三个提交号：

```powershell
$env:NO_PROXY = '<GITLAB_HOST>,localhost,127.0.0.1'

$local = git rev-parse HEAD
$github = (git ls-remote origin refs/heads/dev).Split("`t")[0]
$gitlab = (git -c credential.allowUnsafeRemotes=true ls-remote gitlab refs/heads/dev-fengfeng).Split("`t")[0]

"local=$local"
"github_dev=$github"
"gitlab_dev=$gitlab"
```

三个完整 SHA 一致，表示同步成功。

再检查：

```powershell
git status --short --branch
```

预期本地 `dev-fengfeng` 与 `origin/dev` 指向同一提交，工作区干净。

也可以在 GitHub 的 `Actions` 页面确认 `Sync dev to GitLab dev-fengfeng` 运行成功。

## 10. 后续日常使用

正常开发只需要：

```powershell
git switch dev-fengfeng
git push origin HEAD:dev
```

GitHub Actions 会自动把该提交推送到 GitLab `dev-fengfeng`。

本工作流只把 GitHub `dev` 同步到 GitLab `dev-fengfeng`，不会自动修改 GitLab `master`。如果需要同步其他分支，应为分支增加明确规则，不要默认同步所有分支或标签。

## 11. 常见故障

### GitLab 地址被本地代理转发

症状可能包括连接 `127.0.0.1` 代理、超时或代理拒绝。

处理：

```powershell
$env:NO_PROXY = '<GITLAB_HOST>,localhost,127.0.0.1'
```

这只影响当前 PowerShell 进程，不修改全局代理配置。

### Git Credential Manager 拒绝 HTTP

症状：提示不允许在非加密 HTTP remote 上使用凭据。

处理：

```powershell
git -c credential.allowUnsafeRemotes=true push gitlab dev-fengfeng:dev-fengfeng
```

长期方案仍然是为 GitLab 配置 HTTPS。

### GitHub Action 推送被拒绝

依次检查：

1. GitHub Secret 名称是否严格为 `GITLAB_SYNC_TOKEN`。
2. GitLab 令牌是否过期或被撤销。
3. 令牌角色是否至少为 `Developer`。
4. 是否勾选 `write_repository`。
5. GitLab URL、端口、命名空间和项目名是否正确。
6. GitLab `dev-fengfeng` 是否出现 GitHub 没有的独立提交。

### HTTP GitLab 无法被 GitHub 托管 Runner 访问

确认 GitLab 的端口允许公网访问。若只在内网开放，需要改用能访问该内网的 GitHub self-hosted runner，或通过安全网络连接；不要为了同步临时暴露管理端口。

## 12. 交给其他 Agent 的任务模板

可以把下面内容连同本手册路径交给其他 Agent：

```text
请按照 files/GITHUB_DEV_TO_GITLAB_SYNC.md，为当前独立 Git 仓库配置本地 dev-fengfeng → GitHub dev → 自建 GitLab dev-fengfeng 自动同步。

要求：
1. 先检查当前分支、remote、工作区和现有 workflow，不覆盖无关配置。
2. GitLab 项目不存在时告诉我需要手动创建；存在时复用。
3. 使用 Project Access Token，Developer 角色，只授予 write_repository。
4. 令牌只保存为 GitHub Actions Secret：GITLAB_SYNC_TOKEN，禁止写入文件或输出日志。
5. GitLab 若只有 HTTP，必须先说明明文传输风险，并在我明确接受后继续。
6. 工作流仅把 GitHub dev 同步到 GitLab dev-fengfeng，不使用 --force，不自动修改 master。
7. 推送后验证本地 dev-fengfeng、GitHub dev、GitLab dev-fengfeng 的完整 commit SHA 一致。
8. 把不能自动完成或需要我确认的步骤明确列出。
```

## 13. 本方案的验证记录

在 `dshcloud` 中，本方案已验证：

- GitHub `dev` 推送触发 GitHub Actions。
- GitLab `dev-fengfeng` 自动更新。
- 本地 `dev-fengfeng`、GitHub `dev`、GitLab `dev-fengfeng` 最终指向同一个完整提交。
- GitLab `master` 保持独立，不被该工作流修改。
