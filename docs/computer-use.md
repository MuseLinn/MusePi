# Native computer use

`computer` captures and controls the desktop that is running `omp`. It uses native screen-capture and input APIs; it does not launch Chromium, use Puppeteer, or expose a DOM.

Use it for visible desktop applications: IDEs, terminals, native apps, browser windows, menus, and system dialogs. Use [`browser`](./tools/browser.md) instead when you need headless/CDP browser tabs, DOM or ARIA inspection, selectors, JavaScript evaluation, or deterministic page automation.

> [!WARNING]
> Enabling `computer` gives the model mouse and keyboard access to your real desktop. Close unrelated sensitive applications, use a dedicated OS account or VM when practical, and configure approval policy before enabling it.

## Enable and configure

The tool is disabled by default. Add this to `~/.omp/agent/config.yml`, a project `.omp/config.yml`, or a one-shot `--config` overlay:

```yaml
computer:
  enabled: true
  backend: auto
  display: all
  maxWidth: 1920
  maxHeight: 1200

tools:
  approvalMode: write
```

`tools.approvalMode: write` automatically allows observation-only batches and prompts before keyboard or pointer input. For a prompt on every computer call, including screenshots:

```yaml
tools:
  approval:
    computer: prompt
```

To block the tool without changing `computer.enabled`:

```yaml
tools:
  approval:
    computer: deny
```

You can also enable it globally from the CLI:

```bash
omp config set computer.enabled true
omp config get computer.enabled
```

Inside a running session, the `/computer` slash command (`/computer`, `/computer on|off|status`) toggles the tool for that session only; it never writes settings files. `/computer status` reports the effective enabled/active state, backend, display and capture limits, active model, and whether that model receives native or function exposure. Explicit enablement and the desktop controller stay active across model switches; exposure is recomputed for the new model, and a switch that crosses the coordinate-safe sizing boundary recreates the controller and resnapshots backend/display/image-size settings. Changing config alone does not; start a new session after a settings change.

### Settings

| Key | Default | Meaning |
|---|---:|---|
| `computer.enabled` | `false` | Register the essential `computer` tool. |
| `computer.backend` | `auto` | `auto` or `native`. Both require a native backend; neither falls back to browser or software automation. |
| `computer.display` | `all` | Composite every active display, or select one numeric native display ID. |
| `computer.maxWidth` | `1920` | Maximum composite screenshot width in pixels. Image transports that cannot preserve original detail, including GitHub Copilot Responses and xAI OAuth, cap the effective width at `1280`; Claude-family models use the same cap as a compatibility fallback. |
| `computer.maxHeight` | `1200` | Maximum composite screenshot height in pixels. Those coordinate-safe transports cap the effective height at `896`; other models retain the configured limit. |

The first successful result lists each display ID, name, logical rectangle, screenshot-pixel rectangle, scale, and primary status. Use one of those IDs as a string when you want a single display:

```yaml
computer:
  display: "2"
```

A disconnected or changed ID fails with `DESKTOP_INVALID_OPTIONS`; switch to `all`, capture once, then select an active ID from the result.

## Model and provider capability

Models with native OpenAI GA computer-use support receive the wire declaration `{ "type": "computer" }`. Every other function-calling model receives `computer` as a regular function tool whose JSON schema describes the same GA action set. Both paths execute through the same native desktop backend, approval policy, and safety rules.

OMP marks a model natively capable when either:

- its catalog metadata explicitly sets `supportsComputerUse: true`, or
- it uses a direct OpenAI Responses or Azure OpenAI Responses endpoint and resolves to a model ID matching `gpt-5.4` or later in the `gpt-5.x` family.

Codex subscription endpoints and custom or proxy routes do not infer native support from the model ID. They receive the regular `computer` function tool unless catalog metadata explicitly opts into the GA contract. An explicit `supportsComputerUse: false` also disables automatic derivation.

Natively capable OpenAI Responses routes may receive a forced `{ "type": "computer" }` choice. Function-tool fallback forcing is provider-specific: OpenAI/Ollama use a named function, Anthropic/Bedrock use a named tool, Google uses required-tool mode, and adapters without a forcing form keep provider-default selection. Responses Lite moves tools into `additional_tools`; for an explicitly forced computer declaration it sends only that declaration and uses `tool_choice: "required"`, preserving both selection and forcing without an invalid object choice that refers to removed top-level tools.

