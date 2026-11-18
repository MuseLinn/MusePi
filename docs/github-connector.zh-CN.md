---
layout: default
title: GitHub 连接器
status: living
summary: 注册 OAuth 应用以便 GitHub 连接器登录，以及 GitHub 为什么需要它。
scope:
  - packages/coding-agent/src/connectors/bundled-catalog.ts
---

# GitHub 连接器

[English](github-connector.md) | [中文](github-connector.zh-CN.md)

GitHub 连接器连接的是 GitHub 自己的远程 MCP 服务器
`https://api.githubcopilot.com/mcp/`。登录走 GitHub 的授权服务器
`github.com/login/oauth`。

## 为什么必须注册应用

GitHub 的授权服务器不提供注册端点——[github-mcp-server 的 issue 里记着同一件事](https://github.com/github/github-mcp-server/issues/1404)。
客户端因此无法按 RFC 7591 描述的方式自我注册，任何想登录的客户端都得带上一个手工注册好的 OAuth 应用。

GitHub 也不接受只有 PKCE 的交换：请求里带 code verifier 却不带 client secret 时，token 端点会回答
`incorrect_client_credentials`。所以浏览器回调那条路需要 client id 与 client secret 两者。

## 设备码：两者都不需要

同一个授权服务器也提供 OAuth 2.0 设备码流程，而设备码既不需要 client secret，也不需要回调地址——只要一个
在应用设置里开启了 device flow 的 client id。MusePi 自带一个为此注册的应用：

| | |
| --- | --- |
| Client ID | `Ov23liWleGB0BcR9IPBm` |
| Device flow | 已开启 |
| Callback URL | `http://127.0.0.1:3000/callback` |

连接器页面因此提供「用设备码登录」：服务器给出一个短码，用户打开验证页输入它，客户端轮询拿到授权。
没有进程需要监听端口，同一套流程在手机上也能走。

这条路已经端到端验证过：设备码换到了带 `repo` 与 `read:org` scope 的 token，
`api.githubcopilot.com/mcp/` 接受了这个 token，`get_me` 返回了它所属的账号。

## Token 兜底

设备码这条路依赖厂商提供它，也依赖账号被允许授权这个应用。两者不成立时，连接器页面还提供
「用 Token 连接」：粘贴一个 personal access token，它就替代登录。

两条路不会抢同一个字段。Token 走授权头；当 OAuth 授权存在时，manager 会用授权的凭据替换掉这个头，
所以一次成功的登录绝不会被悄悄降级成 token。Token 存在加密的连接器密钥存储里，目录里只记字段名。

openchamber 对 GitHub 走的就是这条路——它的目录里 GitHub 那条只有 personal access token 表单，完全不用 OAuth。

## 注册你自己的应用

只有走浏览器回调，或者你想用自己的应用连同一个服务器时才需要。

1. 打开 <https://github.com/settings/developers>，选 **OAuth Apps**，再点 **New OAuth App**。
2. 填表：
   - **Application name** — 随意，例如 `MusePi`。
   - **Homepage URL** — 你自己应用的页面地址。
   - **Authorization callback URL** — `http://127.0.0.1:3000/callback`。
3. 想用设备码就勾上 **Enable Device Flow**。
4. 点 **Register application**，再点 **Generate a new client secret**。

secret 属于加密的连接器密钥存储，绝不进目录。

## 回调地址

GitHub 接受 loopback 地址，但 host 和 path 必须和注册时填的一致：用字面量 `127.0.0.1` 而不是 `localhost`，路径必须正好是 `/callback`。端口不必一致——GitHub 文档说 loopback 的 `redirect_uri` 可以用任意端口，授权会落在客户端实际请求的那个端口上。

`http://127.0.0.1:3000/callback` 是 MusePi 实际请求的地址。桌面端注册的 scheme 是 `musepi://oauth/callback`，GitHub 不接受这种自定义 scheme；见下面的说明。

## 这个连接器能做什么

服务端是 GitHub 自己的，所以提供的是 GitHub 对仓库、Issue、拉取请求与 Actions 的工具。目录通过 `X-MCP-Toolsets` 请求头把工具集收窄到 `context,repos,issues,pull_requests`，让一次会话只拿到用得上的那部分。

拿到的 token 权限由你注册的应用和 GitHub 授予的 scope 决定。请申请刚好够用的最小范围：私有仓库需要 `repo`，组织成员关系需要 `read:org`。

## 连不上时

- **`incorrect_client_credentials`** —— client id 或 secret 填错了，或者 secret 在你复制之后被重新生成过。GitHub 每次生成新 secret 时旧的立刻失效。
- **`redirect_uri_mismatch`** —— 应用里登记的回调地址和流程实际用的不一致。请按上面的地址精确登记，端口和 `/callback` 路径都要一致。
- **授权页一直不出现** —— 该条目在没有 client 的情况下被挂载了。先把表单填完；没有 client id 和 secret 的 GitHub 连接器不会被挂载。
