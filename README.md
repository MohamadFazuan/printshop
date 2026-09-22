# 🖨️ Printshop

**Type a prompt. Pick a paper size. Get a print-ready PDF at exactly that size.**

No design tool. No API key. No per-image bill. Artwork comes out of [Codex CLI](https://developers.openai.com/codex/cli) running on your own ChatGPT plan — so a busy afternoon of drafts costs the same as a quiet one. 🎉

Every variant is kept at full resolution. The one you pick becomes a PDF whose page is the real physical size you asked for — A4 is 210 × 297 mm, a 10 × 2 ft banner is 10 × 2 ft.

<a href="https://github.com/MohamadFazuan/printshop/releases/latest"><b>⬇️ Download the latest release</b></a>

---

## 📦 Install

Grab the installer for your machine from the [Releases page](https://github.com/MohamadFazuan/printshop/releases/latest).

| Platform | File |
|---|---|
| 🍎 macOS, Apple Silicon | `Printshop-x.y.z-arm64.dmg` |
| 🍏 macOS, Intel | `Printshop-x.y.z.dmg` |
| 🪟 Windows x64 | `Printshop.Setup.x.y.z.exe` |

Both builds are **unsigned**, so the OS will object once. 🛡️

**macOS** — first launch is refused:

> "Printshop" cannot be opened because it is from an unidentified developer.

Right-click the app in Applications → **Open** → **Open**. Once only. If macOS instead calls it *damaged*:

```bash
xattr -dr com.apple.quarantine /Applications/Printshop.app
```

**Windows** — SmartScreen shows *Windows protected your PC*: **More info** → **Run anyway**.

Signing removes both warnings and costs an Apple Developer membership plus a Windows code-signing certificate. Neither is in place yet.

---

## ⚙️ Setup

Printshop has **no server, no accounts and no API keys anywhere in it**. 🔐

Two things must be true on the machine:

1. ✅ Codex CLI installed
2. ✅ `codex login` done — or press **Sign in to Codex** in Settings

Without Codex the app says so on the main screen, up front, rather than failing the moment you press Generate.

<details>
<summary>🗑️ Removed: the OpenAI API key engine</summary>

Earlier versions could also generate through the paid images API with a stored key, with an engine picker, quality tiers and a per-image cost estimate. That whole path is gone — Codex covers it at no cost, and carrying key storage, encryption and pricing tables for an unused fallback was not worth the surface area.

</details>

---

## 📐 Know this before you sell a job

The image tool takes **no size, width or aspect argument**. The shape comes out of the wording of the brief, and the model picks the pixels — usually around 1.5 megapixels, spent across whatever proportions the page asks for. 🎲

That budget is the whole story. Spread over a postcard it is plenty; spread over a banner it is not:

| Size | What lands | Print resolution | Verdict |
|---|---|---|---|
| 🏷️ Sticker 50 × 50 mm | 1254 × 1254 | ~637 DPI | ✅ excellent |
| 💌 A6 postcard | 1056 × 1489 | ~255 DPI | ✅ fine |
| 📄 A5 | 1053 × 1494 | ~181 DPI | ✅ fine |
| 📃 A4 | 1055 × 1491 | ~128 DPI | ⚠️ proofs and internal work |
| 📰 A3 | 1055 × 1491 | ~90 DPI | ⚠️ soft |
| 🖼️ A2 / A1 | 1055 × 1491 | ~64 / 45 DPI | ❌ not print-ready |
| 🎪 Bunting 2 × 5 ft | 793 × 1983 | ~33 DPI | ❌ not print-ready |
| 🚩 Banner 4 × 10 ft | 1983 × 793 | ~17 DPI | ❌ not print-ready |
| ⛺ Tarpaulin 6 × 12 ft | 1774 × 887 | ~12 DPI | ❌ not print-ready |

The readout under **Size** states this per job in plain words, and the bar moves with the piece — a bunting read from across a room is judged against 75 DPI, a flyer in the hand against 300. It will never tell you a banner is fine. 🙅

**For bunting and banner work**, treat the output as a concept or a background element, not the final file: take the art into your design software, rebuild the type as vector, and scale from there. Exports upscale with Lanczos plus a light unsharp pass, which keeps flat-vector edges from turning to mush — but no upscaler invents detail that was never rendered.

### 🧭 Any shape, honestly

Long formats are **not** refused. Ask for a 10 × 2 ft banner and the brief asks Codex for a true 5:1 frame — around 2804 × 561 px — rather than rounding it to a shape the page is not.

Two things the app does about that, both learned the hard way:

- 🚫 **No stretching.** Told only what shape to fill, the model will fill it by squashing what it drew — one 5:1 banner came back with an oval QR code and lettering at twice its natural width. The brief now demands true geometry on every job: circles circular, squares square, letters at normal width.
- 🔍 **Measured, not promised.** Asking for a shape is not the same as getting one. After a job, each variant's real dimensions are compared against your page, and if the one you selected came back a different shape, the app says exactly how much gets cropped on Fill or left white on Fit.

---

## 🎛️ Using it

| Control | What it does |
|---|---|
| ✍️ **Prompt** | What to draw. Plain description works; art-direction language works better. |
| 🖼️ **Reference image** | Optional. Attach a PNG, JPEG or WebP and the artwork takes its subject, style, colour and composition from it. Your page's shape still wins over the reference's. |
| 📏 **Size** | 59 presets — ISO A0–A7, ISO B0–B5, US, photo, cards, stationery, stickers & labels, large format, signage, apparel & merch, square — or **Custom** in `mm / cm / in / ft / px`. |
| 🔄 **Landscape** | Swaps width and height. |
| 🔢 **DPI** | Converts `px` custom sizes and drives the resolution readout. 300 is the print default. |
| 🎲 **Variants** | How many images to generate at once, 1–4. Each is a separate render, so each takes its own time. |
| 🖇️ **Fit** | *Fill page* crops the overflow; *Fit with margin* keeps the whole image and leaves white. |
| 💾 **Format** | PDF, PNG, JPEG or TIFF. Raster exports are rendered at the page size for your DPI — A4 at 300 gives 2480 × 3508. |
| 🎨 **Colour** | RGB or CMYK. CMYK needs a profile (below) and is unavailable for PNG. |
| 💧 **Watermark** | Off / On plus the text. Tiled diagonally across the whole page — harder to crop off than a corner mark. Vector text in PDFs, composited into raster exports. |

Clicking a variant selects it for export. To inspect one properly, hit **⤢** on the tile or double-click it — that opens the full image with its pixel dimensions and filename. Arrow keys move between variants, `Esc` or a click on the backdrop closes. Zooming never changes the selection. 👀

The line under Size shows the page in your unit, in PDF points, and the **effective print resolution**, with a plain-words verdict. Better to know before the paper is used.

### 🤖 Codex CLI

With Codex installed and logged in, it does two jobs — both on your ChatGPT login:

**Draws the artwork.** Generate runs Codex's built-in image model, writing PNGs straight into the job folder. No per-image charge. Expect roughly a minute or two per image — the trade is time for money. ⏳

**Writes the prompt.** ✨ **Improve with Codex** turns a rough brief — *"birthday poster, dinosaur theme, kid turning 5"* — into an art-directed one, told which orientation it is composing for. **Revert** puts your original text back.

Codex chooses its own output dimensions, so the readout under the variant grid reports **what actually landed**, per variant, rather than what was requested. Check it before printing large.

Printshop searches the usual install locations. A GUI app does not inherit your shell `PATH`, so set the full path in Settings if Codex lives somewhere unusual.

### 🔑 Signing in to Codex

Settings shows your login state. **Sign in to Codex** runs `codex login`, which opens your browser — if your ChatGPT account uses Google, click *Continue with Google* there. The credentials go to Codex, never through Printshop. **Sign out** runs `codex logout`.

### 🎨 CMYK

CMYK is a colour space, not a file format, and converting without a profile produces wrong colours that still look plausible on screen. So Printshop will not guess: point Settings at the `.icc` profile your press uses (**Profile…**). It is test-converted on selection, so a bad profile fails there instead of halfway through a job.

No profile on hand? macOS ships `/System/Library/ColorSync/Profiles/Generic CMYK Profile.icc` — fine for proofing, wrong for a real press run. Ask your printer for theirs.

PNG is always RGB; the option disables itself rather than pretending. CMYK PDFs embed CMYK pixels, and the watermark is drawn in CMYK ink so the RIP has nothing left to convert.

### ⏱️ While it runs

A Codex job takes minutes, so it reports as it goes: a progress bar, a running clock, and a live log of what Codex is actually doing.

The percentage counts **images written to disk**, not elapsed time — at `1/2 images · 50%` there really is a finished PNG in the folder. Before the first image lands there is nothing honest to count, so the bar sweeps rather than inventing a number. 📊

The log is Codex's own event stream (`codex exec --json`), so a stall shows its last real step instead of a spinner. If a run comes up short, what was produced is kept — a part-finished job is worth more than a tidy folder — and the app says how many landed and why the rest did not.

### 📂 Output

```
~/Printshop/2026-08-04/red-mountain-poster-a1b2/
  01.png                                    generated, full resolution, kept
  02.png                                    generated, full resolution, kept
  red-mountain-poster-a1b2-A4.pdf           export: RGB, no watermark
  red-mountain-poster-a1b2-A4-PROOF.pdf     export: watermarked
  red-mountain-poster-a1b2-A4-CMYK.tiff     export: CMYK separation
```

Filenames carry the colour space and watermark, so a proof can never quietly overwrite the press-ready file. An export that would land on an existing name gets `-2`, `-3` instead of replacing it. Change the output folder in Settings. **Nothing is ever deleted.** 🗄️

---

## 🛠️ Development

```bash
npm install
npm start       # run the app
npm run verify  # headless checks on size, aspect, PDF and brief logic — no network
```

Build an installer locally:

```bash
npm run dist:mac -- --arm64   # Apple Silicon .dmg
```

⚠️ **Installers cannot be cross-built.** `sharp` carries a native binary per platform, so each installer has to be produced on a machine of that architecture — an Intel `.dmg` built on Apple Silicon ships arm64 binaries and crashes the moment a user exports. Do not force the missing binaries into `dependencies` either: that makes `npm ci` impossible on every platform at once.

So `.github/workflows/build.yml` builds on three runners — `macos-latest` (Apple Silicon), `macos-15-intel` (Intel) and `windows-latest` — each installing its own native binary. `npm run verify` gates every build. 🚦

**Cutting a release:** bump the version in `package.json` first, or electron-builder names the files with the old one.

```bash
git tag -a v1.0.1 -m "Printshop 1.0.1"
git push origin v1.0.1
```

The tag builds all three installers and attaches them to a GitHub Release automatically. 🚀

Regenerate the app icon after editing `build/make-icon.js`:

```bash
node build/make-icon.js
```

### 🗺️ Layout

```
src/core.js              units, presets, aspect maths, the Codex brief,
                         PDF geometry — pure, no Electron, fully tested
src/main.js              Codex process, file writes, IPC — all privileged code
src/preload.js           the entire renderer↔main surface
src/renderer/            UI; no filesystem, no network
test/verify.js           exercises src/core.js directly
build/make-icon.js       generates build/icon.png with no image dependency
```

Sizes live in one table in `src/core.js`, declared in their native unit — **adding a paper size means adding one row**. The wording Codex is given lives there too, so `test/verify.js` can hold it to its word without ever starting Electron.

---

## 🚧 Limits

No bleed or crop marks, no multi-page documents, no job history browser, no auto-update. Resolution is capped by what the image model spends, so large-format work is a starting point rather than a finished file. Generated artwork is subject to OpenAI's usage policies; a rejected prompt surfaces their message verbatim.
