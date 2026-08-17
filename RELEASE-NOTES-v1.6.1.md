# Sigma Oasis v1.6.1 — the Workbench

**This is the v1.6.0 release.** The app is unchanged from the v1.6.0 tag except
for the release pipeline that builds it: the v1.6.0 run hit two independent CI
failures and its installers were never published, so the same content ships
here under the next patch number. Everything in
[RELEASE-NOTES-v1.6.0.md](./RELEASE-NOTES-v1.6.0.md) — the sandboxed Python
Workbench, `run_python` / `analyze_file`, the "Ran code" block, the Workbench
verifier, the Data Analyst role, and the measured 56% → 100% on the
quantitative suite — applies to this build verbatim.

## What v1.6.1 actually changes (build & release only)

- **Windows installer restored.** The Windows job failed on v1.6.0 because
  Windows Python writes CRLF line endings and the Pyodide wheel list reached
  `curl` with a trailing `\r` on every URL (`curl: (3) URL rejected`). The
  fetch script now strips CR and `.gitattributes` pins scripts to LF.
- **One job owns the release.** On 2026-08-17 GitHub's list-releases REST
  endpoint began returning an empty array for every repository, which made
  each platform job in the v1.6.0 run create its *own* draft release — the
  signed DMGs landed on one, the AppImage on another, and the Homebrew bump
  failed against the one with no DMGs. The platform jobs now build with
  `--publish never` and hold no write permission; a single publish job creates
  one draft, attaches all nine assets by release id, and **fails unless every
  expected asset is present** — so an incomplete release fails its own run
  instead of being discovered on the release page.
- **Asset names are now literal.** `artifactName` hard-codes `Sigma-Oasis`
  rather than interpolating the product name ("Sigma Oasis"); the dashed form
  is what every published asset has always carried and what the auto-update
  metadata points at.

## Upgrade notes

Identical to v1.6.0's, with one correction: **v1.6.0 was never published**, so
auto-update takes you from v1.4.7 (the last released build) straight to v1.6.1.

**Full changelog:** https://github.com/CELCPG/SigmaOasis/compare/v1.4.7...v1.6.1