When a session switches from a native-capable API route to a subscription or proxy route, prior native computer history is converted to a representation the target accepts. Codex subscription requests replay it as named `computer` function calls and results, then declare the next computer call as the same named function. Other non-native OpenAI Responses-family targets may use stable assistant text notes; other provider adapters use their ordinary tool format.
While the tool is active, the system prompt makes host-desktop routing explicit even for compact native-tool inventories: desktop requests must use `computer`, and every successful action must be followed by inspection of its fresh screenshot before the next action. This does not auto-enable the tool, bypass approval, or prevent a user-requested alternative after a computer error.

If the tool never appears:

1. Confirm `computer.enabled` is true in the effective config, or toggle it with `/computer`.
2. Start a new session after changing settings files; `/computer` toggles apply immediately.

## Actions

The provider may send one GA action or an ordered `actions` batch. OMP normalizes both forms and executes the batch serially. A successful call returns exactly one fresh PNG after the entire batch. `screenshot` markers are deferred: they emit no input, produce no intermediate image, and do not rebase later coordinates in the same batch.

| Action | Required fields | Behavior |
|---|---|---|
| `click` | `button`, `x`, `y` | Click once. Buttons: `left`, `right`, `wheel`, `back`, `forward`. Optional `keys` holds modifiers. |
| `double_click` | `x`, `y` | Double-click the left button. Native GA calls supply `keys` as an array or `null`; function calls may omit it. |
| `drag` | `path` | Hold left at the first point, visit the remaining points, release at the last. At least two points. Optional modifier `keys`. |
| `keypress` | `keys` | Press one key or chord. The array must contain at least one non-empty key. |
| `move` | `x`, `y` | Move the pointer. Optional modifier `keys`. |
| `screenshot` | none | Request the batch's final capture without input. |
| `scroll` | `x`, `y`, `scroll_x`, `scroll_y` | Move to the point, then scroll horizontally and/or vertically. Optional modifier `keys`. Deltas are converted to native wheel steps. |
| `type` | `text` | Type Unicode text through the native input backend. |
| `wait` | none | Wait two seconds before continuing. |

Coordinates and drag points must be non-negative screenshot pixels. Mouse `keys` may contain only unique modifiers: Control, Shift, Alt/Option, or Meta/Command/Super/Windows. Key names are case-insensitive; common names include `ENTER`, `ESCAPE`, `TAB`, `SPACE`, `BACKSPACE`, `DELETE`, arrows, navigation keys, and `F1`–`F24`. A keypress entry may contain `+`, for example `CTRL+SHIFT+P`. Single Unicode characters are also accepted. macOS has no native `PRINTSCREEN` or `F21`–`F24` mapping.

A batch containing only `screenshot` and `wait` is observation-only. Any click, move, drag, scroll, keypress, or type action makes the whole call input-capable.

## Screenshot coordinates and image mapping

Always choose coordinates from the immediately preceding successful computer result returned by the current desktop controller. Every coordinate action in one batch maps through that same prior frame. A model switch that crosses the coordinate-safe sizing boundary recreates the controller and invalidates the prior frame, so capture a fresh screenshot before the next coordinate action. Do not use OS logical coordinates, CSS pixels, terminal cell positions, coordinates copied from another screenshot, or an image resized after capture.

For each capture, OMP:

1. Enumerates the selected native displays and their global logical rectangles.
2. Captures every selected display at native pixel density.
3. Builds one logical bounding rectangle, including negative monitor origins.
4. Chooses one render scale that preserves the desktop layout and stays within the configured `maxWidth` and `maxHeight` limits. Image transports that cannot preserve original detail, including GitHub Copilot Responses and xAI OAuth, additionally cap the effective frame at `1280×896`; Claude-family models use the same cap as a compatibility fallback, and other providers retain the configured limits.
5. Places each resized display image into the composite and returns a PNG.

Each result's `displays` metadata maps both spaces:

- `x`, `y`, `width`, `height`: global logical desktop rectangle.
- `pixelX`, `pixelY`, `pixelWidth`, `pixelHeight`: rectangle inside the returned PNG.
- `scale`: native display scale reported by the OS.

Input actions use the returned PNG space. The backend locates the display containing that screenshot pixel, scales within that display rectangle, then adds the display's global logical origin. Capture metadata supports displays left of or above the primary monitor; Quartz and Win32 accept those negative origins, while Linux input fails closed as documented below.

