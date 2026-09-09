/**
 * Relay WebSocket client (guest side). Transport moved to @musepi/collab-proto
 * (pure wire layer, shared with the host); re-exported here so existing import
 * sites (`./socket`) keep working.
 */
export { CollabSocket, type CollabSocketOptions } from "@musepi/collab-proto";
