---
name: android-emulator
description: Use when developing, installing, launching, operating, or visually debugging an Android app with an emulator or ADB device, especially when a blank first frame, UI failure, or runtime error needs verification.
---

# Android Emulator

Use the `android_emulator` tool for device operations and the project's own build command for compilation. Treat a launch command or an early screenshot as evidence of progress, not proof that the app works.

## Debug loop

1. Run `devices` to select an online `device` and inspect available AVDs. If none is running, use `start` with an AVD name and wait for its boot result.
2. Build the APK with the project's standard command. Install it with `install`; the APK path must resolve inside the current workspace.
3. Start the app with `launch` and an explicit `package/.Activity` component.
4. Wait for rendering, then corroborate `screenshot`, `ui_tree`, and `logcat`. A blank first frame can be a capture taken before the first render; recapture and inspect the UI hierarchy and logs before diagnosing a failure.
5. Operate the app with `tap`, `swipe`, `key`, and `text`. Prefer bounds from `ui_tree`; confirm coordinates against the current screenshot because layouts and devices change.
6. Repeat capture, hierarchy, and logs after each meaningful interaction or fix. Report the behavior actually observed, including any unverified path.

## Actions

| Goal | Required input |
| --- | --- |
| Discover devices and AVDs | `devices` |
| Start an AVD | `start`, `avd` |
| Capture the current PNG | `screenshot`, `device` |
| Tap or swipe | `device` plus device-pixel coordinates |
| Back, Home, Recents, or another supported key | `key`, `device`, `key` |
| Enter single-line printable ASCII | `text`, `device`, `text` |
| Inspect accessibility hierarchy | `ui_tree`, `device` |
| Install an APK | `install`, `device`, `apkPath` |
| Launch an activity | `launch`, `device`, `component` |
| Read recent logs | `logcat`, `device`; optional `lines` and `packageName` |

## Common mistakes

- Do not infer the package or activity from an APK filename; inspect the project manifest or build output.
- Do not pass host display coordinates to `tap` or `swipe`; the tool expects Android device pixels.
- Do not declare non-ASCII or multiline input successful through `text`; use another verified input path instead.
- Do not keep retrying a failing launch without reading `logcat`; preserve the actual error in the diagnosis.
