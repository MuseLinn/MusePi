# agnes_video_gen

Generates videos via the Agnes Video V2.0 API (text-to-video, image-to-video, and keyframe workflows).

## Usage

- Provide a detailed `prompt` describing the scene, motion, camera, and style.
- Optional `image` (public URL) enables image-to-video.
- `keyframes` (array of public image URLs) enables keyframe animation between multiple frames.
- `mode`: `ti2vid` (default) or `keyframes`.
- `height` / `width` default to 1152x768.
- `num_frames` up to 441 (must satisfy 8n+1); `frame_rate` 1-60. Duration = num_frames / frame_rate.
- Standard duration presets (24fps): ~3s → 81 frames, ~5s → 121 frames, ~10s → 241 frames, ~18s (max) → 441 frames. For other durations pick the closest 8n+1 frame count and adjust `frame_rate`; the API reports the actual seconds.
- `seed` for reproducible results; `num_inference_steps` to control generation cost.
- `negative_prompt` to exclude unwanted content.
- `wait`: by default the tool submits the job and returns immediately as a background job (result delivered automatically when ready — generation takes minutes). Pass `wait: true` to block until the video is done.

## Response

Returns a summary with the task/video IDs, progress, video URL, duration, and size once generation completes. Generation is asynchronous: the tool polls the Agnes API every 3 seconds, up to 10 minutes (429 rate limits add a 65s backoff wait).
