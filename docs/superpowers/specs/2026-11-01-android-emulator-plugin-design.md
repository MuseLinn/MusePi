# Android Emulator Cordis Plugin Design

## Outcome

MusePi ships a disableable Cordis plugin that opens an Android emulator in the right panel and gives both the user and the agent one device-debugging workflow: discover or start a device, view its screen, tap, swipe, press navigation keys, enter text, capture screenshots, inspect the UI hierarchy and logs, install an APK, and launch an activity.

## Reference investigation

The inspected artifact is Kimi Desktop 3.2.23, `app.asar` SHA-256 `f5e5f51aab4a8d7aff06fc9dc4b77c77d801403fc4deb2ea46e9ca3cc7ba313c`. REA recorded signed-native integrity mismatches and produced partial Evidence `ev_ea69dc686eb0a03f3f10d10f8ed9ec8f5788cf369dbc660cf03afca649c00eee` before source analysis timed out. Bounded searches of the extracted main and workbench bundles found generic browser/workbench code but no `scrcpy`, `app-debug`, Android `adb`, or mobile video-decoder implementation. The supplied screenshot visibly contains a generic browser toolbar and a `127.0.0.1` page. It therefore supports a browser-hosted mobile-debug page, but does not establish who serves that page or which screen transport it uses. A scrcpy/H.264 attribution would be unsupported.

## Alternatives and decision

- **ADB screenshots and input (selected):** no new package or native dependency, works through the existing daemon RPC boundary, and is straightforward to verify. Polling is lower-frame-rate and has no audio.
- **scrcpy video/control:** smooth video at the cost of a native executable, H.264 decoding, process pairing, and a substantially larger lifecycle and packaging surface. Not required for the first reliable debugging workflow.
- **Embed the emulator native window:** avoids screen transport on Windows but is platform-specific, difficult to contain in a web panel, and not portable.

The selected transport is a product design choice, not a claim about KimiWork internals.

## Architecture

`packages/coding-agent/src/bundled-plugins/android-emulator/` owns the complete feature. Its Cordis entry creates one `AndroidDeviceService`, registers RPC methods and agent tools against that service, registers `panel.tab.android-emulator`, and disposes all owned work on plugin shutdown. The panel is daemon-compiled TSX using host-provided React and `extensionCall`; it does not import React at runtime.

The service invokes configured or discovered `adb` and `emulator` executables directly with argument arrays, never through a shell. Device IDs, key events, package/activity names, paths, coordinates, durations, text sizes, and log limits are validated. APK paths must resolve inside the current workspace. Text is sent using ADB key events for ASCII and the clipboard where supported; unsupported input returns an explicit error rather than corrupted text.

Frame capture is serial per service, retains only the latest PNG, and stops when no panel subscriber remains. A failed frame does not create an unbounded retry loop. Responses carry the selected device so stale UI responses cannot silently apply to another device.

## RPC contract

Namespace: `android-emulator`.

- `devices`: list ADB devices and local AVDs.
- `start`: start an AVD and wait for ADB boot completion.
- `subscribe` / `unsubscribe`: manage panel frame subscribers.
- `frame`: return the latest frame or capture one on demand.
- `tap`, `swipe`, `key`, `text`: device input.
- `screenshot`: return a PNG as base64 for preview/download.
- `install`: install a workspace APK with replace grants.
- `launch`: launch an explicit `package/activity` component.
- `uiTree`: dump and read the current accessibility hierarchy.
- `logcat`: return bounded recent logs, optionally filtered by package PID.

Every mutation requires an explicit device ID. The panel supplies the current session ID for RPC routing and the workspace cwd for path checks.

## Agent contract

One `android_emulator` tool exposes an action enum covering `devices`, `start`, `screenshot`, `tap`, `swipe`, `key`, `text`, `ui_tree`, `install`, `launch`, and `logcat`. Screenshots include image content; all actions include concise text and structured details. The real bundled `android-emulator` skill teaches build → install → launch → wait → screenshot/UI-tree/logcat verification, including the rule that an early blank frame is not proof of a broken app.

## UI

The right-panel tab is session-provided rather than a permanent launcher: it declares `availability: "on-demand"`, stays out of the rail and empty/new-tab navigation, and opens when a successful Agent screenshot returns a device-targeted `details.panelTab` request. The same declaration keeps compaction summaries limited to their transcript entry points. The tab contains a compact device toolbar, start/refresh actions, an aspect-preserving touch surface, Back/Home/Recents controls, and collapsible debugging sections for text, APK/activity, UI tree, and logcat. Pointer coordinates use the PNG's natural dimensions and the image's actual content rectangle. The screen has keyboard-accessible equivalents for navigation and actions. Empty, loading, disconnected, and error states are visible and do not collapse the panel.

## Lifecycle and security

The plugin is bundled but overlay-controlled and can be disabled. Disabling it stops polling/timers, removes RPC/tool/component registrations through Cordis, and terminates only emulator processes started by that plugin instance. It never kills a pre-existing emulator or a device shared with another client. No production session/daemon paths are used by tests or smoke runs.

## Documentation and verification

Update the capability-seam registry and anchor, paired extension/plugin/GUI documentation, and the unreleased changelog. Contract tests cover parsing, validation, single-flight capture, subscriber/dispose behavior, tool results, and registration. Run focused tests, package checks, and an isolated desktop smoke against real `emulator-5554` / `MusePi-Mobile-Test`, exercising actual screenshots, input, UI-tree/logcat, and panel interaction.
