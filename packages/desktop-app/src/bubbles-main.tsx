/**
 * Bubbles window entry (bubbles.html) — the pet's message bubbles in their
 * OWN window, split 2026-09-21 back out of the merged single pet window
 * (user: 气泡应该和桌宠分开窗口 —— merged-window 绝对定位让气泡在屏幕
 * 边缘被裁切、遮挡主窗口).
 *
 * The window is sized to its content by the main process: the renderer
 * reports the content union via setBubblesContentSize and the main process
 * (layoutBubblesWindow in main.cjs) pins the window's bottom edge ~20px
 * above the sprite's top, horizontally centred on the character — and moves
 * it whenever the pet window moves (drag, settle, dock, display change).
 *
 * The bubbles root gets `bubbles-root` on <html>; pet-window.css re-scopes
 * the bubble surfaces from absolute (pet-window-anchored) to document flow
 * (window == content box) under that class.
 */

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { PetBubbles } from "./pet-bubbles";

// Same style set as the pet window. The glass custom properties live in the
// shared token and overlay-fallback sheets, not in gui.css itself; omitting
// either silently drops the card's border, sheen and shadow declarations.
import "./styles/pet-window.css";
import "@musepi/client-core/src/styles/tokens.css";
import "./styles/gui.css";
import "@musepi/client-core/src/styles/overlay-fallback.css";

document.documentElement.classList.add("bubbles-root");

createRoot(document.getElementById("root")!).render(
	<StrictMode>
		<PetBubbles />
	</StrictMode>,
);
