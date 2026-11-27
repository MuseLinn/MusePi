---
title: request_login
status: living
summary: 请用户保存网站登录信息，由浏览器自动填写，且不向智能体暴露凭据。
scope:
  - packages/coding-agent/src/tools/request-login.ts
  - packages/coding-agent/src/secrets/agent-store.ts
  - packages/coding-agent/src/daemon/approval-bridge.ts
  - packages/coding-agent/src/tools/browser/login-fill.ts
---

# request_login

[English](request_login.md) | 中文

> 请用户提供网站登录信息，用户名、密码和一次性验证码都不会暴露给智能体。

存储、范围与加密契约见 [`docs/secrets.md`](../secrets.zh-CN.md)。本页只定义工具侧契约。

## 来源
- 入口：`packages/coding-agent/src/tools/request-login.ts`
- 存储：`packages/coding-agent/src/secrets/agent-store.ts`
- UI 通道：`packages/coding-agent/src/daemon/approval-bridge.ts`
- 浏览器填写：`packages/coding-agent/src/tools/browser.ts`、`packages/coding-agent/src/tools/browser/login-fill.ts`

## 输入

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `name` | `string` | 是 | 登录标签，匹配 `/^[A-Z][A-Z0-9_]{0,63}$/`，例如 `ACME_PORTAL`。 |
| `site` | `string` | 是 | 要登录的站点，例如 `example.com`。 |
| `purpose` | `string` | 是 | 一行说明智能体要在该站点做什么。 |

## 输出
- `content[0].text` 给出已保存登录的名字，并指示智能体使用该名字调用浏览器工具的 `action: "fill_login"`。
- `details` 为 `{ name, site, status, fillWith: "browser" }`，其中 `status` 为 `"available"`、`"saved"` 或 `"cancelled"`。
- 两个字段都不包含用户名、密码、两步验证设置密钥或生成的一次性验证码。

## 流程
1. 工具校验名字、站点和用途。
2. 若同站点已有可解密且范围覆盖当前工作目录的登录，直接返回 `"available"`，不打开卡片。保存登录即为授权，填写不构成第二次披露。
3. 否则用户可以保存登录，或选择同站点的另一条已存登录。daemon 在请求落定前完成持久化。
4. 成功后，智能体用返回的名字调用 `browser` 的 `action: "fill_login"`。daemon 通过自己的浏览器连接填写并提交表单，不经过模型编写的 `browser run` 代码。
5. 条目带两步验证设置密钥时，在本地生成一次性验证码，只用于本次填写。
6. 取消不写入任何内容。宿主没有交互式凭据通道时直接抛错，并提示用户前往「设置 → 保险库」。

## 副作用
- 保存加密的登录，或扩展现有登录的工作目录范围。
- 只向智能体返回登录名字与站点。
- 页面没有密码框时如实报告，不猜测其他输入框填写。

## 参见
- [`docs/secrets.md`](../secrets.zh-CN.md) —— 加密存储、范围与锁定
- [`browser`](./browser.md) —— 浏览器工具操作
- [`request_secret`](./request_secret.zh-CN.md) —— 请求非登录密钥而不暴露值
