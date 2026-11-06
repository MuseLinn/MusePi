import { Segmented, type TranslationKey, t, tLoose } from "@musepi/client-core";
import type { ConfigFieldDesc } from "@musepi/pi-wire";
import { type ReactNode, useId, useState } from "react";
import {
	type ExternalEnvironmentIssue,
	type ExternalExecutableProbeResult,
	externalEnvironmentIssue,
} from "../lib/external-agent-config";
import { ExecutablePathInput } from "./ExecutablePathInput";
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
	onProbeExecutable,
	validateEnvironment = false,
}: {
	fields: ConfigFieldDesc[];
	values: Record<string, unknown>;
	onChange(key: string, value: unknown): void;
	disabled?: boolean;
	onProbeExecutable?: (value: string) => Promise<ExternalExecutableProbeResult>;
	validateEnvironment?: boolean;
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
					onProbeExecutable={onProbeExecutable}
					validateEnvironment={validateEnvironment}
				/>
			))}
		</div>
	);
}

function restartLabel(restart: ConfigFieldDesc["restart"]): string {
	if (!restart || restart === "none") return t("tools.extRestartNone");
	const key = `ext restart ${restart}` as TranslationKey;
	return t(key);
}

function environmentError(issue: ExternalEnvironmentIssue): string {
	if (issue === "invalid-json") return t("tools.extConfigEnvInvalidJson");
	if (issue === "not-object") return t("tools.extConfigEnvNotObject");
	return t("tools.extConfigEnvValues");
}

function ConfigFieldRow({
	desc,
	value,
	onChange,
	disabled,
	onProbeExecutable,
	validateEnvironment,
}: {
	desc: ConfigFieldDesc;
	value: unknown;
	onChange(key: string, value: unknown): void;
	disabled: boolean;
	onProbeExecutable?: (value: string) => Promise<ExternalExecutableProbeResult>;
	validateEnvironment: boolean;
}): ReactNode {
	const inputId = useId();
	const [environmentValidation, setEnvironmentValidation] = useState<
		{ issue: ExternalEnvironmentIssue } | { valid: true } | null
	>(null);
	const stringValue = typeof value === "string" ? value : String(desc.default ?? "");
	const environmentInvalid = environmentValidation !== null && "issue" in environmentValidation;
	const environmentFeedbackId = `${inputId}-environment-feedback`;

	const validateEnvironmentValue = (): void => {
		if (!validateEnvironment || desc.key !== "env") return;
		const issue = externalEnvironmentIssue(stringValue);
		setEnvironmentValidation(issue ? { issue } : stringValue.trim() ? { valid: true } : null);
	};

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
					>
						<span className="gui-toggle-knob" />
					</button>
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
				// optionLabels 声明(值 → i18n 键/原文)优先,缺省回退原始值;
				// 全部经 tLoose 解析,未注册的原文(如用户插件的中文文案)原样通过。
				const labelOf = (o: string): string => tLoose(desc.optionLabels?.[o] ?? o);
				if (options.length <= 4) {
					return (
						<Segmented
							value={current}
							options={options.map(o => ({ value: o, label: labelOf(o) }))}
							onChange={next => onChange(desc.key, next)}
							ariaLabel={desc.key}
						/>
					);
				}
				return (
					<GuiSelect
						value={current}
						options={options.map(o => ({ value: o, label: labelOf(o) }))}
						onChange={next => onChange(desc.key, next)}
						ariaLabel={desc.key}
						disabled={disabled}
					/>
				);
			}
			case "path":
				if (onProbeExecutable) {
					return (
						<ExecutablePathInput
							id={inputId}
							name={desc.key}
							value={stringValue}
							disabled={disabled}
							onChange={next => onChange(desc.key, next)}
							onProbe={onProbeExecutable}
						/>
					);
				}
				return (
					<input
						id={inputId}
						name={desc.key}
						type="text"
						className="gui-plugin-config-input"
						value={stringValue}
						aria-label={desc.key}
						disabled={disabled}
						onChange={event => onChange(desc.key, event.target.value)}
					/>
				);
			case "string":
				return (
					<div className="gui-plugin-config-control">
						<input
							id={inputId}
							name={desc.key}
							type="text"
							className="gui-plugin-config-input"
							value={stringValue}
							aria-label={desc.key}
							aria-describedby={environmentValidation ? environmentFeedbackId : undefined}
							aria-invalid={environmentInvalid || undefined}
							disabled={disabled}
							onChange={event => {
								setEnvironmentValidation(null);
								onChange(desc.key, event.target.value);
							}}
							onBlur={validateEnvironmentValue}
						/>
						{environmentValidation && (
							<div
								id={environmentFeedbackId}
								className={`gui-plugin-config-feedback${environmentInvalid ? "--error" : "--success"}`}
								role={environmentInvalid ? "alert" : "status"}
							>
								{environmentInvalid
									? environmentError(environmentValidation.issue)
									: t("tools.extConfigEnvValid")}
							</div>
						)}
					</div>
				);
		}
	})();

	return (
		<div className={`gui-settings-row${disabled ? " gui-settings-row--disabled" : ""}`}>
			<div className="gui-plugin-config-field">
				{/* label 声明(i18n 键或原文)优先,缺省回退设置键;经 tLoose 解析。 */}
				<label className="gui-settings-row-label" htmlFor={inputId}>
					{tLoose(desc.label ?? desc.key)}
				</label>
				{desc.description && <div className="gui-settings-row-desc">{tLoose(desc.description)}</div>}
				{desc.restart && desc.restart !== "none" && (
					<div className="gui-plugin-config-restart">
						{t("tools.extRestartLabel")} · {restartLabel(desc.restart)}
					</div>
				)}
			</div>
			{control}
		</div>
	);
}
