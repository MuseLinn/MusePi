/**
 * The stylesheet a sandboxed `html` widget face gets before its own markup.
 *
 * Why one shared sheet: an agent that has to draw a table, a bar, a badge or a
 * two-field form on every page writes that CSS itself, differently each time.
 * The result is a transcript where every page has its own idea of a border,
 * a header weight and a focus ring. The kit gives the common shapes the app's
 * own look, so the model spends its budget on the content instead.
 *
 * It is a plain stylesheet, not a component language: the model still writes
 * HTML, and anything the kit does not cover is theirs to style. The class
 * names are the contract — `widget.md` names the same list, and the sandbox
 * receives this text verbatim, so the two cannot drift.
 *
 * Tokens: the host resolves the app's custom properties and injects them on
 * the sandbox root (see `html.tsx`), because a null-origin frame cannot read
 * the app's stylesheet. The chart series are the one palette the kit defines
 * itself: the app has no chart tokens, and a fixed mid-tone set stays legible
 * on both schemes.
 */
export const PAGE_KIT_CSS = `
:root{
  --chart-1:var(--accent,#c9a227);
  --chart-2:#4f9cf9;
  --chart-3:#34c38f;
  --chart-4:#f5a623;
  --chart-5:#e0568a;
}
html{font-size:var(--page-rem,14px)}
html.musepi-theme-dark body,html.omp-theme-dark body{color:#e8e8ea}
html.musepi-theme-light body,html.omp-theme-light body{color:#1f2328}
html.musepi-theme-dark body,html.musepi-theme-light body{
  font-family:var(--font-sans,system-ui,-apple-system,"Segoe UI",sans-serif);
  font-size:1rem;
  line-height:1.6;
}
.musepi-box{
  background:var(--bg-raised);
  border:1px solid var(--border);
  border-radius:var(--radius-lg,10px);
  padding:12px 14px;
}
.musepi-box .musepi-box{background:var(--bg)}
.musepi-muted{color:var(--fg-muted)}
.musepi-table{
  overflow-x:auto;
  border:1px solid var(--border);
  border-radius:var(--radius-md,6px);
}
.musepi-table table{width:100%;border-collapse:collapse;font-size:.9375rem}
.musepi-table th,.musepi-table td{
  padding:8px 10px;
  text-align:start;
  border-bottom:1px solid var(--border);
  vertical-align:top;
}
.musepi-table th{
  font-size:.8125rem;
  font-weight:600;
  color:var(--fg-muted);
  white-space:nowrap;
}
.musepi-table tr:last-child td{border-bottom:0}
.musepi-num{font-variant-numeric:tabular-nums;text-align:end}
.musepi-badge{
  display:inline-flex;
  align-items:center;
  gap:.25rem;
  padding:1px 8px;
  border:1px solid var(--border);
  border-radius:999px;
  background:var(--bg);
  color:var(--fg-muted);
  font-size:.75rem;
  font-weight:600;
  line-height:1.6;
  white-space:nowrap;
}
.musepi-badge[data-tone="success"]{
  color:var(--color-success);
  background:color-mix(in srgb,var(--color-success) 14%,transparent);
  border-color:color-mix(in srgb,var(--color-success) 35%,transparent);
}
.musepi-badge[data-tone="warning"]{
  color:var(--color-warning);
  background:color-mix(in srgb,var(--color-warning) 14%,transparent);
  border-color:color-mix(in srgb,var(--color-warning) 35%,transparent);
}
.musepi-badge[data-tone="danger"]{
  color:var(--color-danger);
  background:color-mix(in srgb,var(--color-danger) 14%,transparent);
  border-color:color-mix(in srgb,var(--color-danger) 35%,transparent);
}
.musepi-badge[data-tone="info"]{
  color:var(--color-info,var(--accent));
  background:color-mix(in srgb,var(--color-info,var(--accent)) 14%,transparent);
  border-color:color-mix(in srgb,var(--color-info,var(--accent)) 35%,transparent);
}
.musepi-dot{
  display:inline-block;
  width:.5rem;
  height:.5rem;
  border-radius:50%;
  background:var(--color,var(--chart-1));
  vertical-align:middle;
}
.musepi-bar{
  position:relative;
  height:.5rem;
  border-radius:999px;
  background:color-mix(in srgb,var(--fg) 10%,transparent);
  overflow:hidden;
}
.musepi-bar::before{
  content:"";
  position:absolute;
  inset:0 auto 0 0;
  width:var(--value,0%);
  border-radius:inherit;
  background:var(--color,var(--chart-1));
}
.musepi-steps{display:grid;gap:10px;margin:0;padding:0;list-style:none;counter-reset:musepi-step}
.musepi-steps>li{
  display:grid;
  grid-template-columns:1.5rem 1fr;
  gap:10px;
  align-items:start;
  counter-increment:musepi-step;
}
.musepi-steps>li::before{
  content:counter(musepi-step);
  display:grid;
  place-items:center;
  width:1.5rem;
  height:1.5rem;
  border-radius:50%;
  background:color-mix(in srgb,var(--accent) 16%,transparent);
  color:var(--accent);
  font-size:.75rem;
  font-weight:700;
}
.musepi-form{display:grid;gap:12px}
.musepi-field{display:grid;gap:6px;font-size:.875rem;color:var(--fg-muted)}
.musepi-input{
  width:100%;
  padding:7px 10px;
  border:1px solid var(--border-strong);
  border-radius:var(--radius-md,6px);
  background:var(--bg);
  color:var(--fg);
  font:inherit;
  font-size:.9375rem;
}
.musepi-input:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
.musepi-switch{
  appearance:none;
  position:relative;
  width:2.25rem;
  height:1.25rem;
  margin:0;
  border:1px solid var(--border-strong);
  border-radius:999px;
  background:var(--bg);
  cursor:pointer;
  transition:background .15s,border-color .15s;
}
.musepi-switch::after{
  content:"";
  position:absolute;
  top:50%;
  left:2px;
  width:1rem;
  height:1rem;
  border-radius:50%;
  background:var(--fg-muted);
  transform:translateY(-50%);
  transition:left .15s,background .15s;
}
.musepi-switch:checked{background:var(--accent);border-color:var(--accent)}
.musepi-switch:checked::after{left:calc(100% - 1rem - 2px);background:var(--accent-fg,#111)}
.musepi-segmented{
  display:inline-flex;
  gap:2px;
  padding:3px;
  border:1px solid var(--border);
  border-radius:999px;
  background:var(--bg);
}
.musepi-segmented>button{
  appearance:none;
  border:0;
  padding:4px 10px;
  border-radius:999px;
  background:transparent;
  color:var(--fg-muted);
  font:inherit;
  font-size:.8125rem;
  cursor:pointer;
}
.musepi-segmented>button[aria-pressed="true"]{
  background:var(--bg-raised);
  color:var(--fg);
  box-shadow:0 1px 2px rgb(0 0 0 / 18%);
}
.musepi-options{display:grid;gap:10px;grid-template-columns:1fr}
@media (min-width:560px){.musepi-options[data-columns="2"]{grid-template-columns:1fr 1fr}}
.musepi-option{
  display:flex;
  flex-direction:column;
  gap:4px;
  width:100%;
  padding:11px 13px;
  border:1px solid var(--border);
  border-radius:calc(var(--radius-lg,10px) * 1.2);
  background:var(--bg-raised);
  color:var(--fg);
  font:inherit;
  text-align:left;
  cursor:pointer;
}
.musepi-option:hover{border-color:var(--border-strong)}
.musepi-option[aria-pressed="true"]{
  border-color:var(--accent);
  box-shadow:inset 0 0 0 1px var(--accent);
}
.musepi-option-sub{color:var(--fg-muted);font-size:.8125rem;line-height:1.5}
.musepi-button{
  display:inline-flex;
  align-items:center;
  justify-content:center;
  gap:6px;
  padding:7px 14px;
  border:1px solid transparent;
  border-radius:var(--radius-md,6px);
  background:var(--accent);
  color:var(--accent-fg,#111);
  font:inherit;
  font-weight:600;
  cursor:pointer;
}
.musepi-button:hover{background:var(--accent-hover,var(--accent))}
.musepi-button[data-variant="outline"]{
  background:transparent;
  border-color:var(--border-strong);
  color:var(--fg);
}
.musepi-button[data-variant="danger"]{
  background:var(--color-danger);
  color:#fff;
}
.musepi-button:focus-visible,.musepi-option:focus-visible,.musepi-segmented>button:focus-visible{
  outline:2px solid var(--accent);
  outline-offset:2px;
}
html[data-musepi-answered] .musepi-option,
html[data-musepi-answered] .musepi-button,
html[data-musepi-answered] .musepi-segmented>button,
html[data-musepi-answered] button,
html[data-musepi-answered] [role="button"]{
  opacity:.5;
  pointer-events:none;
  cursor:default;
}
`;

