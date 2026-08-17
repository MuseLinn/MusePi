Generates or edits images.

<instructions>
- Provide a single detailed `subject` prompt for generation or editing.
- When using multiple `input`, describe each image's role in `subject` (e.g. `Image 1` for composition, `Image 2` for lighting).
- For text: add "sharp, legible, correctly spelled"; keep text short.
- `image_size` accepts exact sizes (`1024x1024`, `1536x1024`, `1024x1536`) or tier sizes `1K`-`4K` (native to Agnes; other providers map to the nearest exact size).
- `aspect_ratio` supports `1:1`, `3:4`, `4:3`, `9:16`, `16:9` everywhere; `2:3`, `3:2` additionally on xAI and Agnes; `21:9` additionally on Agnes. Unsupported ratios make the provider skip and the next one try.
</instructions>
