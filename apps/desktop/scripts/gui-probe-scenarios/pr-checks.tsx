/**
 * The PR detail's CI check list.
 *
 * The row's single light answers "is it green"; this list answers "which job",
 * which is the question that blocks a merge. Two behaviours carry that value and
 * neither is visible in a screenshot:
 *
 *  - grouping uses `gh`'s own `bucket`, not a re-derivation from `state`, so a
 *    new gh state string cannot land in the wrong group; and
 *  - `cancel` belongs with failures, because a cancelled check did not pass.
 *
 * Repeated check names are common (matrix builds: `test (18)`, `test (20)`), so
 * the rows must key by position, never by name alone.
 */
import type { ReactNode } from "react";
import type { GuiScenario } from "../gui-probe-helpers";
import { countAll, mount, readElement } from "../gui-probe-helpers";

type Bucket = "pass" | "fail" | "pending" | "skipping" | "cancel" | undefined;

function bucketClass(bucket: Bucket): "success" | "failure" | "pending" | "none" {
	if (bucket === "pass") return "success";
	if (bucket === "fail" || bucket === "cancel") return "failure";
	if (bucket === "pending") return "pending";
	return "none";
}

const checks = (items: { name: string; bucket: Bucket }[]) => (
	<div className="gui-pr-checks">
		<div className="gui-pr-checks-body">
			{items.map((check, index) => (
				<div key={`${check.name}-${index}`} className="gui-pr-checks-row gui-pr-checks-row--static">
					<span className={`gui-pr-check-dot gui-pr-check-dot--${bucketClass(check.bucket)}`} />
					<span className="min-w-0 flex-1 truncate">{check.name}</span>
				</div>
			))}
		</div>
	</div>
);

const scenarios = {
	"checks-mixed": {
		capture: ".gui-pr-checks",
		async render(root: HTMLElement) {
			await mount(
				checks([
					{ name: "CI Run", bucket: "pass" },
					{ name: "MusePi Nix", bucket: "pass" },
					{ name: "test (18)", bucket: "fail" },
					{ name: "test (20)", bucket: "fail" },
					{ name: "lint", bucket: "pending" },
					{ name: "docs", bucket: "skipping" },
				]),
				root,
			);
		},
		async measure(body: ParentNode) {
			return {
				rows: countAll(body, ".gui-pr-checks-row"),
				pass: countAll(body, ".gui-pr-check-dot--success"),
				fail: countAll(body, ".gui-pr-check-dot--failure"),
				pending: countAll(body, ".gui-pr-check-dot--pending"),
				body: readElement(body.querySelector(".gui-pr-checks-body")),
			};
		},
	},
	"checks-cancel-counts-as-failure": {
		capture: ".gui-pr-checks",
		async render(root: HTMLElement) {
			await mount(checks([{ name: "build", bucket: "cancel" }]), root);
		},
		async measure(body: ParentNode) {
			return {
				// A cancelled job did not pass; grouping it with skips would read
				// as "nothing to worry about".
				fail: countAll(body, ".gui-pr-check-dot--failure"),
				pass: countAll(body, ".gui-pr-check-dot--success"),
			};
		},
	},
	"checks-duplicate-names": {
		capture: ".gui-pr-checks",
		async render(root: HTMLElement) {
			await mount(
				checks([
					{ name: "test", bucket: "pass" },
					{ name: "test", bucket: "fail" },
					{ name: "test", bucket: "pass" },
				]),
				root,
			);
		},
		async measure(body: ParentNode) {
			return { rows: countAll(body, ".gui-pr-checks-row") };
		},
	},
} satisfies Record<string, GuiScenario>;

export default scenarios;
