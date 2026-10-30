import { describe, expect, test } from "bun:test";
import compactSteps, {
	StepLine,
	callLine,
	contentLines,
	durationSuffix,
	resultLine,
	shortPath,
	shouldCompact,
	stepParts,
	summaryText,
} from "../extensions/index.ts";

const theme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
};

/** Visible length: drops the ANSI reset codes truncateToWidth appends. */
function visible(text: string): number {
	return text.replace(/\u001b\[[0-9;]*m/g, "").length;
}

function ctx(overrides: Record<string, unknown> = {}) {
	return {
		state: {},
		cwd: "/home/user/work",
		isError: false,
		isPartial: false,
		durationMs: undefined,
		outputPad: 1,
		expanded: false,
		...overrides,
	} as any;
}

function result(text: string, details?: unknown) {
	return { content: [{ type: "text", text }], details };
}

describe("contentLines", () => {
	test("skips blank lines and bracketed notes", () => {
		expect(contentLines("a\n\n b \n[truncated]\n")).toBe(2);
		expect(contentLines("")).toBe(0);
	});
});

describe("shortPath", () => {
	test("keeps cwd-relative paths short and expands unrelated ones", () => {
		expect(shortPath("/home/user/work/src/a.ts", "/home/user/work")).toBe("src/a.ts");
		expect(shortPath("/etc/hosts", "/home/user/work")).toBe("/etc/hosts");
		expect(shortPath("", "/home/user/work")).toBe("");
	});
});

describe("durationSuffix", () => {
	test("formats ms and seconds, hides tiny or missing durations", () => {
		expect(durationSuffix(undefined)).toBe("");
		expect(durationSuffix(40)).toBe("");
		expect(durationSuffix(320)).toBe(" · 320ms");
		expect(durationSuffix(1340)).toBe(" · 1.3s");
	});
});

describe("stepParts", () => {
	test("read carries the line range, bash the command", () => {
		expect(stepParts("read", { path: "/home/user/work/a.ts", offset: 10, limit: 20 }, ctx().cwd)).toEqual({
			label: "read",
			detail: "a.ts",
			note: expect.stringContaining("10"),
		});
		expect(stepParts("bash", { command: "ls -la\nsecond line" }, ctx().cwd)).toEqual({
			label: "bash",
			detail: "ls -la",
			note: "",
		});
	});

	test("codemode shows the first real statement, not the @options comment", () => {
		const code = '// @options: {"models":true}\n\nconst files = await tools.ls({ path: "src" });\nfiles.length';
		expect(stepParts("codemode", { code }, ctx().cwd)).toEqual({
			label: "codemode",
			detail: 'const files = await tools.ls({ path: "src" });',
			note: "",
		});
		expect(stepParts("codemode", {}, ctx().cwd).detail).toBe("...");
	});

	test("unknown tools fall back to the first string argument, then to JSON args", () => {
		expect(stepParts("mcp_thing", { query: "hello" }, ctx().cwd)).toEqual({
			label: "mcp_thing",
			detail: "hello",
			note: "",
		});
		expect(stepParts("mcp_thing", { limit: 5, filter: { open: true } }, ctx().cwd)).toEqual({
			label: "mcp_thing",
			detail: '{"limit":5,"filter":{"open":true}}',
			note: "",
		});
		expect(stepParts("mcp_thing", {}, ctx().cwd).detail).toBe("");
	});
});

describe("summaryText", () => {
	test("read counts lines and reports truncation", () => {
		expect(summaryText("read", result("a\nb\nc"), ctx())).toBe("3 lines");
		expect(summaryText("read", result("a", { truncation: { truncated: true } }), ctx())).toBe(
			"1 lines [truncated]",
		);
	});

	test("edit counts diff additions and removals", () => {
		const diff = "--- a\n+++ b\n@@\n-old1\n-old2\n+new1\n context";
		expect(summaryText("edit", result("ok", { diff }), ctx())).toBe("+1 −2");
		expect(summaryText("edit", result("ok"), ctx())).toBe("applied");
	});

	test("bash reports no output and duration", () => {
		expect(summaryText("bash", result(""), ctx())).toBe("no output");
		expect(summaryText("bash", result("x\ny"), ctx({ durationMs: 1500 }))).toBe("2 lines · 1.5s");
	});

	test("grep and find report counts", () => {
		expect(summaryText("grep", result("a:1\nb:2"), ctx())).toBe("2 matches");
		expect(summaryText("grep", result("No matches found"), ctx())).toBe("no matches");
		expect(summaryText("find", result("a.ts"), ctx())).toBe("1 file");
	});

	test("errors win over every other summary", () => {
		expect(summaryText("bash", result("boom\ntrace"), ctx({ isError: true }))).toBe("boom");
	});

	test("codemode counts nested calls, drops the script header and adds cost", () => {
		const calls = [
			{ name: "read", status: "ok" },
			{ name: "grep", status: "ok" },
			{ name: "models.classify", status: "ok", cost: 0.0004 },
		];
		const text = "Script completed\nWall time 0.4 seconds\nOutput:\na\nb";
		expect(summaryText("codemode", result(text, { calls }), ctx({ durationMs: 420 }))).toBe(
			"3 calls · 2 lines · $0.00040 · 420ms",
		);
		// A failed nested call is surfaced even when the script itself succeeded.
		expect(summaryText("codemode", result(text, { calls: [{ status: "error" }] }), ctx())).toBe(
			"1 call · 1 failed · 2 lines",
		);
		expect(summaryText("codemode", result("", { calls: [] }), ctx())).toBe("no output");
	});
});

describe("line rendering", () => {
	test("call line shows glyph, label and detail", () => {
		const line = callLine("read", { path: "/home/user/work/a.ts" }, theme, ctx());
		expect(line).toBe("⏺ read a.ts");
	});

	test("running and error states change tone only", () => {
		expect(resultLine("bash", result(""), theme, ctx({ isPartial: true }))).toBe("⎿ running…");
		expect(resultLine("bash", result(""), theme, ctx())).toBe("⎿ no output");
	});

	test("a running codemode row already counts its nested calls", () => {
		expect(resultLine("codemode", result("", { calls: [{ status: "ok" }, { status: "running" }] }), theme, ctx({ isPartial: true }))).toBe(
			"⎿ 2 calls · running…",
		);
	});

	test("StepLine renders exactly one clipped line and honors outputPad", () => {
		const line = new StepLine("⏺ bash " + "x".repeat(80), 1);
		const rendered = line.render(20);
		expect(rendered).toHaveLength(1);
		expect(rendered[0]!.startsWith(" ")).toBe(true);
		expect(visible(rendered[0]!)).toBeLessThanOrEqual(20);
		expect(visible(rendered[0]!.trimStart())).toBeLessThanOrEqual(19);

		line.setPad(0);
		expect(line.render(10)[0]!.startsWith(" ")).toBe(false);

		line.setText("a\nb");
		expect(line.render(40)).toEqual(["a"]);
	});

	test("StepLine never loses the whole line when padding exceeds width", () => {
		expect(visible(new StepLine("abc", 5).render(3)[0]!)).toBeLessThanOrEqual(3);
	});
});

function resolverFor() {
	let resolver: any;
	const handlers: Record<string, Function> = {};
	const pi = {
		registerToolRenderer: (fn: any) => {
			resolver = fn;
		},
		on: (name: string, fn: Function) => {
			handlers[name] = fn;
		},
		getSettings: () => ({}),
	} as any;
	compactSteps(pi);
	return { resolver, handlers };
}

describe("registration", () => {
	test("compacts bare and file/shell tools, leaves custom-rendered tools alone", () => {
		const { resolver, handlers } = resolverFor();

		const builtIn = { renderCall: () => ({}) as any, renderResult: () => ({}) as any };
		expect(resolver("read", () => builtIn).renderShell).toBe("self");
		expect(resolver("mcp_thing", () => undefined).renderShell).toBe("self");
		expect(resolver("agent", () => builtIn)).toBeUndefined();
		expect(resolver("question", () => builtIn)).toBeUndefined();

		// Tools with their own renderer are compacted too; ctrl+o still hands back to that renderer.
		expect(resolver("codemode", () => builtIn).renderShell).toBe("self");
		expect(resolver("mcp__jira__search", () => builtIn).renderShell).toBe("self");

		const renderers = resolver("read", () => builtIn);
		const call = renderers.renderCall({ path: "/home/user/work/a.ts" }, theme, ctx());
		expect(call.render(80)[0]).toBe(" ⏺ read a.ts");
		expect(handlers.session_start).toBeDefined();
	});

	test("shouldCompact keeps renderer-less tools and honors the keep list", () => {
		expect(shouldCompact("bash", true)).toBe(true);
		expect(shouldCompact("codemode", true)).toBe(true);
		expect(shouldCompact("agent", true)).toBe(false);
		expect(shouldCompact("agent", false)).toBe(true);
	});

	test("an expanded row hands the call back to the tool's own renderer", () => {
		const { resolver } = resolverFor();
		const baseCall = { render: () => ["BASE"] };
		const baseResult = { render: () => ["BASE"] };
		const base = { renderCall: () => baseCall, renderResult: () => baseResult };
		const renderers = resolver("codemode", () => base);

		const collapsed = renderers.renderCall({ code: "1" }, theme, ctx());
		expect(collapsed.render(80)[0]).toBe(" ⏺ codemode 1");
		expect(renderers.renderCall({ code: "1" }, theme, ctx({ expanded: true }))).toBe(baseCall);
		expect(renderers.renderResult(result("x"), { expanded: true }, theme, ctx({ expanded: true }))).toBe(
			baseResult,
		);
	});
});