The composite preserves gaps between monitor rectangles as black pixels. A point in a gap is not clickable and fails with `DESKTOP_COORDINATE_OUT_OF_BOUNDS`. Points on or beyond the PNG's right/bottom edge, negative points, and points outside every display also fail closed.

If monitor membership, rectangle, or scale changes between the reference frame and a coordinate action, OMP clears the frame and returns `DESKTOP_LAYOUT_CHANGED`. Capture again before retrying. Moving a display, changing resolution/scaling, docking, undocking, or changing the selected display can trigger this guard.

The worker rejects a coordinate action until a screenshot has been returned to the provider. Begin with a screenshot-only call. After any visual transition whose target may have moved, finish the current call and use its returned image for coordinates in the next call.

## Multiple displays

`computer.display: all` produces one composite. Displays are sorted by logical vertical position, then horizontal position, then ID. Mirrored displays with the same logical rectangle are coalesced; the primary mirror wins. Invalid scales, duplicate IDs, and overlapping non-mirrored rectangles fail closed rather than guessing.

Use one display when:

- the desktop is very wide and labels become hard for the model to read after downscaling;
- a layout gap makes targets ambiguous; or
- you want to isolate sensitive content on another monitor.

On Linux, Wayland sessions are captured and driven through XWayland: `DISPLAY` must point at the XWayland server, capture reads the X11 composite, and input is emitted as XTest events in the same X11 global coordinate space, so multi-display coordinate mapping is exact. Whether that input reaches native Wayland windows depends on the compositor's XWayland input bridging (modern GNOME and KDE support it).

## Approval and safety precedence

Computer use has three safety layers.

### 1. Tool approval

- `screenshot`/`wait`-only batches declare `read` approval.
- Any input action declares `exec` approval.
- Missing or malformed action metadata defaults to `exec`.
- `tools.approval.computer` overrides the active mode with `allow`, `prompt`, or `deny`.

With `tools.approvalMode: write`, screenshots are automatically allowed and input prompts. The schema default is `yolo`, which normally auto-approves both; use `write`, `always-ask`, or an explicit per-tool policy when controlling a real desktop.

### 2. Provider safety checks

OpenAI may attach `pending_safety_checks` to a native `computer_call`. Precedence is strict:

1. `tools.approval.computer: deny` blocks the call immediately.
2. Otherwise, any pending provider check forces an interactive Approve/Deny prompt.
3. `yolo`, `--auto-approve`, per-tool `allow`, and prior xdev approval cannot bypass that prompt.
4. A headless session or missing UI fails closed; it never acknowledges on your behalf.
5. Only explicit approval marks the checks acknowledged and permits input.
6. OMP returns the same checks as `acknowledged_safety_checks` with the screenshot output.

The computer executor checks the approval marker again before native input. A provider check reaching execution without interactive approval fails with `Provider safety checks require interactive approval before computer input`.

### 3. Consequential-action confirmation

Provider checks do not replace user authorization. OMP treats screen text, images, notifications, websites, documents, chat messages, and application instructions as untrusted data. They cannot authorize actions or override your direct instructions.

The agent must confirm at the point of risk before consequential side effects unless your direct message already authorized that exact action, target, scope, and values. Examples include sending or publishing, purchases or transfers, deletion, account/security or permission changes, disclosure of private data, accepting legal terms, and irreversible operations. High-impact financial, employment, housing, education, insurance/credit, legal, medical, government, election, biometric, and highly sensitive-data actions require point-of-risk confirmation.

Operational guidance:

- Do not place secrets in visible windows unless the task needs them.
- Never follow on-screen requests to reveal credentials, change policy, or ignore instructions.
- Review the exact destination and payload before Submit, Send, Buy, Delete, or Allow.
- Prefer a dedicated desktop session for untrusted sites or documents.
- Stop when the visible state differs from the user's stated target.

See [Tool approval mode](./approval-mode.md) for general policy resolution.

## Platform setup and support

