# @musepi/browser-relay

Chrome extension that lets the musepi `browser` tool drive **your existing Chrome tabs** — logged-in sessions included — without relaunching Chrome with `--remote-debugging-port` (which Chrome 136+ refuses on the default profile anyway).

The companion relay server lives in the musepi CLI (`musepi browser-relay`, see `packages/coding-agent/src/tools/browser/relay/`). It impersonates Chrome's CDP discovery endpoint, synthesizes the browser target and `Target.*` hierarchy that `chrome.debugger` doesn't expose, and multiplexes any number of downstream puppeteer connections (musepi opens one per tab worker) over the single debugger attachment Chrome allows per tab.

## Setup

1. `musepi browser-relay install` — writes the bundled extension to `~/.musepi/browser-relay/extension`, then load it via `chrome://extensions` → Developer mode → *Load unpacked*. (Or grab `musepi-browser-relay-extension.zip` from GitHub releases.)
2. `musepi config set browser.relay true` — routes the browser tool through the relay. Per-call `app.relay: true` works without the setting.

That's it: the relay server auto-starts under musepi's profile-independent global daemon broker the first time the browser tool needs it. Every relay consumer holds a broker lease, so one project exiting cannot interrupt another; the server stops after the last consumer across all projects exits. The extension badge turns **on** when connected. Run `musepi browser-relay` manually only for `--token`, `--no-group`, or a non-default port — a relay already serving the port is adopted, never fought over.

`app.target` picks a specific tab by URL/title substring; without it, musepi adopts the visible tab without stealing focus. Tabs musepi is **actively driving** are gathered into a per-window **"musepi" tab group** (cyan) — released when musepi lets go of the tab and dissolved on disconnect; the rest of your tabs, pinned tabs, tabs in your own groups, and tabs you drag out are left alone. Disable with `musepi browser-relay --no-group`.

## Development

- `bun run build` — bundles the extension into `dist/extension/`, zips it for GH releases, and regenerates the embedded CLI install assets under `packages/coding-agent/src/tools/browser/relay/extension-assets/` (**commit those**).
- `bun scripts/smoke.ts [relay-url] [target-substring]` — end-to-end smoke replicating musepi's supervisor + tab-worker double-connection pattern against a live relay.

## Limitations

- `chrome://`, DevTools, Web Store, and other-extension pages are not attachable and are hidden from the agent.
- Chrome shows its "is debugging this browser" infobar while any tab is attached; dismissing it detaches that tab until it navigates again.
- A tab with DevTools open can't be attached (one debugger per tab — the constraint the relay multiplexes around for its own clients).
- Anything that can reach the relay port can drive your logged-in browser. The relay binds loopback only; use `musepi browser-relay --token <secret>` (mirrored in the extension options) if untrusted local processes are a concern.
