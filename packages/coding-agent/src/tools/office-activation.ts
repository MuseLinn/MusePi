/**
 * Office skill admission.
 *
 * `office_render`, `office_convert` and `office_recalculate` are registered but
 * not selected at session start. A successful load of one of the activation
 * skills — a `/skill:<name>` invocation or a `skill://<name>` read — admits the
 * group for the following step.
 */
export const OFFICE_TOOL_NAMES = ["office_render", "office_convert", "office_recalculate"] as const;

/** Skill names whose load admits the Office tools from the next step. */
export const DEFAULT_OFFICE_ACTIVATION_SKILLS: readonly string[] = [
	"office",
	"office-docx",
	"office-xlsx",
	"office-pptx",
];

let activationSkills: readonly string[] = DEFAULT_OFFICE_ACTIVATION_SKILLS;

/** Replace the activation skills (the `musepi-tool-office` Config field). */
export function setOfficeActivationSkills(names: readonly string[]): void {
	activationSkills = names.length > 0 ? [...new Set(names)] : DEFAULT_OFFICE_ACTIVATION_SKILLS;
}

/** Whether loading `name` admits the Office tools. */
export function isOfficeActivationSkill(name: string): boolean {
	return activationSkills.includes(name);
}

/** Whether `name` is one of the Office tools. */
export function isOfficeTool(name: string): boolean {
	return (OFFICE_TOOL_NAMES as readonly string[]).includes(name);
}
