import { describe, expect, test } from "bun:test";
import compactSteps, {
	StepLine,
	callLine,
	contentLines,
	durationSuffix,
	resultLine,
	shortPath,
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

	test("unknown tools fall back to the first string argument", () => {
		expect(stepParts("mcp_thing", { query: "hello" }, ctx().cwd)).toEqual({
			label: "mcp_thing",
			detail: "hello",
			note: "",
		});
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

describe("registration", () => {
	test("compacts bare and file/shell tools, leaves custom-rendered tools alone", () => {
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

		const builtIn = { renderCall: () => ({}) as any, renderResult: () => ({}) as any };
		expect(resolver("read", () => builtIn).renderShell).toBe("self");
		expect(resolver("mcp_thing", () => undefined).renderShell).toBe("self");
		expect(resolver("agent", () => builtIn)).toBeUndefined();

		const renderers = resolver("read", () => builtIn);
		const call = renderers.renderCall({ path: "/home/user/work/a.ts" }, theme, ctx());
		expect(call.render(80)[0]).toBe(" ⏺ read a.ts");
		expect(handlers.session_start).toBeDefined();
	});
});
