/**
 * compact-steps — Claude Code style one-line tool steps for pi.
 *
 * View only: tool behavior, results and model context are untouched. `ctrl+o` expands a row and
 * hands it back to pi's own renderer. Every tool is compacted, including ones with their own
 * renderer (codemode, mcp), except a small keep list whose own row already carries state.
 *
 * Optional environment variables: COMPACT_STEPS_TOOLS, COMPACT_STEPS_KEEP, COMPACT_STEPS_GLYPHS,
 * COMPACT_STEPS_THINKING_LABEL (unset by default; never changes the thinking block on its own).
 */
import { homedir } from "node:os";
import { isAbsolute } from "node:path";
import {
	formatReadLineRange,
	keyText,
	type ExtensionAPI,
	type ToolRenderers,
	type ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";

/**
 * The reader context is not re-exported by the package root, so derive it from the exported
 * renderer type; this keeps the extension typechecked against pi's real signature.
 */
export type ToolRenderContext = Parameters<NonNullable<ToolRenderers["renderCall"]>>[2];
import { type Component, Text, truncateToWidth } from "@earendil-works/pi-tui";

/** Claude Code glyphs, overridable via COMPACT_STEPS_GLYPHS. */
const DEFAULT_GLYPHS = { bullet: "⏺", result: "⎿" };

/** Cap for argument/command summaries (characters). Line width clipping is applied on top. */
const MAX_DETAIL = 100;

/**
 * Tools whose own collapsed row already carries state a one-liner would drop: subagent rows show
 * model/turns/tokens/cost, question rows show the options to pick from.
 */
const DEFAULT_KEEP = ["agent", "question"];

function envList(name: string): string[] | undefined {
	const raw = process.env[name];
	if (!raw) return undefined;
	const items = raw
		.split(",")
		.map((item) => item.trim())
		.filter((item) => item.length > 0);
	return items.length > 0 ? items : undefined;
}

const glyphs = (() => {
	const parts = envList("COMPACT_STEPS_GLYPHS");
	return {
		bullet: parts?.[0] ?? DEFAULT_GLYPHS.bullet,
		result: parts?.[1] ?? DEFAULT_GLYPHS.result,
	};
})();

/** Set: this is the whole allow-list. Unset: everything is compacted except the keep list. */
const EXPLICIT_TOOLS = envList("COMPACT_STEPS_TOOLS");

/** An explicitly set variable wins, even when empty: `COMPACT_STEPS_KEEP=` compacts every tool. */
const KEEP_TOOLS = new Set("COMPACT_STEPS_KEEP" in process.env ? (envList("COMPACT_STEPS_KEEP") ?? []) : DEFAULT_KEEP);

/**
 * Renderer-less tools are always compacted: their default pi row is a boxed block, and nothing in it
 * is lost by the one-liner. Own-renderer tools are compacted too unless they are on the keep list.
 */
export function shouldCompact(toolName: string, hasOwnRenderers: boolean): boolean {
	if (!hasOwnRenderers) return true;
	if (EXPLICIT_TOOLS) return EXPLICIT_TOOLS.includes(toolName);
	return !KEEP_TOOLS.has(toolName);
}

/** Opt-in only: an unset value leaves the hidden-thinking block untouched. */
const THINKING_LABEL = process.env.COMPACT_STEPS_THINKING_LABEL?.trim() || undefined;

// Single line, clipped to width, honoring the outputPad pi's default shell would add.
export class StepLine implements Component {
	text = "";
	pad: number;

	constructor(text = "", pad = 0) {
		this.text = text;
		this.pad = pad;
	}

	setText(text: string) {
		this.text = text;
	}

	setPad(pad: number) {
		this.pad = pad;
	}

	invalidate() {}

	render(width: number): string[] {
		const pad = Math.max(0, Math.min(this.pad, Math.max(0, width - 1)));
		const line = this.text.split("\n", 1)[0] ?? "";
		return [" ".repeat(pad) + truncateToWidth(line, Math.max(1, width - pad))];
	}
}

export function str(value: unknown): string {
	return typeof value === "string" ? value : "";
}

export function firstLine(text: string, max = MAX_DETAIL): string {
	const line = (text.split("\n", 1)[0] ?? "").trim();
	return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** codemode wraps script output in a header; without this the header inflates every count. */
const SCRIPT_HEADER = /^Script (?:completed|failed)\nWall time [\d.]+ seconds\nOutput:\n/;

function resultText(toolName: string, result: any): string {
	const text = textOf(result).trim();
	return toolName === "codemode" ? text.replace(SCRIPT_HEADER, "") : text;
}

function textOf(result: any): string {
	const content = Array.isArray(result?.content) ? result.content : [];
	return content
		.filter((part: any) => part?.type === "text")
		.map((part: any) => str(part.text))
		.join("\n");
}

function hasImage(result: any): boolean {
	return Array.isArray(result?.content) && result.content.some((part: any) => part?.type === "image");
}

/** Content line count: skips blank lines and "[...]" notes (e.g. "[truncated]"). */
export function contentLines(text: string): number {
	return text
		.split("\n")
		.filter((line) => line.trim().length > 0 && !line.trimStart().startsWith("[")).length;
}

export function shortPath(rawPath: unknown, cwd: string): string {
	const value = str(rawPath);
	if (!value) return "";
	const home = homedir();
	if (value === home) return "~";
	if (value.startsWith(`${home}/`)) return `~${value.slice(home.length)}`;
	if (cwd && isAbsolute(value) && value.startsWith(`${cwd}/`)) return value.slice(cwd.length + 1);
	return value;
}

export function durationSuffix(ms: number | undefined): string {
	if (typeof ms !== "number" || ms < 100) return "";
	const text = ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
	return ` · ${text}`;
}

function truncationNote(result: any): string {
	return result?.details?.truncation?.truncated ? " [truncated]" : "";
}

/** Nested codemode calls; they never reach the model as tool rows, so the summary carries them. */
function codemodeCalls(result: any): any[] {
	const calls = result?.details?.calls;
	return Array.isArray(calls) ? calls : [];
}

function codemodeCost(calls: any[]): string {
	const total = calls.reduce((sum, call) => sum + (typeof call?.cost === "number" ? call.cost : 0), 0);
	if (total <= 0) return "";
	return ` · $${total >= 0.01 ? total.toFixed(2) : total.toPrecision(2)}`;
}

function expandHint(): string {
	return keyText("app.tools.expand") || "ctrl+o";
}

export type Step = { label: string; detail: string; note: string };

export function stepParts(toolName: string, args: any, cwd: string): Step {
	const a = args ?? {};
	const path = shortPath(a.path ?? a.file_path, cwd) || "...";
	switch (toolName) {
		case "read":
			return { label: "read", detail: path, note: formatReadLineRange(a.offset, a.limit) };
		case "write": {
			const lines = typeof a.content === "string" ? a.content.split("\n").length : 0;
			return { label: "write", detail: path, note: lines ? `${lines} lines` : "" };
		}
		case "edit":
			return { label: "edit", detail: path, note: "" };
		case "bash":
		case "bash_exec":
		case "shell":
		case "powershell": {
			const command = firstLine(str(a.command), MAX_DETAIL) || "...";
			return {
				label: toolName === "bash" ? "bash" : toolName,
				detail: command,
				note: a.timeout ? `timeout ${a.timeout}s` : "",
			};
		}
		case "grep": {
			const glob = str(a.glob);
			const where = str(a.path) ? `in ${shortPath(a.path, cwd)}` : "";
			return {
				label: "grep",
				detail: `/${str(a.pattern)}/`,
				note: [where, glob ? `(${glob})` : ""].filter(Boolean).join(" "),
			};
		}
		case "find":
			return {
				label: "find",
				detail: str(a.pattern) || "...",
				note: `in ${shortPath(a.path, cwd) || "."}`,
			};
		case "ls":
			return { label: "ls", detail: shortPath(a.path, cwd) || ".", note: "" };
		case "codemode": {
			// Skip @options/pragma comment lines; the first real statement says what the script does.
			const line = str(a.code)
				.split("\n")
				.map((value) => value.trim())
				.find((value) => value.length > 0 && !value.startsWith("//"));
			return { label: "codemode", detail: firstLine(line ?? "..."), note: "" };
		}
		default: {
			const first = Object.values(a).find((value) => typeof value === "string" && value.length > 0);
			if (first) return { label: toolName, detail: firstLine(str(first)), note: "" };
			// Object-only args (mcp tools): a clipped JSON gives more than an empty detail.
			const json = Object.keys(a).length > 0 ? JSON.stringify(a) : "";
			return { label: toolName, detail: json ? firstLine(json) : "", note: "" };
		}
	}
}

export function callLine(toolName: string, args: any, theme: any, ctx: ToolRenderContext): string {
	const step = stepParts(toolName, args, ctx.cwd);
	// Bullet carries state: running → warning, error → error, done → accent.
	const bulletColor = ctx.isError ? "error" : ctx.isPartial ? "warning" : "accent";
	let line = `${theme.fg(bulletColor, glyphs.bullet)} ${theme.fg("toolTitle", theme.bold(step.label))}`;
	if (step.detail) line += ` ${theme.fg("accent", step.detail)}`;
	if (step.note) line += theme.fg("muted", step.note.startsWith(":") ? step.note : ` ${step.note}`);
	return line;
}

export function summaryText(toolName: string, result: any, ctx: ToolRenderContext): string {
	const text = resultText(toolName, result);
	if (ctx.isError) return firstLine(text) || "failed";

	const duration = durationSuffix(ctx.durationMs);
	switch (toolName) {
		case "bash":
		case "bash_exec":
		case "shell":
		case "powershell": {
			const count = contentLines(text);
			return `${count === 0 ? "no output" : `${count} line${count === 1 ? "" : "s"}`}${duration}`;
		}
		case "read": {
			if (hasImage(result)) return `image${duration}`;
			const count = text ? text.split("\n").length : 0;
			return `${count === 0 ? "empty" : `${count} lines`}${truncationNote(result)}${duration}`;
		}
		case "write":
			return `written${duration}`;
		case "edit": {
			const diff = str(result?.details?.diff);
			if (!diff) return `applied${duration}`;
			let added = 0;
			let removed = 0;
			for (const line of diff.split("\n")) {
				if (line.startsWith("+") && !line.startsWith("+++")) added++;
				else if (line.startsWith("-") && !line.startsWith("---")) removed++;
			}
			return `+${added} −${removed}${duration}`;
		}
		case "grep": {
			if (/^no matches/i.test(text)) return `no matches${duration}`;
			const count = contentLines(text);
			return `${count} match${count === 1 ? "" : "es"}${truncationNote(result)}${duration}`;
		}
		case "find": {
			if (/^no files/i.test(text)) return `no files${duration}`;
			const count = contentLines(text);
			return `${count} file${count === 1 ? "" : "s"}${truncationNote(result)}${duration}`;
		}
		case "ls": {
			const count = contentLines(text);
			return `${count} entr${count === 1 ? "y" : "ies"}${truncationNote(result)}${duration}`;
		}
		case "codemode": {
			const calls = codemodeCalls(result);
			const failed = calls.filter((call) => call?.status === "error").length;
			const lines = contentLines(text);
			const parts: string[] = [];
			if (calls.length > 0) parts.push(`${calls.length} call${calls.length === 1 ? "" : "s"}`);
			if (failed > 0) parts.push(`${failed} failed`);
			parts.push(lines === 0 ? "no output" : `${lines} line${lines === 1 ? "" : "s"}`);
			return `${parts.join(" · ")}${codemodeCost(calls)}${duration}`;
		}
		default:
			return firstLine(text) || "ok";
	}
}

export function resultLine(toolName: string, result: any, theme: any, ctx: ToolRenderContext): string {
	const glyph = theme.fg("dim", glyphs.result);
	if (ctx.isPartial) {
		// codemode streams its nested calls, so the running row can already count them.
		const calls = codemodeCalls(result).length;
		const progress = toolName === "codemode" && calls > 0 ? `${calls} call${calls === 1 ? "" : "s"} · ` : "";
		return `${glyph} ${theme.fg("muted", `${progress}running…`)}`;
	}

	const summary = summaryText(toolName, result, ctx);
	const tone = ctx.isError
		? "error"
		: summary.includes("[truncated]") || summary.includes(" failed")
			? "warning"
			: "muted";
	return `${glyph} ${theme.fg(tone, summary)}`;
}

// Compact and pi-renderer components are kept apart so ctrl+o never mixes components or state.
type RowState = {
	compactCall?: StepLine;
	compactResult?: StepLine;
	baseCall?: Component;
	baseResult?: Component;
	baseState?: Record<string, unknown>;
};

function rowState(ctx: ToolRenderContext): RowState {
	const state = ctx.state as any;
	return (state.__compactSteps ??= {} as RowState) as RowState;
}

function baseCallComponent(
	base: ToolRenderers,
	row: RowState,
	args: any,
	theme: any,
	ctx: ToolRenderContext,
): Component {
	const state = (row.baseState ??= {});
	const component = base.renderCall!(args, theme, { ...ctx, lastComponent: row.baseCall, state });
	row.baseCall = component;
	return component;
}

function baseResultComponent(
	base: ToolRenderers,
	row: RowState,
	result: any,
	options: ToolRenderResultOptions,
	theme: any,
	ctx: ToolRenderContext,
): Component {
	const state = (row.baseState ??= {});
	const component = base.renderResult!(result, options, theme, {
		...ctx,
		lastComponent: row.baseResult,
		state,
	});
	row.baseResult = component;
	return component;
}

/** Full output for tools without their own renderer (expanded view). */
function fullOutputComponent(result: any, theme: any, pad: number): Component {
	const text = textOf(result).trim();
	if (!text) return new StepLine("", pad);
	const lines = text
		.split("\n")
		.map((line) => theme.fg("toolOutput", line))
		.join("\n");
	return new Text(`\n${lines}`, pad, 0);
}

export default function (pi: ExtensionAPI) {
	pi.registerToolRenderer((toolName, next) => {
		const base = next();
		const hasOwnRenderers = !!(base?.renderCall || base?.renderResult);
		if (!shouldCompact(toolName, hasOwnRenderers)) return undefined;

		return {
			// Own frame: no box padding, so a step is one or two lines.
			renderShell: "self",

			renderCall(args, theme, ctx) {
				const row = rowState(ctx);
				if (ctx.expanded && base?.renderCall) {
					return baseCallComponent(base, row, args, theme, ctx);
				}
				const line = row.compactCall ?? new StepLine("", ctx.outputPad);
				row.compactCall = line;
				line.setPad(ctx.outputPad);
				line.setText(callLine(toolName, args, theme, ctx));
				return line;
			},

			renderResult(result, options, theme, ctx) {
				const row = rowState(ctx);
				if (options.expanded) {
					if (base?.renderResult) {
						return baseResultComponent(base, row, result, options, theme, ctx);
					}
					return fullOutputComponent(result, theme, ctx.outputPad);
				}
				const line = row.compactResult ?? new StepLine("", ctx.outputPad);
				row.compactResult = line;
				line.setPad(ctx.outputPad);
				line.setText(resultLine(toolName, result, theme, ctx));
				return line;
			},
		};
	});

	// Opt-in; ctrl+t expands the block.
	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		if (!THINKING_LABEL) return;
		if (!pi.getSettings()?.hideThinkingBlock) return;
		ctx.ui.setHiddenThinkingLabel(THINKING_LABEL);
	});

	pi.on("tool_execution_start", (event, ctx) => {
		if (ctx.mode !== "tui" || !ctx.hasUI) return;
		if (event.parentToolCallId) return; // nested call: keep the parent step
		const step = stepParts(event.toolName, event.args, ctx.cwd);
		const detail = step.detail ? ` ${step.detail}` : "";
		ctx.ui.setWorkingMessage(`${glyphs.bullet} ${step.label}${detail}  ·  ${expandHint()}`);
	});

	pi.on("tool_execution_end", (_event, ctx) => {
		if (ctx.mode !== "tui" || !ctx.hasUI) return;
		ctx.ui.setWorkingMessage(undefined);
	});
}
