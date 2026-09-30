import { Segmented, type TranslationKey, t } from "@musepi/client-core";
import type { ConfigFieldDesc } from "@musepi/pi-wire";
import type { ReactNode } from "react";
import { GuiSelect } from "./GuiSelect";
import { NumberStepper } from "./settings-sections/shared";

/**
 * ConfigFormRenderer — dsh 式插件配置表单(dsh 插件管理页五段式契约的
 * GUI  half)。输入是 `@musepi/pi-wire` 的 `ConfigFieldDesc[]`(daemon 从
 * 扩展 package.json 的 omp/pi 清单 fail-soft 校验后下发),输出受控的
 * `onChange(key, value)`。取值一律经 `coerceConfigValue` 钳制,存储坏值
 * 不会原样透出(契约见 lib/plugin-config-values.ts)。
 *
 * 类型映射:boolean → 开关行;number → NumberStepper(min/max/step);
 * select → ≤4 项走 Segmented 滑块、更多走 GuiSelect 下拉;
 * string/path → 文本行。restart 声明渲染为字段下方的生效时机提示。
 */
export function ConfigFormRenderer({
	fields,
	values,
	onChange,
	disabled = false,
}: {
	fields: ConfigFieldDesc[];
	values: Record<string, unknown>;
	onChange(key: string, value: unknown): void;
	disabled?: boolean;
}): ReactNode {
	return (
		<div className="gui-plugin-config">
			{fields.map(desc => (
				<ConfigFieldRow
					key={desc.key}
					desc={desc}
					value={values[desc.key]}
					onChange={onChange}
					disabled={disabled}
				/>
			))}
		</div>
	);
}

function restartLabel(restart: ConfigFieldDesc["restart"]): string {
	if (!restart || restart === "none") return t("ext restart none");
	const key = `ext restart ${restart}` as TranslationKey;
	return t(key);
}

function ConfigFieldRow({
	desc,
	value,
	onChange,
	disabled,
}: {
	desc: ConfigFieldDesc;
	value: unknown;
	onChange(key: string, value: unknown): void;
	disabled: boolean;
}): ReactNode {
	const control = (() => {
		switch (desc.type) {
			case "boolean":
				return (
					<button
						type="button"
						role="switch"
						aria-checked={value === true}
						aria-label={desc.key}
						disabled={disabled}
						className={`gui-toggle${value === true ? " gui-toggle--on" : ""}`}
						onClick={() => onChange(desc.key, value !== true)}
					/>
				);
			case "number": {
				const min = typeof desc.min === "number" ? desc.min : Number.MIN_SAFE_INTEGER;
				const max = typeof desc.max === "number" ? desc.max : Number.MAX_SAFE_INTEGER;
				const step = typeof desc.step === "number" ? desc.step : 1;
				const num = typeof value === "number" && !Number.isNaN(value) ? value : Number(desc.default);
				return (
					<NumberStepper
						label={desc.key}
						value={num}
						min={min}
						max={max}
						step={step}
						defaultValue={Number(desc.default)}
						onChange={next => onChange(desc.key, next)}
					/>
				);
			}
			case "select": {
				const options = desc.options ?? [];
				const current = typeof value === "string" && options.includes(value) ? value : String(desc.default);
				if (options.length <= 4) {
					return (
						<Segmented
							value={current}
							options={options.map(o => ({ value: o, label: o }))}
							onChange={next => onChange(desc.key, next)}
							ariaLabel={desc.key}
						/>
					);
				}
				return (
					<GuiSelect
						value={current}
						options={options.map(o => ({ value: o, label: o }))}
						onChange={next => onChange(desc.key, next)}
						ariaLabel={desc.key}
						disabled={disabled}
					/>
				);
			}
			case "string":
			case "path":
				return (
					<input
						type="text"
						className="gui-plugin-config-input"
						value={typeof value === "string" ? value : String(desc.default ?? "")}
						aria-label={desc.key}
						disabled={disabled}
						onChange={e => onChange(desc.key, e.target.value)}
					/>
				);
		}
	})();

	return (
		<div className={`gui-settings-row${disabled ? " gui-settings-row--disabled" : ""}`}>
			<div className="gui-plugin-config-field">
				<div className="gui-settings-row-label">{desc.key}</div>
				{desc.description && <div className="gui-settings-row-desc">{desc.description}</div>}
				{desc.restart && desc.restart !== "none" && (
					<div className="gui-plugin-config-restart">
						{t("ext restart label")} · {restartLabel(desc.restart)}
					</div>
				)}
			</div>
			{control}
		</div>
	);
}
