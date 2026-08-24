# @musepi/mobile

MusePi mobile companion — Capacitor-based Android app.

## Design

The mobile surface follows the structured design spec in
[`docs/mobile-design.md`](../../docs/mobile-design.md) — information
architecture, screen specs, interaction/motion contracts, native chrome
(keyboard inset, status bar, safe areas, back-key navigation, local
notifications), accessibility, and acceptance criteria.

## Development

```sh
bunx cap sync
bunx cap open android
```

Build with Android Studio; the app connects to a running musepi daemon on the
same network. Web assets are prepared from the `desktop-web` build by
`scripts/prepare-web-assets.mjs` (mobile entry only — no runtime redirect).
