# Printshop — finalization plan

Review date: 2026-11-24. Baseline: v1.1.0, `npm run verify` 70/70 passing.

Already solid: `contextIsolation` + `sandbox` + `nodeIntegration: false`, tight CSP, narrow preload bridge, offline Ed25519 licence checked in main process on every generate/preview/export.

Order: Phase 1 → 2 → 3 → 4. Tick items as done.

---

## Phase 1 — Security hardening ✅ done 2026-11-25

Done as: session allowlist of job folders (`jobDirs` in `src/main.js`, checks in `src/guard.js`). `export:save`, `cut:preview` and `shell:reveal` only accept a `.png` / folder Printshop generated this session (realpath, so symlinks can't dodge it). `codexPath` must be an absolute path to `codex`/`codex.exe`/`codex.cmd`, checked on save and skipped in `findCodex` otherwise. All navigation, new windows and webviews denied in `web-contents-created`. Tests in `test/verify.js`.

- [x] **1. Restrict `shell:reveal`** (`src/main.js:1205`)
  - Now: `shell.openPath(target)` with any renderer-supplied path. A compromised renderer can launch any `.app`/`.exe`/`.command`.
  - Fix: allow only paths inside `outputDir`; use `shell.showItemInFolder` for folders/reveal, `openPath` only for exported PDFs inside `outputDir`.
- [x] **2. Lock `codexPath`** (`settings:save`, `findCodex`)
  - Now: renderer can store any path, which main later spawns.
  - Fix: set path only via a main-process file dialog, or validate the binary (`--version` output contains `codex`) before saving.
- [x] **3. Validate `file` in `export:save` and `cut:preview`**
  - Now: any image path on disk is read, and output is written beside it.
  - Fix: `path.resolve(file)` must sit inside `outputDir`; reject otherwise.
- [x] **4. Navigation guards** (`createWindow`)
  - Add `webContents.setWindowOpenHandler(() => ({ action: 'deny' }))` and a `will-navigate` handler that calls `preventDefault()`.
- [x] **Tests** for 1–3: paths outside `outputDir` are rejected.

## Phase 2 — Licence integrity & core UX ✅ done 2026-11-26

- [x] **5. Electron fuses** (native `electronFuses` in electron-builder 26, no extra dependency)
  - On: `runAsNode=false`, `enableNodeOptionsEnvironmentVariable=false`, `enableNodeCliInspectArguments=false`, `enableEmbeddedAsarIntegrityValidation`, `onlyLoadAppFromAsar`, `resetAdHocDarwinSignature`.
  - Verified on a local arm64 build: launches, IPC + upscaler work, a byte-patched `app.asar` is refused (`ASAR Integrity Violation`).
  - `resetAdHocDarwinSignature` is required: without it the unsigned arm64 app is SIGKILLed (`Code Signature Invalid`) at launch.
  - `grantFileProtocolExtraPrivileges` was left on at first (turning it off broke `loadFile` from `app.asar`); now off since the renderer moved to `app://` (Phase 3).
  - Limit: while builds are unsigned, someone can also rewrite the hash in `Info.plist`. Integrity becomes strong only with signing (item 8).
- [x] **11. Cancel button** for generate and upscale
  - Main tracks running jobs by kind (`activeJobs`); `job:cancel` kills their process trees with `killTree` and stops retries. Saved images are kept; a job cancelled before any image lands removes its empty folder.
  - Cancel on the progress card while generating; Cancel next to Export while upscaling.
  - Tested in the dev app with a fake `codex` (partial and nothing-saved cases). Upscale cancel not run live: the test image upscaled too fast to cancel.
- [x] **13. First-run checklist**: licence → Codex installed → Codex signed in, one card in place of the empty state, each step with its own button. Re-checks Codex when the window regains focus. Replaces auto-opening Settings when Codex is missing.

## Phase 3 — Distribution & trust

- [ ] **8. Code signing.** Mac notarization first (Apple Developer, USD 99/yr); Windows certificate later. Removes the "damaged"/SmartScreen drop-off for shop staff.
- [ ] **9. Auto-update** with `electron-updater` on GitHub Releases (needs signed Mac builds).
  - Interim done 2026-11-27: on start the app asks GitHub for the latest release and shows a *new version* banner with Download (opens the releases page). No user data sent; off switch in Settings → Licence; privacy page updated.
- [x] **Mac first-launch instructions** (2026-11-27): right-click → Open no longer works on macOS 15+. README, staff guide, site and release notes now say Privacy & Security → Open Anyway.
- [x] **In-app Codex install steps** (2026-11-27): Settings → Codex shows OpenAI's one-line standalone installer (no Node.js) with a Copy button when Codex is missing. Windows standalone path auto-detected.
- [x] **`app://` protocol** (2026-11-27): renderer and images served over `app://`; only this session's job images and chosen references are served; CSP drops `file:`; `grantFileProtocolExtraPrivileges` fuse off. Checked in a fused arm64 build.
- [x] **10. Pin CI actions to commit SHAs** (done 2026-11-26: checkout v4.4.0, setup-node v4.4.0, upload-artifact v4.6.2, action-gh-release v2.6.2; `.github/dependabot.yml` opens weekly pin updates) (`actions/checkout`, `setup-node`, `upload-artifact`, `softprops/action-gh-release`). The workflow has `contents: write`.
- [x] **14. "Copy diagnostics" button** (done 2026-11-26: Settings → Licence → Support, and beside Try again on a failed job; licence id only, no email): app version, OS, Codex version, last error, copied to clipboard for WhatsApp support. No server.

## Phase 4 — Business & ops

- [ ] **6. Machine limit.** `activateMachine` always returns `true` (`src/main.js:118`), so one key works anywhere. Options:
  - (a) Cloudflare Worker that counts machine IDs per key id, or
  - (b) bind key to a machine ID in the payload and reissue on machine change.
  - Do this when key sharing actually shows up.
- [ ] **15. Back up signing key** `~/.printshop-licensing/licence-private.pem`: password manager plus an offline copy. Lose it and no new key the shipped app accepts can be issued.
- [x] **16. Key register + revocation** (done 2026-11-27): `scripts/licence.js` logs every issued key to `~/.printshop-licensing/issued.csv`, with `list` and `revoke <id>`; `REVOKED_IDS` in `src/licence.js` is checked in `verifyLicence`, and the licence screen says when a saved key was withdrawn. Keys issued before this are not in the register: add them by hand.
- [x] **17. Codex version guard** (done 2026-11-27): `CODEX_TESTED` = 0.167.0 in `src/core.js`. Older Codex warns with the update command; newer is noted in diagnostics only. A Codex that rejects our flags fails at once with update advice instead of retrying.
- [ ] **12. Price copy sync**: keep the "Upgrade for RM 30" message in `assertAllowed` (`src/licence.js:112`) in step with the site whenever prices change.

## Housekeeping

- [x] Commit or discard the uncommitted changes in `site/index.html`, `src/renderer/app.js`, `src/renderer/index.html`, `src/renderer/style.css` before tagging.
- [ ] Never surface verbatim error text (which contains local paths) to any future remote service.
- [ ] Bump version (done: 1.2.0 in `package.json`), tag `v1.2.0`, and let CI attach the installers. Then point the site's static download links at 1.2.0.
