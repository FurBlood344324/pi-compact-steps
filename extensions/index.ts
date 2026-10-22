/**
 * compact-steps — Claude Code style one-line tool steps for pi.
 *
 * View only: tool behavior, results and model context are untouched. `ctrl+o` expands a row and
 * hands it back to pi's own renderer. Tools with their own renderer are left alone.
 *
 * Optional environment variables: COMPACT_STEPS_TOOLS, COMPACT_STEPS_GLYPHS,
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

/** Default compacted tools. Tools outside this set are still compacted when they have no renderer. */
const DEFAULT_TOOLS = [
	"read",
	"write",
	"edit",
	"bash",
	"bash_exec",
	"shell",
	"powershell",
	"grep",
	"find",
	"glob",
	"ls",
];

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

const COMPACT_TOOLS = new Set(envList("COMPACT_STEPS_TOOLS") ?? DEFAULT_TOOLS);

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
		default: {
			const first = Object.values(a).find((value) => typeof value === "string" && value.length > 0);
			return { label: toolName, detail: first ? firstLine(str(first)) : "", note: "" };
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
	const text = textOf(result).trim();
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
		default:
			return firstLine(text) || "ok";
	}
}

export function resultLine(toolName: string, result: any, theme: any, ctx: ToolRenderContext): string {
	const glyph = theme.fg("dim", glyphs.result);
	if (ctx.isPartial) return `${glyph} ${theme.fg("muted", "running…")}`;

	const summary = summaryText(toolName, result, ctx);
	const tone = ctx.isError ? "error" : summary.includes("[truncated]") ? "warning" : "muted";
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
		if (!COMPACT_TOOLS.has(toolName) && hasOwnRenderers) return undefined;

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