/**
 * The ready-class list the model is given.
 *
 * Kept beside the stylesheet so a class cannot exist in one and be missing
 * from the other: a prompt that names `.musepi-table` while the sheet has no
 * rule produces an unstyled table, and a sheet rule the prompt never names is
 * dead weight the model never uses.
 */
export const PAGE_KIT_CLASSES = [
	".musepi-box — a panel; a box inside it steps down a tone",
	".musepi-muted — secondary text",
	".musepi-table — a div around a <table>; scrolls sideways when wide",
	".musepi-num — tabular figures, end-aligned (numbers in tables)",
	'.musepi-badge — a pill; data-tone="success|warning|danger|info"',
	".musepi-dot — a legend dot, colored by --color (default --chart-1)",
	".musepi-bar — a horizontal bar, as long as --value (a percentage), colored by --color",
	".musepi-steps — an <ol> of numbered steps",
	".musepi-form — a form grid; .musepi-field around a label + control",
	".musepi-input — an input, select or textarea",
	".musepi-switch — a checkbox drawn as a switch",
	'.musepi-segmented — a strip of <button>s, aria-pressed="true" on the chosen one (also tabs)',
	".musepi-options / .musepi-option / .musepi-option-sub — a choice grid",
	'.musepi-button — the send button; data-variant="outline" or "danger"',
] as const;
