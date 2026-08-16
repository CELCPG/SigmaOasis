# Releasing Sigma Oasis

Step-by-step checklist for publishing a signed, notarized release to GitHub
Releases. Everything here is account-side setup — the code side is already
verified (typecheck clean, arm64 + x64 DMGs build, v0.5.0 smoke-tested on
macOS 26).

Do the steps in order. Steps 1–5 are one-time setup; step 6 is the actual
release and is all you need to repeat for future versions.

---

## 1. Install and authenticate the GitHub CLI

```bash
brew install gh
gh auth login
```

Choose **GitHub.com → HTTPS → Yes (authenticate Git with GitHub credentials) →
Login with a web browser**. This also configures git's credential helper, so
plain `git push` works afterwards.

## 2. Create the GitHub repo and push `main`

```bash
cd /Users/colinlong/Documents/OpenMind
gh repo create CELCPG/SigmaOasis --public --source=. --remote=origin --push
```

This creates the repo, adds it as the `origin` remote, and pushes `main` in
one command. Verify with `git remote -v` and by opening
https://github.com/CELCPG/SigmaOasis — the `package.json` repository/homepage/bugs
URLs already point there.

## 3. Get your Developer ID certificate into Keychain

You need a **Developer ID Application** certificate:

1. Go to https://developer.apple.com/account/resources/certificates/list
2. If no "Developer ID Application" certificate exists, click **+**, choose
   **Developer ID Application**, and follow the CSR flow (Keychain Access →
   Certificate Assistant → Request a Certificate from a Certificate Authority).
3. Download the `.cer`, double-click to import it into Keychain Access
   (login keychain).
4. Verify the private key paired with it is visible:

```bash
security find-identity -v -p codesigning
```

You should see `1) … "Developer ID Application: Colin Long (TEAMID)"`.
If it says `0 valid identities`, the private key is missing — re-do the CSR
flow on this Mac (the private key is created locally during the CSR step).

## 4. Export the certificate as .p12 and base64 it

