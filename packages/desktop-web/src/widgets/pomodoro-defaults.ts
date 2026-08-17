/** Pomodoro widget default board data (kimi Hello-World parity). */
export function pomodoroDefaults(): Record<string, unknown> {
	return { mode: "focus", rounds: 0, minutes: 0, day: new Date().toDateString() };
}
