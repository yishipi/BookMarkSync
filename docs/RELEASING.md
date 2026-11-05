# GitHub Releases 与 Packages

BookMarkSync 使用 **GitHub Releases** 分发可解压加载的扩展 ZIP、完整源码 ZIP 和 SHA-256 校验文件。GitHub Packages 面向 npm 依赖包、容器镜像等包管理器；普通扩展用户使用 Releases 下载即可。

## 已配置的自动流程

配置文件为 [`.github/workflows/release.yml`](../.github/workflows/release.yml)，工作流名称是 **Build and Release**。

| 操作 | 自动执行 |
| --- | --- |
| 推送到 `main` 或提交针对 `main` 的 PR | 校验版本、静态检查、单元测试、生成 ZIP，并保存 Actions 构建下载 |
| 推送 `v*` 版本标签 | 完成全部构建检查后，创建 Release 草稿、上传两个 ZIP 和校验文件，再正式发布 |
| Actions 页面点击 Run workflow | 对选择的代码执行检查和打包，保存构建下载；不发布正式 Release |

构建和发布任务固定使用 `ubuntu-24.04`，避免 `ubuntu-latest` 自动切换系统大版本；该发行版的托管镜像仍会获得更新。构建使用 Node.js 24，不需要执行 `npm install`，项目没有第三方运行时依赖。云端工作流执行 `npm run check`、`npm test`、`npm run package`；本机原生 Chrome / Edge、目录选择及授权交互测试仍需在本地执行，详见 `VALIDATION.md`。

工作流默认只读仓库内容，只有版本标签的发布任务使用 `contents: write`。授权来自 GitHub 自动生成的 `GITHUB_TOKEN`，不需要另外创建个人访问令牌或填写仓库 Secrets。

## 发布下一个版本

以下以 `1.0.2` 为例，实际发布时使用尚未发布过的版本号：

1. 将 `extension/manifest.json` 和 `package.json` 中的 `version` 同时改为 `1.0.2`，更新 README 和设置页页脚中的版本说明。
2. 在本机完成相关检查和测试，提交变更并推送到 `main`。
3. 对这个提交创建版本标签并推送：

```powershell
git add -- extension/manifest.json extension/options.html package.json README.md
git commit -m "chore: release 1.0.2"
git push origin main
git tag -a v1.0.2 -m "BookMarkSync 1.0.2"
git push origin v1.0.2
```

4. 打开仓库的 **Actions → Build and Release**，查看该标签对应的运行。全部通过后，在 [Releases](https://github.com/yishipi/BookMarkSync/releases) 中下载正式发布文件：

```text
BookMarkSync-extension-1.0.2.zip
BookMarkSync-source-1.0.2.zip
SHA256SUMS.txt
```

标签必须严格等于 `v` 加上两个 JSON 文件中的版本号；不一致时工作流会停止发布。发布版本使用三段数字，例如 `1.0.2`。平时提交代码和手动运行工作流只生成构建下载，不会自动增加版本号。

发布后的版本不自动覆盖。若上传中途失败，未完成的版本保留为草稿，可以在 Actions 对失败的运行选择 **Re-run failed jobs** 重试；流程会复用该标签的现有草稿。已正式发布的版本需要修正时，应使用新的版本号和标签。

## 手动构建与下载

进入仓库 **Actions → Build and Release → Run workflow**，选择 `main` 并运行。完成后，在运行详情的 **Artifacts** 中下载 `BookMarkSync-版本号`，里面包含两个 ZIP 和校验文件。构建下载保留 30 天，需要登录 GitHub；正式 Release 的公开文件可直接下载。

GitHub 默认生成的 **Source code (zip)** 是仓库源码快照；安装扩展时，优先下载本项目生成的 `BookMarkSync-extension-版本号.zip`，解压后加载包含 `manifest.json` 的目录。

## Packages 的可选配置

当前 `package.json` 的 `private: true` 用于防止误发布 npm 包，与 GitHub 仓库是否公开、能否发布 Release 无关。使用 Releases 时保持该设置即可。

如果将来需要让开发者通过 npm 安装项目资产，才需要另行配置 GitHub Packages：

1. 将包名改为带命名空间的小写名称，如 `@yishipi/bookmark-sync-local`，并移除 `private: true` 或设为 `false`。
2. 在 `package.json` 中加入下列字段，明确关联仓库、发布目标和允许打包的文件：

```json
{
  "name": "@yishipi/bookmark-sync-local",
  "private": false,
  "repository": {
    "type": "git",
    "url": "https://github.com/yishipi/BookMarkSync.git"
  },
  "publishConfig": {
    "registry": "https://npm.pkg.github.com"
  },
  "files": ["extension/", "README.md", "LICENSE"]
}
```

3. 在发布工作流中为 npm 发布任务授予 `contents: read`、`packages: write`，通过 `actions/setup-node` 设置 `registry-url: https://npm.pkg.github.com`，并将 `NODE_AUTH_TOKEN` 设为 `${{ secrets.GITHUB_TOKEN }}`，然后执行 `npm publish`。可以在同一发布工作流内执行此任务；不依赖由 `GITHUB_TOKEN` 创建的 Release 再触发另一条工作流。
4. 首次发布后，在包的 **Package settings** 中确认关联仓库和可见性；需要公开下载时，将包可见性设置为 Public。GitHub Packages 的 npm 包即使公开，安装时也需要身份验证。

上述 Packages 步骤是可选说明，当前仓库只启用扩展 ZIP 的构建与 Release 发布，不执行 `npm publish`。

官方参考：[管理 Releases](https://docs.github.com/en/repositories/releasing-projects-on-github/managing-releases-in-a-repository)、[下载 Actions 构建文件](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/download-workflow-artifacts)、[GitHub Packages 的 npm 配置](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-npm-registry)、[GITHUB_TOKEN 与工作流触发](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow)。

GitHub Releases 和 Packages 均属于项目分发方式。安装后的书签同步仍通过你选择的本地目录运行；发布到 GitHub 不会自动更新浏览器中手动加载的扩展，也不等于上架 Chrome / Edge 扩展商店。
