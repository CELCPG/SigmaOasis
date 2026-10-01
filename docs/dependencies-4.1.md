# Dependencies — where 4.1 stands (audit, no changes)

Read on 2026-09-30 for Track F: the version `package.json` asks for, the one
`node_modules` holds, and npm's `latest` tag (`npm view <pkg> version`). Nothing
here was upgraded; `package.json` and the lockfile are as 4.0.2 left them.
This is the order to do it in and what each step risks.

| Package | Asked | Installed | Latest | Gap |
| --- | --- | --- | --- | --- |
| electron-builder (dev) | ^24.9.1 | 24.13.3 | 26.15.3 (`v26` tag 26.17.0; 27 in alpha) | two majors |
| electron-updater | ^6.8.9 | 6.8.9 | 6.8.9 | current |
| marked | ^12.0.0 | 12.0.2 | 18.0.14 | six majors — on the XSS path |
| dompurify | ^3.4.12 | 3.4.12 | 3.4.16 | patch, inside the range |
| electron (dev) | ^44.1.1 | 44.1.1 | 44.5.0 | patch, inside the range |
| vite (dev) | ^5.1.0 | 5.4.21 | 8.3.1 | three majors |
| electron-vite (dev) | ^2.0.0 | 2.3.0 | 5.0.0 (6.0 in beta) | three majors |
| @vitejs/plugin-react (dev) | ^4.2.1 | 4.7.0 | 6.1.1 | two majors |
| react, react-dom | ^18.2.0 | 18.3.1 | 19.3.0 | one major |
| @types/react (dev) | ^18.2.55 | 18.3.31 | 19.3.0 | follows react |
| zustand | ^4.5.2 | 4.5.7 | 5.0.15 | one major |
| tailwindcss (dev) | ^3.4.1 | 3.4.19 | 4.3.3 | one major, new engine |
| electron-store | ^8.2.0 | 8.2.0 | 11.0.2 | three majors |
| typescript (dev) | ^5.3.3 | 5.9.3 | 7.0.2 | two majors |
| highlight.js | ^11.9.0 | 11.11.1 | 11.12.0 | minor |

## The two that matter before other work

**electron-builder 24 against electron-updater 6 — align before the signing work.**
The updater is current and depends on `builder-util-runtime` 9.7.0; the builder
is two majors behind on 9.2.4, so `node_modules` carries both (a nested copy
under `electron-updater/`). The metadata the builder writes (`latest*.yml`) is
what the updater reads, and the two halves of that contract are now versions
apart. The signing work should be written once, against 26:

- `electron-builder.yml` has `mac.notarize: { teamId: … }`. 25.0 changed
  `notarize` to a boolean with the team id read from `APPLE_TEAM_ID` — check
  the 25.0 changelog, then move the id to the release workflow's environment.
  Written for 24 and upgraded after, the notarization step breaks on the first
  release that tries it.
- Windows signing has no config yet. 25 moved the signtool options under
  `win.signtoolOptions` and added `win.azureSignOptions` (Azure Trusted
  Signing); config written in 24's shape would be rewritten.
- Risks: artifact names (hard-coded `Sigma-Oasis-…` in all three targets, so
  the rename that bit before cannot recur), the NSIS script defaults, and
  `latest-mac.yml` for two arches. Proof is a dry release: `npm run build:unpack`
  on each platform, then an update from 4.0.2 to a local build with the
  updater pointed at it.

**marked 12 → 18 — it sits on the XSS path.** `lib/markdown.ts` renders every
reply with `marked.parse(…, { async: false })` and hands the HTML to
`DOMPurify.sanitize` (`test/markdownCheck.ts`, in a real window, pins what the
sanitizer keeps and strips). DOMPurify is the boundary, so a marked bug is a
rendering bug before it is a security one — but marked decides what HTML
DOMPurify is given, and six majors of fixes are missing. What changed:

