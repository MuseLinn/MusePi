# `--profile` 语义对齐方案

## 现状：两根轴共用一个名字

| 轴 | 谁在用 | 语义 | 磁盘 |
|---|---|---|---|
| **状态隔离** | `packages/utils/src/dirs.ts` 的 `setProfile()` | 会话/设置/凭证**放在哪** | `~/.musepi/profiles/<name>/agent/` |
| **插件组合** | `bundle-service.ts` → `getActiveProfile()` → `profileDirFor()` | 装**什么**插件、叠哪些 bundle | `~/.musepi/profiles/<name>/` + `cordis.patch.yml` |

`profile-composition.ts` 的注释已经写明这是两根轴，并选择了「加第二根，不改第一根」。
现在要改成 dsh 语义：**`--profile` = 插件组合**。

## 冲突点

`getActiveProfile()` 同时被两处读取：

```
--profile work
   ├→ setProfile("work")  → PI_CODING_AGENT_DIR=~/.musepi/profiles/work/agent   （状态）
   └→ getActiveProfile()  → profileDirFor("work") → ~/.musepi/profiles/work/    （组合）
```

两者指向同一个目录，所以今天**碰巧**能共存——但语义是错的：
用户想「换一套插件组合」时，会话历史也跟着换了。

## 目标

```
--profile <name>   → 插件组合（dsh 语义）
--home <name>      → 状态隔离（原 --profile 的行为）
```

## 迁移（不丢数据）

启动时检测：若 `~/.musepi/profiles/<name>/agent/` 存在且用户只给了 `--profile`，
说明这是旧数据，**自动按 `--home` 处理**并打一条警告说明改名。
数据一个字节都不动。

## 改动清单

| 文件 | 改动 |
|---|---|
| `packages/utils/src/dirs.ts` | `setProfile` → `setHome`（保留 `setProfile` 作 deprecated 别名）；`MUSEPI_PROFILE` → `MUSEPI_HOME`（双向兼容读取）；新增 `getActiveHome()` |
| `packages/coding-agent/src/cli/profile-bootstrap.ts` | 预解析 `--profile` 与 `--home` 两个 flag |
| `packages/coding-agent/src/cli/args.ts` | 同上 |
| `packages/coding-agent/src/cli/flag-tables.ts` | 两个 flag 都进表 |
| `packages/coding-agent/src/cli.ts` | 按新语义接线 + 旧数据自动识别 |
| `bundle-service.ts` | `getActiveProfile()` 保持（现在语义正确了） |
| `help-extra.ts` | 帮助文本更新 |
| 测试 | 新增迁移测试 |

## 风险

- 跨包（`utils` + `coding-agent`），启动时序敏感
- `PI_CODING_AGENT_DIR` 环境变量被大量代码读取，不能破坏
- 桌面端/daemon 可能有独立的 profile 传参路径，需一并核对

## 不做的事

- 不改 `~/.musepi/profiles/<name>/` 的目录布局（dsh 也是这个布局）
- 不动已有用户数据
- 不引入新的配置文件格式
