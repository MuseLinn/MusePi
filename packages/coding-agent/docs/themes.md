> pi can create themes. Ask it to build one for your setup.

# Themes
Themes are JSON files that define colors for the TUI.

**Built-in presets:** `dark`, `light`, `nord`, `gruvbox`, `tokyo-night`,
`catppuccin`. Switch via `/theme <name>`, preview with `/theme preview <name>`.

**Colorblind mode:** Shifts hues +60° and desaturates to 71% for
deuteranopia-friendly colors. Enable via `setColorBlindMode(true)` at runtime
— all hex colors are adjusted before ANSI resolution.

**Shimmer animation:** Character-level time-varying sweep across status and
loader text. Two modes: `classic` (cosine LTR) and `kitt` (K.I.T.T. scanner).
Toggle at runtime via `setShimmerMode()`.


Pi loads themes from:

- Built-in: `dark`, `light`, `nord`, `gruvbox`, `tokyo-night`, `catppuccin`
- Global: `~/.pi/agent/themes/*.json`
- Project: `.pi/themes/*.json` (only after the project is trusted)
- Packages: `themes/` directories or `pi.themes` entries in `package.json`
- Settings: `themes` array with files or directories
- CLI: `--theme <path>` (repeatable)

Disable discovery with `--no-themes`.

## Selecting a Theme

Select a theme via `/settings` or in `settings.json`:

```json
{
  "theme": "my-theme"
}
```

On first run, pi detects your terminal background and defaults to `dark` or `light`.

## Creating a Custom Theme

1. Create a theme file:

```bash
mkdir -p ~/.pi/agent/themes
vim ~/.pi/agent/themes/my-theme.json
```

