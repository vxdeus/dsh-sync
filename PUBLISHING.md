# 公开发布流程

本目录只包含通用插件源码。**不要发布原始工作区、旧版专用目录、用户 profile 或同步备份。**

## 1. 发布前检查

使用 Node.js 24+ 及标准 npm 工具，在本目录执行：

```sh
node scripts/verify-public.mjs
node scripts/test.mjs
node scripts/release.mjs
node scripts/smoke-package.mjs
```

- 隐私检查必须成功；它只能识别预设结构与常见泄露模式，仍需人工逐文件审查。
- 完整测试必须成功；不能将失败忽略或从测试列表移除。Windows 链接权限不足和原生宿主集成未配置会显示跳过，不能将其表述为已完成对应覆盖。沙箱导致的文件元数据异常应在正常 Windows 环境复核。
- 在 GitHub Actions 完成 Windows 和 Ubuntu 双平台检查。
- 使用隔离测试 profile 通过 DSH 官方插件管理器安装打包产物，完全退出／冷启动，再验证工具注册、现有 GUI 面板、未配置远端时禁止传输、合成数据上传／恢复和确认安装流程。不要拿真实用户数据做发布测试。
- 源码不含 `node_modules` 或 DSH 宿主内部包。运行时 Git 库依赖由插件安装器安装；宿主服务按 peer dependency／能力检测获取。

本机测试／打包不证明市场已收录，也不证明 GitHub CI 已运行。保留各阶段真实结果。

## 2. 打包与内容边界

`release:pack` 生成：

- `dist/dsh-sync.tgz`：市场使用的稳定文件名。
- `dist/dsh-sync-0.6.0.tgz`：同字节的带版本号副本。
- `dist/SHA256SUMS`：SHA256 校验和。

发布脚本仅调用 `npm pack --ignore-scripts`，不执行 npm 发布、不访问同步远端。它拒绝链接及非显式白名单成员，并核对归档中每个普通文件与源码一致。测试、脚本、GitHub Actions、市场申请材料不进入插件安装包。

**不要将项目根目录整体打成 zip 后公开。** 不要附带个人 Gitee / GitHub 私有数据仓库地址、服务器地址／用户、公钥授权配置、私钥、令牌、设备路径、会话、附件、工程、运行日志或旧快照。

## 3. 源码与 GitHub Release

发布前必须由仓库所有者明确同意公开上传。既定公开源码目标：

https://github.com/vxdeus/dsh-sync

只将本公开目录经审查的源文件提交到仓库，不向该仓库推送任何私人备份。检查默认分支为 `main`、许可证、说明文档及更新日志齐全；版本号和标签必须一致。

[Release Action](.github/workflows/release.yml) 在推送稳定标签 `v0.6.0` 时执行测试并创建公开 Release；**推送标签本身就是发布动作**。也可对已存在标签手动触发，并在确认框输入 `PUBLISH`；其他确认值不会进入发布链路。

- 独立 `resolve` job 校验稳定 `vX.Y.Z` 标签，从明确的 `refs/tags/` 命名空间解析轻量／附注标签为 commit SHA；Windows、Ubuntu 测试和发布 job 均 checkout 这一个 SHA，不再分别解析可移动标签。
- 双平台各自运行测试、白名单打包及隔离 package smoke；仅在全部成功后上传两份 tgz 和 SHA256SUMS artifact。发布必须等待两个平台成功，且只下载本次工作流 Ubuntu 已测的 artifact，不重新打包、不执行包内代码。
- 发布 job 核对文件名及 `sha256sum --check --strict`，从相同 SHA 的 [CHANGELOG.md](CHANGELOG.md) 读取说明。创建前再次读取远端标签并核对其剥离后的 commit SHA；标签移动、删除或既有 Release 都拒绝发布。只创建新 Release，不使用资产覆盖／`--clobber`。
- 默认仅 `contents: read`；只有发布 job 具有 `contents: write`，checkout 不持久保存凭据。

**仍必须保护发布标签**：为 `v*` 设置仓库 tag ruleset，限制创建者并禁止更新／删除，约束绕过权限；同时保护发布工作流与可信代码的变更审核。末次标签检查与 GitHub 创建 Release 不是原子操作，无法消除其间的竞态，固定 SHA 和校验和也不能代替标签保护、可信代码审核或签名／来源证明。

若该版本已经公开，不要改写旧标签或替换资产；增加版本号并更新说明、市场材料及测试。下载端可使用的稳定资产链接为：

https://github.com/vxdeus/dsh-sync/releases/latest/download/dsh-sync.tgz

发布前确认下载地址真实可达，核对其 SHA256 与本次构建相同。

## 4. 市场提交

市场申请草稿位于 [vxdeus__dsh-sync.yml](docs/market-submission/vxdeus__dsh-sync.yml)。只有 GitHub Release 成功且资产可下载后，才按市场维护方当前规则提交／更新申请：

- 向 **[awesome-dsh-plugin/awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)** 提交 PR，目标条目为 `data/plugins/vxdeus__dsh-sync.yml`；不要把生成的 README 当作条目源手工修改，也不要修改其他插件的条目。
- 仓库必须创建满 **1 天**，添加 **`dsh-plugin` topic**，声明可安装的 `dsh.bundle` manifest，包含真实可用的代码并保持维护；描述应与代码功能准确一致。
- CI 通过只是前置条件，合并仍需**维护者阅读目标仓库并审核**，可能调整分类或说明。申请草稿、绿色 CI 或预构建安装包都不是已获收录／安全审计的证明。
- 本流程采用 **GitHub Release 安装包**分发，不要求 `npm publish`；条目的可选 `tarball:` 应指向 GitHub Release 托管的 HTTPS `.tgz`。`latest/download/` 应使用不带版本号的稳定文件名，避免下次发布后旧文件名失效。

**列表／第三方市场收录不等于官方 Discover index 可见。** 维护方 README 说明，供 DSH 官方 Discover 添加的 format-1 index 仅覆盖已发布 npm 且有已知版本的插件；GitHub-only 条目仍可按列表旁的命令安装，但不能保证进入该 index。包名占用、npm 登录、npm 发布、列表审核和 Discover 可见性是不同事项。

当前规范来源：[贡献指南](https://raw.githubusercontent.com/awesome-dsh-plugin/awesome-dsh-plugin/main/contributing.md) 与 [README 的 index 说明](https://raw.githubusercontent.com/awesome-dsh-plugin/awesome-dsh-plugin/main/README.md)。提交前重新核对规则；本文不代表申请已提交或已通过。

## 5. 发布与个人同步分离

公开更新只更新插件代码。每个使用者在自己的设备配置自己的私有 Git 或 SFTP，并自行完成登录／密钥授权。安装代码不能被视为授权上传私人数据；发布工作不能自动触发用户的上传、下载、恢复或插件升级。