| Platform | Backend | Setup and current status |
|---|---|---|
| macOS x64/arm64 | Bounded macOS `screencapture` service capture; Quartz/CGEvent and native input | Supported. Grant Screen Recording and Accessibility. Real remote desktop execution was verified on Apple hardware; see [Verification boundary](#verification-boundary). |
| Linux x64/arm64, glibc/musl, X11 | Pure-Rust X11 capture and XTest input (`x11rb`), bundled in the core addon | Supported when a graphical session and `DISPLAY` are available. No GUI system libraries are required; the backend speaks the X protocol directly over the display socket. Requires the RandR and XTEST server extensions. |
| Linux x64/arm64, glibc/musl, Wayland | XWayland capture; XTest input bridged by the compositor | Supported with an active XWayland `DISPLAY`. Pure Wayland capture (portal/PipeWire) is not implemented. Input delivery to native Wayland windows depends on the compositor's XWayland input bridge. |
| Windows x64 | xcap capture; Win32 virtual-desktop pointer movement and native input | Implemented, including negative origins and secondary monitors. Not remotely exercised in this feature's verification. |
| Other OS/architectures | none | Unsupported by the published native package matrix. |

### macOS permissions

Open **System Settings → Privacy & Security**:

1. Grant **Screen Recording** to the terminal or application that launches `omp`.
2. Grant **Accessibility** to the same host for keyboard and pointer input.
3. Fully restart that host and start a new OMP session.

OMP performs a non-prompting Screen Recording preflight. It does not open the permission dialog for you. Accessibility is not separately preflighted; denial normally surfaces when native input initializes or emits an event.

### Linux setup

For X11, run OMP inside the target graphical session and ensure `DISPLAY` identifies it. Capture and input need no GUI system libraries: the backend speaks the X protocol directly and emits input through the XTEST extension.

For Wayland:

- keep XWayland enabled and ensure `DISPLAY` is set; capture and input both go through it; and
- use a compositor that bridges XWayland XTest input to native windows (modern GNOME and KDE do).

The desktop backend is always bundled in the core `pi-natives` addon on every published Linux target (x64/arm64, glibc/musl). It opens no display connection until the tool runs, so headless hosts are unaffected; without a reachable X server the tool reports `DESKTOP_BACKEND_UNAVAILABLE`.

## Session and worker lifecycle

The tool is exclusive: computer calls do not run concurrently. Its lifecycle is:

```text
computer tool
  → ComputerSupervisor (lazy, serialized queue)
  → dedicated Bun worker
  → native DesktopSession
  → dedicated native desktop worker thread
  → capture/input APIs
```

The Bun worker starts on the first computer call, not at OMP startup. Startup has a 10-second deadline. The desktop session and last screenshot geometry remain alive across calls, so later coordinates can be checked against the preceding frame. Each successful ordered action batch ends with one new capture.

Closing the agent/eval owner closes all owned controllers. Normal close asks the Bun worker to close, waits up to 1.5 seconds, then terminates it if needed. Native close is idempotent and bounded. Aborting a call terminates that worker and rejects pending requests; a later call may start a fresh worker and must establish a new screenshot frame.

## OpenAI screenshot references and Files

OMP preserves the GA wire contract exactly:

- call: `computer_call` with `action` or batched `actions`, stable `id`/`call_id`, and `pending_safety_checks`;
- result: `computer_call_output` with `output.type: "computer_screenshot"` and `acknowledged_safety_checks`;
- screenshot reference: either `image_url` or `file_id`.

Native OMP execution returns the PNG inline as a `data:image/png;base64,...` `image_url`. It does **not** upload the capture to the OpenAI Files API and does not mint a `file_id`.

If an OpenAI-compatible gateway or restored Responses history supplies a `file_id`, OMP preserves and replays that exact reference as provider metadata. It does not download, validate, refresh, or delete the provider file. File availability, retention, authorization, and expiry remain the provider/client's responsibility. Both `image_url` and `file_id` history are preserved for capable models; replay to a non-native OpenAI Responses-family model converts the native items to text notes.

## Troubleshooting

Computer backend errors begin with a stable code:

| Error | Meaning and response |
|---|---|
| `DESKTOP_INVALID_OPTIONS` | Invalid backend, zero image limit, malformed display value, or inactive display ID. Correct config and start a new session. |
| `DESKTOP_INVALID_ACTION` | Unknown action/button/key, missing or unexpected fields, negative point, short drag path, or invalid/duplicate modifier. Capture again only after fixing the action. |
| `DESKTOP_BACKEND_UNAVAILABLE` | No graphical session/backend, missing XWayland `DISPLAY`, missing RandR/XTEST server extension, a negative-origin or out-of-XTest-range Linux layout, or native input initialization failure. Follow the platform section. |
| `DESKTOP_PERMISSION_DENIED` | Screen capture or input permission denied. Grant OS permissions and restart the host/session. |
| `DESKTOP_CAPTURE_FAILED` | Display capture, scaling, allocation, or PNG encoding failed. Reduce `maxWidth`/`maxHeight`, verify the display is active, then capture again. |
| `DESKTOP_INPUT_FAILED` | Native input initialization/event failed. Check macOS Accessibility permission or X server access for the session. |
| `DESKTOP_LAYOUT_CHANGED` | Display topology changed after the reference screenshot. Capture a new frame before input. |
| `DESKTOP_COORDINATE_OUT_OF_BOUNDS` | Point lies outside the PNG, in a composite gap, or outside every display. Choose a point inside a listed `pixel*` rectangle. |
| `DESKTOP_DEADLINE_EXCEEDED` | The 60-second native batch deadline expired; remaining actions were not executed. Split the batch into smaller calls and capture a fresh screenshot. |
| `DESKTOP_SESSION_CLOSED` | Native session was closed. Start a new OMP session. |
| `DESKTOP_WORKER_FAILED` | Native worker startup, communication, timeout, or shutdown failed. Start a new session; if persistent, verify the native addon installation. |

Common exact failures:

- `Wayland sessions require an active XWayland DISPLAY for native capture and input; pure Wayland capture is unavailable` → enable XWayland or use X11.
- `X11/x11rb XTest absolute input cannot represent negative global desktop coordinates` → select a display whose origin is non-negative.
- `X11/x11rb XTest absolute input is limited to global coordinates in 0..=32767` → select one display or a smaller layout.
- `native action deadline exceeded; remaining batch actions were not executed` → split the batch into smaller calls and take a fresh screenshot.
- `macOS Screen Recording permission is not granted for this process` → grant the launching host Screen Recording and restart it.
- `Provider safety checks require interactive approval before computer input` → use an interactive session and approve the provider prompt.
- `Timed out starting native computer worker` → verify the installed native addon matches the OMP release, then restart/reinstall.
- Version-sentinel error mentioning an upgrade while the session was running → restart OMP; disk is already consistent.
- Version-sentinel error saying the `.node` file is from a different release → reinstall OMP/native packages.

The native composite safety ceiling is 268,435,456 pixels. Normal defaults are far below it. Very large or sparse monitor arrangements should use a smaller maximum size or one selected display.

## Verified limitations

- Native desktop control only; no DOM, ARIA tree, selectors, browser tab lifecycle, or Puppeteer fallback.
- OpenAI GA action set only; no arbitrary shell command or accessibility-tree action inside this tool.
- The model acts on screenshots; OCR/visual interpretation can be wrong.
- Coordinate targets are valid only for the preceding frame and current display layout.
- Screenshot composites may downscale small text to fit configured limits.
- Gaps are visible but not valid input targets; overlapping non-mirrored layouts fail closed.
- Pure Wayland capture currently requires XWayland; the portal/PipeWire capture path is not implemented.
- On Wayland, XTest input reaching native windows depends on the compositor's XWayland input bridge.
- Linux coordinate input fails closed for negative global display origins; select a display whose origin is non-negative.
- X11/XTest coordinate input is limited to global positions through 32767 on each axis.
- Windows support is implemented for x64 but was not remotely exercised for this change.
- Native captures use inline `image_url`; OMP does not upload them to provider Files.
- OS secure desktops and policy-protected surfaces may reject ordinary user-session capture/input; OMP has no bypass.

## Verification boundary

The real-host verification used the `ComputerSupervisor` worker path on a real macOS host, not a mock backend. With macOS Screen Recording and Accessibility granted, it controlled TextEdit using a global hotkey, double-click, click, typing, and screenshot capture. The returned Quartz frame was 1920×1080.

This proves the native macOS host path through the worker and desktop session. It was **not** a live OpenAI native `computer_call` → `computer_call_output` round trip. OpenAI GA transport, batching, safety acknowledgement, and `image_url`/`file_id` replay are covered by local contract tests; the Windows backend was implemented but not remotely exercised.

For implementation-level inputs, outputs, lifecycle, and error surfaces, see [`docs/tools/computer.md`](./tools/computer.md).
