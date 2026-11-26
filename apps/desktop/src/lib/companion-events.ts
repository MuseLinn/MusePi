/**
 * Companion (pet) broadcast names.
 *
 * `musepi-` is the canonical spelling; the `omp-` names are the pre-rename
 * aliases, still dispatched so an out-of-tree listener keeps working. Consumers
 * subscribe through these constants, never a literal.
 */

export const PET_CHANGED_EVENT = "musepi-pet-changed";
/** @deprecated Pre-rename alias. Dispatched for compatibility only. */
export const LEGACY_PET_CHANGED_EVENT = "omp-pet-changed";

export const PET_ACTIVITY_EVENT = "musepi-pet-activity";
/** @deprecated Pre-rename alias. Dispatched for compatibility only. */
export const LEGACY_PET_ACTIVITY_EVENT = "omp-pet-activity";

export interface PetActivityDetail {
	kind: string;
	text: string;
	requestId: string;
	sessionId: string;
}

/** Broadcast a companion preference change under both spellings. */
export function dispatchPetChanged(): void {
	window.dispatchEvent(new CustomEvent(PET_CHANGED_EVENT));
	window.dispatchEvent(new CustomEvent(LEGACY_PET_CHANGED_EVENT));
}

/** Broadcast a pet activity bubble under both spellings. */
export function dispatchPetActivity(detail: PetActivityDetail): void {
	window.dispatchEvent(new CustomEvent(PET_ACTIVITY_EVENT, { detail }));
	window.dispatchEvent(new CustomEvent(LEGACY_PET_ACTIVITY_EVENT, { detail }));
}