- **13** (2024-06): renderers receive token objects, not positional arguments;
  old-style renderers still work, deprecated. Our extension is old-style:
  `code(code, infostring)` and `table(header, body)`.
- **14** (2024-08): the old renderer is removed — our `code` and `table`
  overrides stop working here and must be rewritten as `code(token)` /
  `table(token)` with `this.parser`. `async: false` with an async extension
  now throws.
- **15** (2024-11): HTML is escaped in the renderers instead of the
  tokenizers, for every token — the change nearest the XSS boundary. Our
  overrides must escape what they emit themselves; `markdownCheck` is the proof.
- **16** (2025-06): ESM only (no `lib/marked.cjs`), Node ≥ 20. The renderer is
  bundled by Vite, so the app is fine; the node suite compiles to CommonJS and
  `test/markdownSplit.test.ts` reaches markdown code — check it still loads
  (Node 22+ `require(esm)` should cover it).
- **17** (2025-11): list items — consecutive text tokens, the checkbox token,
  loose-list text as paragraphs. Changes rendered list HTML; screenshot a
  task list.
- **18** (2026-04): trailing blank lines trimmed from block tokens; TypeScript 6
  types.
- `dompurify` 3.4.12 → 3.4.16 is a lockfile bump inside the range; take it in
  the same change and rerun `markdownCheck`.

Order: 14 first (rewrite the two renderers against token objects, prove with
`markdownCheck` and a reply with a code block and a table), then straight to 18.

## After that, in this order

1. **Patches inside the ranges** — electron 44.5, dompurify, highlight.js
   11.12, postcss/autoprefixer. Lockfile only; the node suite and the Electron
   checks.
2. **React 19 + @types/react 19**, with react-dom. The code uses `JSX.Element`
   as a global (e.g. `ActivityTab.tsx`); React 19's types drop the global `JSX`
   namespace, so every return type becomes `React.JSX.Element` — mechanical,
   and `npm run typecheck` finds all of them. `forwardRef` and `defaultProps`
   usages are the other breakages to grep for.
3. **zustand 5.** Needs React ≥ 18 (have it). A selector that returns a new
   object or array each call now loops (v5 dropped the v4 fallback); wrap those
   in `useShallow`. `appStore.ts` is large — grep its selectors before bumping.
4. **Build chain: vite, electron-vite, @vitejs/plugin-react — together.**
   electron-vite 5 accepts vite 5–7 only; plugin-react 6 requires vite 8. So the
   reachable stable set today is **vite 7 + electron-vite 5 + plugin-react 5**
   (5 accepts vite 4–8). vite 8 (Rolldown instead of esbuild + Rollup) waits for
   electron-vite 6 to leave beta. Risks: `electron.vite.config.ts`, the main
   bundle's externals (`test/mainBundleCheck.ts` is the check that catches a
   `require('./x')` that survives bundling), vite 7's Node ≥ 20.19, and build
   targets. Measure the bundle and cold start against 4.0.2.
5. **tailwind 4.** A new engine: CSS-first config (`@import "tailwindcss"`,
   `@config` for the existing `tailwind.config.js`), the PostCSS plugin moves to
   `@tailwindcss/postcss`, autoprefixer is built in, and several utilities were
   renamed (shadow/blur/rounded scales, `ring` width). The style, contrast and
   field checks under `scripts/test-render.sh` are the proof; expect visual
   diffs. Do it alone, not with the build chain.
6. **electron-store 8 → 11.** 9+ is ESM only; the main process is bundled by
   electron-vite, which externalizes dependencies, so it loads through
   Electron's Node `require(esm)`. `store.ts` is the only importer; the node
   suite stubs it (`test/harness.ts`), so only the Electron checks and a
   launch against a real profile prove the migration keeps settings.
7. **TypeScript 7** (the native compiler) last, when the rest of the toolchain
   names it; 5.9 is current enough for everything above.

