# Browser visual crop, drag paths and device configuration

## Intent

Continue the existing browser-tool alignment with three page-level capabilities: crop the original capture behind a visual snapshot, drag through an ordered path, and apply a discovered device profile or responsive viewport. The Agent receives structured evidence and the user receives matching result cards; no second browser tool or runtime channel is introduced.

## Goals

- `visual_crop` reads the saved image behind a live visual snapshot. Its result contains `sourceSnapshotId`, the requested region in returned screenshot pixels, capture time, cropped image metadata and the actual image. It never creates a new clickable snapshot.
- `drag_path` accepts 2–500 points in the same visual snapshot, presses at the first point, moves continuously through every point and releases at the last. It supports button, total duration and modifier keys.
- `device_profiles` returns the preset catalog. `set_device` applies a preset with orientation and scale mode, responsive dimensions, or disables emulation. Responsive uses mobile identity and touch; desktop presets do not. Display scale is reported separately from page viewport and zoom.
- Prompt guidance, structured cards, bilingual docs and changelog describe the actual contracts. Existing snapshots, actions, dialogs and tab control remain compatible.

## Non-goals

- No history/download inventory in this phase; those records belong to the Electron profile lifecycle.
- No crop-by-current-page recapture, new clickable crop snapshot, arbitrary image path input, or second device-emulation implementation.
- No claim that display scale changes CSS layout or page zoom.

## Approaches

1. **Extend existing snapshots and run scope (selected).** Crop locally from the snapshot's saved image; compile path actions into `page.mouse`; validate and apply device settings through `page.setViewport`.
2. **Recapture crops and use CDP-specific actions.** Rejected: a crop would show a later page state and separate CDP paths would bypass the existing backend and run lifecycle.
3. **Renderer-only controls.** Rejected: the Agent needs real image bytes and page viewport changes, not only UI presentation.

## Verification

- Unit tests cover crop bounds and actual pixels, path point/modifier/duration validation and coordinate mapping, and preset/responsive/disable validation.
- Renderer tests cover crop and device cards plus the existing action receipt.
- An isolated real page verifies original-capture crop pixels, a curved drag on a canvas, mobile responsive viewport/touch, a desktop preset, and emulation disable.