1. Open **Keychain Access** → login keychain → **My Certificates**.
2. Expand **Developer ID Application: …**, select **both** the certificate and
   its private key, right-click → **Export 2 items…** → save as `cert.p12`
   with a strong password (you'll need it in the next step).
3. Base64-encode it to the clipboard:

```bash
base64 -i cert.p12 | pbcopy
```

4. **Delete `cert.p12` immediately after the secrets are saved** (step 5) —
   never commit it. `.gitignore` already excludes `scripts/signing.env`, but
   the `.p12` itself is not ignored, so don't leave it in the repo directory.

## 5. Add the five repository secrets

Go to https://github.com/CELCPG/SigmaOasis/settings/secrets/actions and add
**New repository secret** for each:

| Secret | Value |
| --- | --- |
| `CSC_LINK` | The base64 string from step 4 (paste from clipboard) |
| `CSC_KEY_PASSWORD` | The password you set when exporting `cert.p12` |
| `APPLE_ID` | The Apple ID email enrolled in the Developer Program |
| `APPLE_APP_SPECIFIC_PASSWORD` | Generate at https://appleid.apple.com → Sign-In and Security → App-Specific Passwords |
| `APPLE_TEAM_ID` | Your 10-character Team ID, from https://developer.apple.com/account → Membership details |
| `HOMEBREW_TAP_TOKEN` | A PAT with write access to `CELCPG/homebrew-tap`, so the release workflow can bump the cask (`GITHUB_TOKEN` cannot push outside this repo) |

These names are exactly what `.github/workflows/release.yml` reads. Without
them the macOS job fails at signing on purpose — an unsigned build is never
published as a release.

## 6. Cut the release

```bash
cd /Users/colinlong/Documents/OpenMind
git tag v0.5.0
git push origin v0.5.0
```

(or `npm version <x.y.z> && git push --follow-tags` for later versions, which
bumps `package.json` and tags in one step.)

Then watch the run:

```bash
gh run watch
```

The `Release` workflow runs five jobs:

- **Tag is on main** — refuses, before anything is built, a tag that is not an
  ancestor of `main` or whose version disagrees with `package.json`. Tag first
  and merge later and this is what stops you: the artifacts of such a build look
  perfectly fine while the tag names history the repository does not have.
  If it fails, the log prints the exact commands to drop the tag and re-cut it.
- **macOS (signed & notarized)** — typecheck → test suite → bundle → build both
  DMGs → sign → notarize → staple → attach to the GitHub Release. Notarization
  is the slow part; expect 5–15 minutes.
- **Windows** — builds the unsigned NSIS installer and attaches it.
- **Linux** — builds the AppImage and attaches it.
- **Homebrew cask bump** — after the DMGs upload, updates version + SHA-256s in
  `CELCPG/homebrew-tap` and pushes, so `brew install --cask sigma-oasis` tracks
  every tag. Needs the `HOMEBREW_TAP_TOKEN` secret.

When it finishes, publish the draft release and verify the page shows:

- `Sigma Oasis-1.0.0-mac-arm64.dmg`
- `Sigma Oasis-1.0.0-mac-x64.dmg`
- `Sigma Oasis-1.0.0-setup.exe`
- `Sigma Oasis-1.0.0-linux.AppImage`
- `latest-mac.yml` / `latest.yml` / `latest-linux.yml` (auto-update metadata)

The cask bump happens while the release is still a draft, so publish promptly —
until you do, the tap points at a version whose downloads 404.

## 7. Spot-check the signed DMG (recommended, first release only)

Download the arm64 DMG from the release page on your Mac, install, and:

```bash
spctl --assess --verbose /Applications/Sigma Oasis.app
# → accepted, source=Notarized Developer ID

codesign --verify --deep --strict --verbose=2 /Applications/Sigma Oasis.app
# → valid on disk / satisfies its Designated Requirement
```

It should launch with **no Gatekeeper dialog at all**.

---

## If the macOS job fails

- **At signing** — re-check all five secrets for typos/extra whitespace, and
  that the `.p12` contained *both* certificate and private key.
- **At notarization** — get the log (the submission ID is in the CI log):

```bash
xcrun notarytool log <submission-id> \
  --apple-id "$APPLE_ID" --team-id "$APPLE_TEAM_ID" \
  --password "$APPLE_APP_SPECIFIC_PASSWORD"
```

  Common causes: an unsigned nested binary, or a missing hardened-runtime
  entitlement (`build/entitlements.mac.plist` — the app spawns `whisper-cli`
  and a shell, so the entitlements are load-bearing).
- **Windows SmartScreen warning** — expected; Windows builds are unsigned for
  now.

## Known non-blockers

- The repo has a `node:test` suite (`npm test`) which CI runs on every push and
  release; a failure there blocks the build. What CI does *not* do is package a
  signed app on pull requests — signing credentials stay release-only.

## Troubleshooting: macOS "malware" dialog deletes Electron on `npm run dev`

On macOS 26+, Gatekeeper's revocation list covers the **stock ad-hoc-signed
Electron binary** that npm downloads. The dialog says the app "contains
malware" and macOS silently moves the binary to the Trash — dev mode then
fails with `spawn …/Electron.app/Contents/MacOS/Electron ENOENT`, and
locally-built unsigned `dist/*.app` bundles get the same treatment on launch.

- **Dev copies** are fixed automatically: the `postinstall` script
  (`scripts/sign-dev-electron.sh`) re-signs the local Electron ad-hoc (fresh
  CDHash, not on the revocation list) after every `npm install`. If you ever
  hit this mid-session, run it manually.
- **Release builds** are never fixed locally — unsigned release apps will
  always be flagged. Only the CI pipeline (steps 3–5 above: Developer ID
  certificate + the five signing secrets) produces builds macOS trusts.
