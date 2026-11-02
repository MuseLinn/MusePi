import type { ExtensionAPI } from "../../extensibility/extensions/types";

/** Package marker: the discovery provider owns this package's file skills. */
export default function apply(pi: ExtensionAPI): void {
	pi.setLabel("MusePi 产品技能");
}
