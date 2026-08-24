# @musepi/mobile

MusePi 移动端伴侣 —— 基于 Capacitor 的 Android 应用。

## 设计

移动端界面遵循结构化设计规范 [`docs/mobile-design.md`](../../docs/mobile-design.md)：
信息架构、屏幕规格、交互与动效契约、原生集成（键盘 inset、状态栏、安全区、返回键分层导航、
本地通知）、无障碍与验收标准。

## 开发

```sh
bunx cap sync
bunx cap open android
```

用 Android Studio 构建；应用连接同一网络下正在运行的 musepi daemon。Web 资源由
`scripts/prepare-web-assets.mjs` 从 `desktop-web` 构建产出（仅移动端入口，无运行时重定向）。
