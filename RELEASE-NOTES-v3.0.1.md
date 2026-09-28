# Sigma Oasis v3.0.1 — what a restart, a bundle and a Windows clone got wrong

3.0.1 adds nothing. It ships five branches of fixes that were finished and never reached 3.0.0,
and two of them are bugs in the build 3.0.0 users run today: the scheduled jobs could not start
in the built app, and a plan saved in the middle of a run came back after a restart still claiming
a process that no longer existed. Pinned by 2,935 node checks and every Electron check — which
now run on Windows as well as macOS and Linux.

## The jobs could not start

The job runners reached their sibling modules with a runtime `require('./x')`. electron-vite
bundles the main process into one file and follows only `import`, so those calls survived
verbatim into the bundle, where no `./x` exists beside it. In the built app every runner —
research, price, ledger, packs — failed with *Cannot find module* before doing anything, and the
Jobs tab's watchlist always came back empty, so a price job could not be added. The node suite
could not see it: it compiles one file per module, and there `./x` sits right beside its caller.

The imports are static now. A new check, `mainBundleCheck`, requires every relative `require` or
`import` left in the built main and preload bundles to resolve to a file, then boots the built app
on a throwaway profile and runs every runner for real. Against the build before the fix it fails
14 of 20.

## The ledger job, once it could run

Three defects the runner's failure had hidden, all in how it re-checks the fact ledger:

- **A re-confirmed claim stayed expired.** The new expiry was computed as the old one again, so
  every run fetched the claim, reported it re-confirmed, and left it stale. It is now fresh for
  its class's window, stamped exactly as a claim a reply states again is.
- **The same ten claims led every run.** A claim whose source no longer states it stays expired
  and kept its place, so nothing behind the first ten was ever re-checked again. Runs now take
  claims never re-checked first, then those re-checked longest ago; every expired claim is tried
  within ⌈n / 10⌉ runs.
- **A claim its source stopped stating stayed forever.** The third failed re-check in a row now
  drops it, named in the digest. A page that is gone (404, 410) or read and no longer stating the
  value counts; a page that could not be reached — offline, a proxy down, a timeout — checked
  nothing and counts neither way, so a few days without a connection do not empty the ledger.

## A plan that outlived the app that ran it

A plan's live parts — the approval waiting on a click, the step loop, the Stop — belong to the
running app, and none of them is on disk. A plan saved mid-flight (renaming the chat while a plan
is open is enough) came back after a restart in one of two false states:

- **Waiting for approval**, with *▶ Run this plan* and *Cancel* buttons that did nothing and said
  nothing.
- **Running**, with a step pulsing ◌ forever over a process that no longer existed.

Both are settled when the conversation loads. The plan reads *abandoned when the app quit*, with a
note saying what happened and that sending the request again makes a fresh plan; a step cut off
mid-run reads ⊘ *Cut off*, so the census says "1 done, 1 cut off, 2 never ran". Neither borrows
*cancelled* or *stopped*, which are the reader's own decisions and were not taken here. Both draw
in a new info ink that clears AA on the plan block in both themes (5.71:1 light, 7.89:1 dark).

Found on the way, and larger than the plan: editing the **server address** reloaded every
conversation from disk and replaced what the window held with it — which deleted every open
unsaved (ephemeral) chat, since disk by design never has one. Conversations now load once, when
settings arrive, and a load reconciles with what the window holds instead of replacing it. The
history limit counts only conversations that have a file, so an unsaved chat can never push a
saved one off disk.

## Settings fields in the dark theme

Seventeen fields carried layout classes and nothing else, and the app never declared a colour
scheme, so the browser drew them white in both themes: white text on white, 1:1, in the dark one.
MCP's add-a-server form and approval selects, the Jobs tab's add-a-job form and interval selects,
and the Code Mode select on every model slot. They now share one field style and read 16.3–17.8:1;
MCP's masked environment rows read 15.3:1 light and 16.3:1 dark. The list a `<select>` opens is
painted in its owner's colour scheme, so on Windows and Linux every dark-theme select opened white
options on white; the stylesheet now declares `color-scheme` per theme, and the list reads 16.9:1.
A new check, `fieldContrastCheck`, walks every Settings tab and the Project modal in both themes,
with an unstyled probe field on each so a control added later without classes is covered too.

## Windows

- **Every text file checks out LF.** With `core.autocrlf=true`, Git for Windows' default, a clone
  wrote CRLF, one test failed, and the suite stopped before any Electron check ran. The Windows
  release job checks out the same way, so the Windows installer had been built from different
  bytes than the macOS and Linux ones. `.gitattributes` now says `* text=auto eol=lf`; the six CSV
  eval fixtures committed CRLF keep their bytes, and PDFs are binary.
- **Tests that pin source read it LF on every checkout**, through one `readSource()`. Three tests
  that passed on CRLF were checking less than they said — one read 10,031 characters instead of
  344 — and pass now for the reason they claim.
- **CI runs on Windows.** Two of these fixes existed because no CI leg was one.

## Measured

On Windows, from a CRLF working copy: `npm run typecheck` clean; the node suite 2,935 of 2,935;
every Electron check — render 25, style 74 and 123, tab traversal 43, modal focus 179, field
contrast 20, plan accessibility 175, main bundle 20, markdown 62, Workbench 53, MCP secrets 19,
transport 24. The plan fix brings 86 test cases whose guards were checked by mutation: twenty
deliberate breaks, each caught by named tests.

## Not in this release

- **The field-contrast check does not yet open the Jobs tab's watched-item picker.** The picker
  could not render until the jobs fix above; the check names where to extend it.
- Anything new for the agent or VIBE.

## Upgrade notes

- Plans gain an outcome, `abandoned`, and a step status, `interrupted`. The app writes them only
  when it settles a plan whose process ended with the app.
- Documents in an app-written library pack (the fact ledger) gain two optional fields,
  `recheckedAt` and `recheckFailures`. A pack written before them reads as never re-checked.
- Conversations load once per window, when settings arrive — no longer again on every change to
  the server address.
- Contributors on Windows: a clone made before the LF rule keeps its CRLF files until they are
  rewritten. On a clean tree, `git rm --cached -r -q . && git reset --hard` rewrites them.
