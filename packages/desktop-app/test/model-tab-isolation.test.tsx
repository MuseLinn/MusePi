import "./dom-shim";
// @lobehub/icons has an internal cycle (each brand module ↔ providerConfig);
// importing the package entry first initializes providerConfig before the
// brand modules that reference it, avoiding the TDZ crash under bun's module
// evaluation order (model-brand-icon deep-imports the brand entrypoints).
import "@lobehub/icons";
import { describe, expect, it } from "bun:test";
import { t } from "@musepi/guest-client";
import { renderToStaticMarkup } from "react-dom/server";
import { CustomProviderPane } from "../src/components/settings-sections/custom-provider";
import { ModelSection } from "../src/components/settings-sections/model";

// 设置 → 模型与供应商的 tab 隔离契约:自定义供应商区块只属于它自己的 tab。
// 回归背景:该区块曾无条件渲染,于是"角色模型/模型行为/供应商"三个 tab 底部
// 也会长出整个自定义供应商区块(标题+列表+添加按钮),与第四个同名 tab 重复。

const paneMarker = t("custom providers hint");
const paneButton = t("add custom provider");

function sectionHtml(): string {
	return renderToStaticMarkup(
		<ModelSection
			providers={[]}
			apiProviders={[]}
			custom={
				[
					{
						name: "verify-provider",
						baseUrl: "https://example.test/v1",
						models: [{ id: "m-1", name: "Model One" }],
					},
				] as never
			}
			loginState={null}
			busy={false}
			pendingLogins={[]}
			onLogin={() => {}}
			onLogout={() => {}}
			onSubmitInput={() => {}}
			onCancelLogin={() => {}}
			onChanged={() => {}}
			rpc={null}
			sessionId={null}
		/>,
	);
}

describe("模型与供应商 tab 隔离", () => {
	it("默认的角色模型 tab 不渲染自定义供应商区块", () => {
		const html = sectionHtml();
		// tab bar 本身存在(含第 4 个"自定义供应商" tab 标签)。
		expect(html).toContain("gui-model-tabs");
		expect(html).toContain(t("custom providers"));
		// 但区块本体(副标题 + 添加按钮)不得泄漏到其它 tab。
		expect(html).not.toContain(paneMarker);
		expect(html).not.toContain(paneButton);
	});

	it("自定义供应商区块自身能渲染出这些标记(证明上面的断言非空转)", () => {
		const html = renderToStaticMarkup(
			<CustomProviderPane
				custom={[{ name: "verify-provider", baseUrl: "https://example.test/v1", models: [] }] as never}
				rpc={null}
				sessionId={null}
				onChanged={() => {}}
			/>,
		);
		expect(html).toContain(paneMarker);
		expect(html).toContain("verify-provider");
	});
});
