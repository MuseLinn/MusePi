---
title: request_secret
status: living
summary: 向用户索取密钥而不暴露值；只返回环境变量名。
scope:
  - packages/coding-agent/src/tools/request-secret.ts
  - packages/coding-agent/src/secrets/agent-store.ts
  - packages/coding-agent/src/daemon/approval-bridge.ts
---

# request_secret

[English](request_secret.md) | 中文

> 向用户索取 Agent 在 bash 命令里需要使用的凭据，而 Agent 永远看不到值。

完整契约——存储、scope、RPC、超时与已知限制——见 [`docs/secrets.md`](../secrets.zh-CN.md)。本页是面向工具的根文档。

## 来源
- 入口：`packages/coding-agent/src/tools/request-secret.ts`
- 存储/运行时：`packages/coding-agent/src/secrets/agent-store.ts`、`packages/coding-agent/src/secrets/agent-runtime.ts`
- UI 通道：`packages/coding-agent/src/daemon/approval-bridge.ts`
- Wire 契约：`packages/wire/src/secret.ts`

## 输入

| 字段      | 类型     | 必填 | 说明                                                                 |
| --------- | -------- | ---- | -------------------------------------------------------------------- |
| `name`    | `string` | 是   | 环境变量后缀，匹配 `/^[A-Z][A-Z0-9_]{0,63}$/`，例如 `GITHUB_TOKEN`  |
| `purpose` | `string` | 是   | 一行说明该命令为什么需要这个密钥                                     |

## 输出
- `content[0].text` 给出环境变量名，例如
  `Secret GITHUB_TOKEN is available to bash as $MUSEPI_SECRET_GITHUB_TOKEN.`
  永不包含值。
- `details`：`{ name, envName, status }`，`status` 为 `"available"`、
  `"saved"` 或 `"cancelled"`。
- 宿主没有交互式密钥通道时直接抛错，而不是返回占位结果；错误信息会提示使用「设置 → 密钥」或 `secrets.yml`。

## 流程
1. 工具校验名字与用途。
2. 若名字已存储、可解密且本会话已授权，立即返回环境变量名。
3. 否则向宿主 UI 发送 `secret-request`：没有可用值时 `kind:"fill"`，已有存储值时 `kind:"allow"`。
4. 用户在卡片里输入（或替换）值并回答 `save`，或对已存储值选择 `allow`，或取消。daemon 在工具的 promise 落定之前完成 `save` 落盘；工具只知道最终动作。
5. 成功后，值只以 `$MUSEPI_SECRET_<NAME>` 进入 bash 子进程，并注册进会话 obfuscator。工具结果永不携带它。

## 副作用
- 持久化一个加密值（save），或记录会话级授权（allow）。
- 把值注册进活跃会话的 obfuscator。
- 取消与超时不写入任何内容。

## 参见
- [`docs/secrets.md`](../secrets.zh-CN.md) —— 存储布局、RPC、scope、限制
- [`list_secrets`](./list_secrets.zh-CN.md) —— 不显示值地查看名字