2. Define the theme with all required colors (see [Color Tokens](#color-tokens)):

```json
{
  "$schema": "https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/src/modes/interactive/theme/theme-schema.json",
  "name": "my-theme",
  "vars": {
    "primary": "#00aaff",
    "secondary": 242
  },
  "colors": {
    "accent": "primary",
    "border": "primary",
    "borderAccent": "#00ffff",
    "borderMuted": "secondary",
    "success": "#00ff00",
    "error": "#ff0000",
    "warning": "#ffff00",
    "muted": "secondary",
    "dim": 240,
    "text": "",
    "thinkingText": "secondary",
    "selectedBg": "#2d2d30",
    "userMessageBg": "#2d2d30",
    "userMessageText": "",
    "customMessageBg": "#2d2d30",
    "customMessageText": "",
    "customMessageLabel": "primary",
    "toolPendingBg": "#1e1e2e",
    "toolSuccessBg": "#1e2e1e",
    "toolErrorBg": "#2e1e1e",
    "toolTitle": "primary",
    "toolOutput": "",
    "mdHeading": "#ffaa00",
    "mdLink": "primary",
    "mdLinkUrl": "secondary",
    "mdCode": "#00ffff",
    "mdCodeBlock": "",
    "mdCodeBlockBorder": "secondary",
    "mdQuote": "secondary",
    "mdQuoteBorder": "secondary",
    "mdHr": "secondary",
    "mdListBullet": "#00ffff",
    "toolDiffAdded": "#00ff00",
    "toolDiffRemoved": "#ff0000",
    "toolDiffContext": "secondary",
    "syntaxComment": "secondary",
    "syntaxKeyword": "primary",
    "syntaxFunction": "#00aaff",
    "syntaxVariable": "#ffaa00",
    "syntaxString": "#00ff00",
    "syntaxNumber": "#ff00ff",
    "syntaxType": "#00aaff",
    "syntaxOperator": "primary",
    "syntaxPunctuation": "secondary",
    "thinkingOff": "secondary",
    "thinkingMinimal": "primary",
    "thinkingLow": "#00aaff",
    "thinkingMedium": "#00ffff",
    "thinkingHigh": "#ff00ff",
    "thinkingXhigh": "#ff0000",
    "thinkingMax": "#ff0088",
    "bashMode": "#ffaa00"
  }
}
```

3. Select the theme via `/settings`.

**Hot reload:** When you edit the currently active custom theme file, pi reloads it automatically for immediate visual feedback.

## Theme Format

```json
{
  "$schema": "https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/src/modes/interactive/theme/theme-schema.json",
  "name": "my-theme",
  "vars": {
    "blue": "#0066cc",
    "gray": 242
  },
  "colors": {
    "accent": "blue",
    "muted": "gray",
    "text": "",
    ...
  }
}
```

- `name` is required, must be unique, and must not contain `/`.
- `colors` must define all 68 required tokens. `thinkingMax` is optional and falls back to `thinkingXhigh`.

The `$schema` field enables editor auto-completion and validation.

## Color Tokens

Every theme must define all 68 required color tokens. `thinkingMax` is optional for compatibility with existing themes; when omitted, it uses `thinkingXhigh`.

### Core UI (12 colors)

| Token | Purpose |
|-------|---------|
| `accent` | Primary accent (logo, selected items, cursor) |
| `border` | Normal borders |
| `borderAccent` | Highlighted borders |
| `borderMuted` | Subtle borders (editor) |
| `success` | Success states |
| `error` | Error states |
| `warning` | Warning states |
| `info` | Info/lifecycle states |
| `muted` | Secondary text |
| `dim` | Tertiary text |
| `text` | Default text (usually `""`) |
| `thinkingText` | Thinking block text |

### Backgrounds & Content (11 colors)

| Token | Purpose |
|-------|---------|
| `selectedBg` | Selected line background |
| `userMessageBg` | User message background |
| `userMessageText` | User message text |
| `customMessageBg` | Extension message background |
| `customMessageText` | Extension message text |
| `customMessageLabel` | Extension message label |
| `toolPendingBg` | Tool box (pending) |
| `toolSuccessBg` | Tool box (success) |
| `toolErrorBg` | Tool box (error) |
| `toolTitle` | Tool title |
| `toolOutput` | Tool output text |

### Markdown (10 colors)

| Token | Purpose |
|-------|---------|
| `mdHeading` | Headings |
| `mdLink` | Link text |
| `mdLinkUrl` | Link URL |
| `mdCode` | Inline code |
| `mdCodeBlock` | Code block content |
| `mdCodeBlockBorder` | Code block fences |
| `mdQuote` | Blockquote text |
| `mdQuoteBorder` | Blockquote border |
| `mdHr` | Horizontal rule |
| `mdListBullet` | List bullets |

### Tool Diffs (3 colors)

| Token | Purpose |
|-------|---------|
| `toolDiffAdded` | Added lines |
| `toolDiffRemoved` | Removed lines |
| `toolDiffContext` | Context lines |

### Syntax Highlighting (9 colors)

| Token | Purpose |
|-------|---------|
| `syntaxComment` | Comments |
| `syntaxKeyword` | Keywords |
| `syntaxFunction` | Function names |
| `syntaxVariable` | Variables |
| `syntaxString` | Strings |
| `syntaxNumber` | Numbers |
| `syntaxType` | Types |
| `syntaxOperator` | Operators |
| `syntaxPunctuation` | Punctuation |

### Thinking Level Borders (6 required, 1 optional)

Editor border colors indicating thinking level (visual hierarchy from subtle to prominent):

| Token | Purpose |
|-------|---------|
| `thinkingOff` | Thinking off |
| `thinkingMinimal` | Minimal thinking |
| `thinkingLow` | Low thinking |
| `thinkingMedium` | Medium thinking |
| `thinkingHigh` | High thinking |
| `thinkingXhigh` | Extra high thinking |
| `thinkingMax` | Maximum thinking; optional, falls back to `thinkingXhigh` |

### Bash & Python Mode (2 colors)

| Token | Purpose |
|-------|---------|
| `bashMode` | Editor border in bash mode (`!` prefix) |
| `pythonMode` | Editor border in python mode (`> ` prefix) |
### Status Line (12 colors, 1 background)

| Token | Purpose |
|-------|---------|
| `statusLineSep` | Status line separator |
| `statusLineModel` | Model name segment |
| `statusLinePath` | Path segment |
| `statusLineGitClean` | Git clean state |
| `statusLineGitDirty` | Git dirty state |
| `statusLineContext` | Context usage segment |
| `statusLineSpend` | Cost/spend segment |
| `statusLineStaged` | Staged files count |
| `statusLineDirty` | Dirty files count |
| `statusLineUntracked` | Untracked files count |
| `statusLineOutput` | Output indicator |
| `statusLineCost` | Cumulative cost |
| `statusLineSubagents` | Subagent count |
Background: `statusLineBg` (ThemeBg) for the status line background fill.

## Color Values

Four formats are supported:

| Format | Example | Description |
|--------|---------|-------------|
| Hex | `"#ff0000"` | 6-digit hex RGB |
| 256-color | `39` | xterm 256-color palette index (0-255) |
| Variable | `"primary"` | Reference to a `vars` entry |
| Default | `""` | Terminal's default color |

### 256-Color Palette

- `0-15`: Basic ANSI colors (terminal-dependent)
- `16-231`: 6×6×6 RGB cube (`16 + 36×R + 6×G + B` where R,G,B are 0-5)
- `232-255`: Grayscale ramp

### Terminal Compatibility

Pi uses 24-bit RGB colors. Most modern terminals support this (iTerm2, Kitty, WezTerm, Windows Terminal, VS Code). For older terminals with only 256-color support, pi falls back to the nearest approximation.

Check truecolor support:

```bash
echo $COLORTERM  # Should output "truecolor" or "24bit"
```

## Tips

**Dark terminals:** Use bright, saturated colors with higher contrast.

**Light terminals:** Use darker, muted colors with lower contrast.

### Presets

MusePi ships with six built-in themes. Switch between them at runtime:

| Theme | Vibe | Status line |
|-------|------|-------------|
| `dark` | Deep blue-gray | `` bright cyan |
| `light` | Warm parchment | `` muted teal |
| `nord` | Cool Arctic | `` snow peak |
| `gruvbox` | Retro earth | `` burnt orange |
| `tokyo-night` | Stormy neon | `` electric violet |
| `catppuccin` | Soft pastel | `` mauve accent |

Select via `/theme <name>` or in `settings.json`.

## Examples

See the built-in themes:
- [dark.json](../src/modes/interactive/theme/dark.json)
- [light.json](../src/modes/interactive/theme/light.json)
- [nord.json](../src/modes/interactive/theme/nord.json)
- [gruvbox.json](../src/modes/interactive/theme/gruvbox.json)
- [tokyo-night.json](../src/modes/interactive/theme/tokyo-night.json)
- [catppuccin.json](../src/modes/interactive/theme/catppuccin.json)

