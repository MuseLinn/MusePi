Generates/edits images.

<instructions>
- One detailed `subject` prompt: generation or editing.
- Multiple `input`: describe each image's role in `subject` (e.g. `Image 1` for composition, `Image 2` for lighting).
- Text: add "sharp, legible, correctly spelled"; keep short.</instructions>

Generated files land in the session's own directory and outlive the turn; the result text names each path, so quote it instead of describing the image as delivered somewhere else. When the result says the files are in the OS temp directory, the session had no durable directory yet — copy the file into the workspace before relying on it.
