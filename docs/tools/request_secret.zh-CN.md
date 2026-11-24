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

| 字段       | 类型              | 必填 | 说明                                                                 |
| ---------- | ----------------- | ---- | -------------------------------------------------------------------- |
| `name`     | `string`          | 是   | 环境变量后缀，匹配 `/^[A-Z][A-Z0-9_]{0,63}$/`，例如 `GITHUB_TOKEN`  |
| `purpose`  | `string`          | 是   | 一行说明该命令为什么需要这个密钥                                     |
| `delivery` | `"env" \| "file"` | 否   | `"env"`（默认）给出 `$MUSEPI_SECRET_<NAME>`；`"file"` 给出私有路径   |

## 输出
- `content[0].text` 给出环境变量名（如
  `Secret GITHUB_TOKEN is available to bash as $MUSEPI_SECRET_GITHUB_TOKEN.`）
  或私有文件路径。永不包含值。
- `details`：`{ name, purpose, scope, delivery, envName?, filePath?, status }`，
  `status` 为 `"available"`、`"saved"` 或 `"cancelled"`；`scope` 为 `"all"`
  或条目覆盖的工作目录根列表。
- 宿主没有交互式密钥通道时直接抛错，而不是返回占位结果；错误信息会提示使用「设置 → 智能体 → 保险库」或 `secrets.yml`。

## 流程
1. 工具校验名字与用途。
2. 若名字已存储、可解密，且在当前工作目录可用，立即返回环境变量名。保存即授权：不会有第二次会话级 grant 卡片，重启后同样直接可用。
3. 若名字已存储但只覆盖其他工作目录，卡片为 `kind:"allow"`：允许后把当前工作目录加入 scope，不必重新输入值。
4. 否则卡片为 `kind:"fill"`。用户输入（或替换）值，并可选择仅本工作目录或所有会话；daemon 在工具的 promise 落定之前完成 `save` 落盘，工具只知道最终动作。
5. 成功后，`env` 交付的值只以 `$MUSEPI_SECRET_<NAME>` 进入已覆盖工作目录内的 bash 子进程；`file` 交付的值写到仅本人可读的私有文件，结果给出该路径。两者都会注册进会话 obfuscator。工具结果永不携带值。
6. 命令打印该变量时，输出显示 `[secret:<NAME>]`。这是预期的脱敏标记，不是失败；模型会被告知不要因此重试或报错。

## 副作用
- 持久化一个加密值（save）、交付方式与/或其 scope（allow）。
- 为 `file` 交付写入或移除私有工作副本。
- 把值注册进活跃会话的 obfuscator。
- 取消与超时不写入任何内容。
- 已在当前工作目录可用的值不需要再次授权：后续调用直接返回环境变量名，不再弹卡。

## 参见
- [`docs/secrets.md`](../secrets.zh-CN.md) —— 存储布局、RPC、scope、限制
- [`list_secrets`](./list_secrets.zh-CN.md) —— 不显示值地查看名字