None of these is in 4.1's scope (ROADMAP-v4.1.md, Track F: "align
electron-builder 24 with electron-updater 6 before signing work; update marked;
vite/electron-vite majors after"). Each step is one change on its own branch
with the whole `npm test` and a launched app, because `node_modules` is shared
between worktrees and an install in one moves every other.

## 4.3 (2026-10-01): what moved, and the order for the rest

Done on `rel/4.3`, one group a commit, the whole `npm test` green after each (node suite 3,584;
all fourteen Electron check suites). Lockfiles were written by npm 11.10 on Windows, which drops
the `libc` field of the optional native packages; those fields were put back by hand so the diffs
carry only the upgrade.

| group | from → to | why |
| --- | --- | --- |
| D1 | electron 44.1.1 → 44.5.1 | patch inside the range |
| D2 | dompurify 3.4.12 → 3.4.16 | the sanitizer; ≤ 3.4.12 has an XSS advisory (IN_PLACE hook removal — the app does not use IN_PLACE) |
| D3 | highlight.js 11.11.1 → 11.12.0 | minor inside the range |
| D4 | postcss 8.5.23 → 8.5.28, autoprefixer 10.5.4 → 10.6.1 | with browserslist and nanoid 3.3.19 (nanoid < 3.3.18, high) |
| D5 | @types/node 24.13.3 → 24.19.0 | types for Electron 44's Node 24 |
| D6 | `npm audit fix`, no `--force` | undici, fast-uri (electron-store's ajv, in the main process), js-yaml (electron-updater's manifest reader), brace-expansion, @xmldom/xmldom |
| D7 | **marked 12 → 18** | this file's order: renderers on token objects, then 18. Merged from `4.3/marked`; `renderMarkdown`'s HTML compared across 25 samples, identical but for three rendering-neutral changes |

`npm audit`: 18 advisories before (1 critical, 14 high, 3 moderate), 11 after. Every one left needs
a major.

**Next, in this order:**

1. **electron-builder 24 → 26 — now first, not only before signing work.** Nine of the eleven
   advisories are its tree: `tar` (critical: file creation and overwrite through hardlinks and
   symlinks), `builder-util-runtime` (a cross-origin redirect leaks `PRIVATE-TOKEN` and
   `Authorization`), `app-builder-lib` (the AppImage's search path). All build time, on the
   machines that build releases. The plan above stands: `mac.notarize` becomes a boolean with the
   team id from `APPLE_TEAM_ID`; Windows signing options move under `win.signtoolOptions`; check
   whether 26 still needs `release.yml`'s own keychain (the `CSC_KEYCHAIN` workaround for 24's
   `set-key-partition-list` password bug) before deleting it; artifact names are hard-coded and
   should not move. The proof needs a Mac and the release workflow: `npm run build:unpack` on each
   platform, a signed and notarized build from a branch, and an update from 4.2.0 to it. That
   needs Colin — a tag runs the real release — so the Mac half was not attempted. **The Windows
   half is done on `4.3/builder26`** (not merged): 26 refuses `mac.notarize: { teamId }` for every
   platform's build ("should be a boolean"), so `notarize: true`; then `--win` gives
   `Sigma-Oasis-<v>-setup.exe`, its blockmap and a `latest.yml` field for field as 24 wrote it
   for v4.2.0; the app.asar packs the same 52 packages at the same versions (plus dompurify's
   `@types/trusted-types`, and one ajv where 24 packed two); `npm audit` there: 3.
2. **The build chain together: vite 7 + electron-vite 5 + @vitejs/plugin-react 5** (the two
   remaining moderates and vite's high: path traversal in the dev server, esbuild answering any
   website — dev-server exposure, `npm run dev` only). vite 8 waits for electron-vite 6.
3. React 19 + @types/react 19, then zustand 5, then tailwind 4 (alone), then electron-store 11,
   then TypeScript 7 — as above, each on its own branch with a launched app.
