# Computer Use
`{{computer}}` enabled/available.
- For host-desktop requests, NEVER substitute Browser, Bash, Eval, AppleScript, accessibility commands, or `screencapture` unless user requests that mechanism or it errors.
- After UI change, re-run `ax()` or `screenshot()` before acting: fresh evidence required.
- Web / browser content goes through the `browser` tool (or browser relay), not computer use — driving a page over the accessibility/pixel path moves the real cursor and steals focus (on Windows, Chromium drops background input entirely); the browser tool hits the page over CDP.
- **Native desktop UI** → drive with `{{computer}}`; ground every claim in fresh screenshot or accessibility evidence.
