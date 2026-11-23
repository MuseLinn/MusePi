---
title: list_secrets
status: living
summary: 列出已存储 Agent 密钥的名字、用途、scope 与可用性，永不显示值。
scope:
  - packages/coding-agent/src/tools/list-secrets.ts
  - packages/coding-agent/src/secrets/agent-store.ts
---

# list_secrets

[English](list_secrets.md) | 中文

> 列出已存储的 Agent 密钥名字、用途、scope 与可用性——永不显示值。

完整契约见 [`docs/secrets.md`](../secrets.zh-CN.md)。

## 来源
- 入口：`packages/coding-agent/src/tools/list-secrets.ts`
- 存储/运行时：`packages/coding-agent/src/secrets/agent-store.ts`、`packages/coding-agent/src/secrets/agent-runtime.ts`

## 输入

无。

## 输出
- `content[0].text`：每个条目一行，包含名字、用途、scope 与是否在当前工作目录可用
  （`$MUSEPI_SECRET_<NAME>`）；存储为空时给出一句空态说明。
- `details.entries`：`{ name, purpose, scope, available, usable }[]`。
- 两个字段都不含值；`available` 是由解密是否成功得出的布尔值，`usable` 表示该条目可解密且 scope 覆盖当前会话的工作目录。

## 流程
1. 读取元数据 sidecar，并尝试解密每个列出的条目。
2. 信封无法解密的条目仍会列出，标记为
   `unavailable: value unreadable`，方便用户通过
   [`request_secret`](./request_secret.zh-CN.md) 或「设置 → 密钥」重新保存该值。
3. 只覆盖其他工作目录的条目会列出为已存储但当前不可用；
   [`request_secret`](./request_secret.zh-CN.md) 会为它打开 allow 卡片。

## 参见
- [`docs/secrets.md`](../secrets.zh-CN.md) —— 存储布局、RPC、scope、限制
- [`request_secret`](./request_secret.zh-CN.md) —— 收集缺失的值