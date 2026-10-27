import { removeSyncWithRetries } from "@musepi/pi-utils";

export interface TempHomeState {
	tempDir: string;
	tempHomeDir: string;
	originalHome: string | undefined;
	originalUserProfile?: string | undefined;
}

export function cleanupTempHome(getState: () => TempHomeState): () => void {
	return () => {
		const { tempDir, tempHomeDir, originalHome, originalUserProfile } = getState();
		if (tempDir) {
			removeSyncWithRetries(tempDir);
		}
		if (tempHomeDir) {
			removeSyncWithRetries(tempHomeDir);
		}
		if (originalHome === undefined) {
			delete process.env.HOME;
		} else {
			process.env.HOME = originalHome;
		}
		if (originalUserProfile === undefined) {
			delete process.env.USERPROFILE;
		} else {
			process.env.USERPROFILE = originalUserProfile;
		}
	};
}
