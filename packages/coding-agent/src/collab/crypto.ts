/**
 * AES-256-GCM sealing for collab frames.
 *
 * Moved to @musepi/collab-proto (pure wire transport, shared with the guest).
 * Re-exported here so existing import sites (`./crypto`) keep working.
 */
export {
	generateRoomKey,
	generateWriteToken,
	importRoomKey,
	open,
	seal,
} from "@musepi/collab-proto";
