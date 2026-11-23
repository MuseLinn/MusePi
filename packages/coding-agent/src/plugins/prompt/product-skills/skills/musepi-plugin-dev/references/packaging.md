# 打包与分发

## 打包

`musepi plugin pack [path] [-o dir] [--json]` 生成可分发的 `.tgz`。

它要求包有 `name`、`version` 和 `musepi` 清单，检查声明的入口存在，然后调用 `bun pm pack`。不访问 registry，也不执行 publish。

`bun pm pack` 会把 `workspace:*` 依赖解析成具体版本，因此本地 workspace 包打出来的 tarball 是可安装的。

包体积只应有源码与构建产物：编译器的增量状态放在 `node_modules/.cache/`，不要落进 `lib/`。

## 公开发布

要让别人按包名安装，走包 registry 的发布流程（版本、依赖与 `engines` 由包管理器校验）。

`plugin pack` 只打包——**不要把「打包成功」报告成「已发布」**。

## 进市场

市场是「一个仓库存一份 catalog」。仓库根放 `.omp-plugin/marketplace.json`（Claude Code 兼容用 `.claude-plugin/marketplace.json`），`plugins[]` 每项写 `name` / `description` / `version` / `source`；`source` 可以是相对路径、npm 包名或 git 地址。

## 分发来源

用户执行 `/marketplace add <owner/repo>`（或桌面端能力中心 → 市场添加来源）后即可发现与安装。

未发布、只在本机的包仍可走插件页的 spec 安装（tarball / 本地目录 / git）。

## 自检

安装完成后看能力报告（runnable / partial / blocked）与插件详情。槽位没有挂载点的组件显示为 partial，不会静默消失。

发布结果以 registry 与 catalog 的实际内容为准，不要把本地路径或未发布的 tarball 报告为已发布。