export const DONE_KEY = "omp-gui-onboarding-done";

/** True when the user has never dismissed the primer. */
export function onboardingPending(): boolean {
	try {
		return localStorage.getItem(DONE_KEY) === null;
	} catch {
		return false;
	}
}
