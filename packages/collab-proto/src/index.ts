/**
 * @musepi/collab-proto — collab live-session wire transport.
 *
 * Pure transport layer shared by the host (coding-agent) and the guest
 * (desktop-web): AES-GCM frame sealing, share-link format, wire envelope,
 * and the relay WebSocket client. Zero agent/session imports, browser-safe
 * (no Buffer), generic frame types.
 */
export * from "./crypto";
export * from "./link";
export * from "./qrcode";
export * from "./socket";
