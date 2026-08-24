# MusePi HarmonyOS Shell (WebView)

HarmonyOS NEXT shell for the shared MusePi desktop-web UI. Uses the ArkTS
`Web` component to load the same bundle that runs on Android (Capacitor),
with a thin `javaScriptProxy` bridge (`window.harmonyNative`) providing the
native chrome Capacitor plugins would on Android.

## Why not full ArkTS native?

ArkUI is a declarative UI (SwiftUI-like) — a native rewrite of the connect
guide, transcript, tool cards and agent workspace is a multi-week effort.
The WebView shell reuses the entire existing UI with near-zero work and is
the fastest way onto HarmonyOS; the compat-layer issues (卓易通 无沉浸) are
also moot because this is a first-party shell, not a translation layer.

## Bridge surface (`window.harmonyNative`)

| Method | Returns | Purpose |
|---|---|---|
| `getSystemBars()` | `"{top,vp, bottom,vp}"` | Safe-area insets (vp == CSS px) |
| `getBadge()` | `"{count}"` | Launcher badge count |
| `setBadgeCount(n)` | — | Set launcher badge |
| `clearBadge()` | — | Clear launcher badge |
| `consumeDeepLink()` | `"musepi://..." \| ""` | Drain cold-start deep link |

JS→native push callbacks (registered by the shared bundle):
- `window.__harmonyKeyboard(height)` — soft-keyboard inset
- `window.__harmonyDeepLink(uri)` — warm-start deep link

Deep link scheme: `musepi://connect?link=<url-encoded collab ws link>`
(see `module.json5` ability skills → uris).

## Build

Prereqs: [DevEco Studio 5.0+](https://developer.huawei.com/consumer/cn/deveco-studio/),
HarmonyOS SDK 5.0.0(12), a signed HarmonyOS device/emulator.

```bash
# 1. Build the shared web bundle
cd packages/desktop-web && bun install && bun run build

# 2. Copy it into the shell's rawfile/
cd ../harmony && node scripts/copy-web-assets.js

# 3. Open packages/harmony in DevEco Studio → run on device/emulator
```

The copy step regenerates `entry/src/main/resources/rawfile/` from
`desktop-web/dist` — always re-run it after a web build. `rawfile/` is
gitignored (it is build output).

## Structure

```
packages/harmony/
├── AppScope/app.json5                 # bundleName, version, icon
├── build-profile.json5                # hvigor project config
├── hvigorfile.ts                      # hvigor tasks
├── entry/
│   ├── build-profile.json5
│   ├── oh-package.json5
│   └── src/main/
│       ├── ets/
│       │   ├── entryability/EntryAbility.ets   # deep-link lifecycle
│       │   ├── pages/Index.ets                 # WebView + javaScriptProxy
│       │   └── bridge/HarmonyNative.ets        # native bridge impl
│       ├── module.json5                # abilities, permissions, deep link
│       └── resources/rawfile/          # ← copied desktop-web dist (gitignored)
├── scripts/copy-web-assets.js
└── README.md
```

## P3 follow-ups (not in v1 shell)

- Native notification posting + tap routing via `@ohos.notificationManager`
- Secure storage via `@ohos.security.asset` (currently falls back to
  localStorage on Harmony — same as desktop web)
- Voice input via `@ohos.multimedia.audio` / `audioCapturer`
- Icon/branding: replace `app_icon.svg` with real layered PNG
- ArkUI-native rewrite of connect + session-list for true native feel
