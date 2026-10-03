# musepi-git

MusePi 第一方插件。注册 `/git`，报告会话工作目录的仓库状态：分支（或 detached
HEAD）、短 commit，以及工作区计数。

## 为什么走宿主而不是自己跑 git

所有 git 访问都走宿主中央 helper（`@musepi/pi-coding-agent` 的 `repo.root`、
`head.resolve`、`status.summary`）。自己 spawn `git` 的插件等于重新实现一遍命令
超时、输出上限、reftable 判定和 Windows spawn 处理。

**刻意不报 ahead/behind**：中央 helper 没有对应的读取器（要用 `rev-list` 按两个
方向各拼一次，那就成了上面那个"第二套实现"问题）。补上 tracking 计数是改
`utils/git.ts`，不是改插件。

## 结构

| 文件                 | 职责                              |
| -------------------- | --------------------------------- |
| `src/index.ts`       | manifest 里声明的入口。只做装配。 |
| `src/git-command.ts` | `/git` 命令注册。                 |
| `src/repo-state.ts`  | 通过宿主 helper 读取仓库状态。    |
| `src/format.ts`      | 纯函数：状态 → 单行渲染。         |

入口刻意做得很薄——安装 → 加载 → 子模块热重载这条路径需要一个真实的多文件消费
者，而不是只有 fixture。

## 安装

插件随内置的 `packages/marketplace.json` 目录一起发布，名字是 `musepi-git`。

## 许可

UNLICENSED —— MusePi 第一方代码。
