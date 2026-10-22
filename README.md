# pi-compact-steps

Claude Code style **one-line tool steps** for [pi](https://pi.dev): every tool call is drawn as a
single line, every result as a single summary line. Press `ctrl+o` (or click the row) to expand it and
pi's own renderer takes over — diff colors, syntax highlighting, full output.

```
 ⏺ read src/index.ts
 ⎿ 31 lines · 12ms
 ⏺ grep /registerToolRenderer/ in src
 ⎿ 12 matches
 ⏺ edit src/index.ts
 ⎿ +4 −2
 ⏺ bash bun test
 ⎿ 18 lines · 1.3s
```

While a tool runs, the status line above the editor shows the same step as one line, so nothing is
appended to the transcript until the step finishes.

## Install

```bash
pi install npm:pi-compact-steps      # after the npm release
pi install git:github.com/FurBlood344324/pi-compact-steps
pi install ./pi-compact-steps        # local checkout
```

Or try it for one run without installing anything:

```bash
pi -e ./extensions/index.ts
```

Remove with `pi remove <source>`, reload running sessions with `/reload`.

## What changes and what does not

| | |
|---|---|
| View only | Tool behavior, tool results and the model's context are untouched. |
| Opt out per tool | Tools with their own renderer (`Agent`, `codemode`, `question`, mcp…) are left alone. |
| Expanded view | Delegated to pi's built-in renderer, the extension never re-implements diffs or output. |
| Thinking block | Untouched unless you opt in (see below). |

## How it relates to pi's built-in rendering

pi already collapses long tool output and expands it again — that behavior is not what this extension
adds. The difference is the *shape* of the collapsed row:

- built-in: boxed shell, a call line, then a result preview block;
- pi-compact-steps: **no box**, call and result are one line each, state lives in the bullet color
  (running → warning, failed → error, done → accent), result gets a unit and a duration
  (`12 matches`, `+4 −2`, `8 lines · 1.3s`).

If you like the built-in shape, you do not need this package. It is a taste choice, not a fix.

## Configuration

All optional, via environment variables:

| Variable | Default | Meaning |
|---|---|---|
| `COMPACT_STEPS_TOOLS` | `read,write,edit,bash,bash_exec,shell,powershell,grep,find,glob,ls` | Tools to compact. Tools outside the list are still compacted when they have no renderer of their own. |
| `COMPACT_STEPS_GLYPHS` | `⏺,⎿` | Call and result glyphs (`bullet,result`), for terminals with poor glyph coverage. |
| `COMPACT_STEPS_THINKING_LABEL` | unset | Opt-in: label used for the collapsed thinking block, e.g. `"✦ thinking…"`. Requires pi's `hideThinkingBlock` setting. Unset means the thinking block is never touched. |

```bash
COMPACT_STEPS_GLYPHS="●,└" pi
```

## Compatibility

`renderShell: "self"`, `renderCall`/`renderResult`, `ToolRenderContext.expanded` and `outputPad` are
part of pi's extension API but are documented thin, so pin your pi version if you care:

- Developed and tested against pi **1.4.0** (`@earendil-works/pi-coding-agent`).
- Requires a pi version whose `ToolRenderContext` carries `outputPad`, `durationMs`, `expanded` and
  `state`; older versions render the lines without padding.
- The package declares only `@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui` as peer
  dependencies; pi supplies both, they are deliberately not bundled.

## Release

Publishing runs in GitHub Actions with **OIDC trusted publishing** — no npm token is stored anywhere.
A `v*` tag is the only trigger:

```bash
npm version patch --no-git-tag-version   # bump package.json
# edit CHANGELOG-ish notes, commit
git push
git tag v0.1.1 && git push origin v0.1.1  # ← publishes
```

The workflow (`.github/workflows/publish.yml`) fails if the tag and `package.json` version disagree,
runs `bun install && bun test`, then publishes with provenance. Pre-release versions (`-rc.1`) go to
the `next` dist-tag instead of `latest`.

One-time setup on the npm side (requires npm >= 11.15 and 2FA):

```bash
npm trust github pi-compact-steps \
  --repo FurBlood344324/pi-compact-steps \
  --file publish.yml --allow-publish
```

`--allow-publish` permits a direct `npm publish`. For a manual 2FA approval step instead, register with
`--allow-stage-publish` and change the last workflow step to `npm stage publish`; you then run
`npm stage approve <id>` yourself.

Manual fallback if CI is unavailable: `npm publish --access public --otp=<code>` from a logged-in shell,
or `npm stage publish` followed by `npm stage approve`.

## Development

```bash
bun test                          # unit tests for the line/step helpers + registration
bunx tsc --noEmit -p tsconfig.json # typecheck against pi's real renderer types
```

`node_modules/@earendil-works/*` in this checkout are symlinks to a local pi install; they are
gitignored and only exist for typecheck/tests.

## License

MIT
