'use strict'

// Everything here is pure and Electron-free so it can be exercised headlessly
// by test/verify.js. Anything privileged (fs, net, keys, IPC) lives in main.js.

const {
  PDFDocument, StandardFonts, degrees, rgb, cmyk,
  PDFName, PDFDict, PDFNumber, PDFOperator, PDFOperatorNames,
  pushGraphicsState, popGraphicsState, rectangle, clip: clipPath, endPath,
  moveTo, lineTo, appendBezierCurve, closePath, stroke, setLineWidth, setGraphicsState,
  setStrokingColor, setFillingColor, fill
} = require('pdf-lib')
const { sheetLayout, sheetMargins, sheetMarks, headerBox, shapeCutPath, MARK_INSET_PT, MM, cutBrief } = require('./cutline')

const EXPORT_FORMATS = ['pdf', 'png', 'jpeg', 'tiff']
const COLOUR_SPACES = ['rgb', 'cmyk']
// PNG has no CMYK in the spec — this is a format limit, not a missing feature.
const CMYK_CAPABLE = ['pdf', 'jpeg', 'tiff']

// ---------------------------------------------------------------------------
// Units. No unit is privileged — everything reduces to PDF points.
// ---------------------------------------------------------------------------

const PT_PER_UNIT = { mm: 2.834645669, cm: 28.34645669, in: 72, ft: 864 }
const UNITS = ['mm', 'cm', 'in', 'ft', 'px']

function toPoints (value, unit, dpi) {
  if (unit === 'px') return (value * 72) / dpi
  if (!(unit in PT_PER_UNIT)) throw new Error(`Unknown unit: ${unit}`)
  return value * PT_PER_UNIT[unit]
}

// Presets stay in their native unit — never pre-converted to mm. Order matters:
// the picker opens a new optgroup whenever `group` changes, so every group's
// entries have to stay contiguous or the same heading appears twice.
const SIZE_PRESETS = [
  { id: 'a3', group: 'ISO A', label: 'A3', w: 297, h: 420, unit: 'mm' },
  { id: 'a4', group: 'ISO A', label: 'A4', w: 210, h: 297, unit: 'mm' },
  { id: 'a5', group: 'ISO A', label: 'A5', w: 148, h: 210, unit: 'mm' },
  { id: 'a6', group: 'ISO A', label: 'A6 postcard', w: 105, h: 148, unit: 'mm' },
  { id: 'a7', group: 'ISO A', label: 'A7', w: 74, h: 105, unit: 'mm' },
  // B-series is the poster series — B2 and B1 are the common street sizes.
  { id: 'b0', group: 'ISO B', label: 'B0', w: 1000, h: 1414, unit: 'mm' },
  { id: 'b1', group: 'ISO B', label: 'B1', w: 707, h: 1000, unit: 'mm' },
  { id: 'b2', group: 'ISO B', label: 'B2', w: 500, h: 707, unit: 'mm' },
  { id: 'b3', group: 'ISO B', label: 'B3', w: 353, h: 500, unit: 'mm' },
  { id: 'b4', group: 'ISO B', label: 'B4', w: 250, h: 353, unit: 'mm' },
  { id: 'b5', group: 'ISO B', label: 'B5', w: 176, h: 250, unit: 'mm' },
  { id: 'letter', group: 'US', label: 'Letter', w: 8.5, h: 11, unit: 'in' },
  { id: 'legal', group: 'US', label: 'Legal', w: 8.5, h: 14, unit: 'in' },
  { id: 'tabloid', group: 'US', label: 'Tabloid', w: 11, h: 17, unit: 'in' },
  { id: 'uposter18x24', group: 'US', label: 'Poster 18 × 24 in', w: 18, h: 24, unit: 'in' },
  { id: 'uposter24x36', group: 'US', label: 'Poster 24 × 36 in', w: 24, h: 36, unit: 'in' },
  { id: 'photo4x6', group: 'Photo', label: '4 × 6 in', w: 4, h: 6, unit: 'in' },
  { id: 'photo5x7', group: 'Photo', label: '5 × 7 in', w: 5, h: 7, unit: 'in' },
  { id: 'photo8x10', group: 'Photo', label: '8 × 10 in', w: 8, h: 10, unit: 'in' },
  { id: 'photo10x15', group: 'Photo', label: '10 × 15 cm', w: 10, h: 15, unit: 'cm' },
  { id: 'photo13x18', group: 'Photo', label: '13 × 18 cm', w: 13, h: 18, unit: 'cm' },
  // 90 × 55 is the Malaysian and wider Asian card; 85 × 55 is European; the
  // 3.5 × 2 in card is US. CR80 is the ISO/IEC 7810 plastic card.
  { id: 'card90x55', group: 'Cards', label: 'Business card 90 × 55 mm', w: 90, h: 55, unit: 'mm' },
  { id: 'card85x55', group: 'Cards', label: 'Business card 85 × 55 mm', w: 85, h: 55, unit: 'mm' },
  { id: 'cardus', group: 'Cards', label: 'Business card 3.5 × 2 in', w: 3.5, h: 2, unit: 'in' },
  { id: 'cardcr80', group: 'Cards', label: 'ID / loyalty card CR80', w: 85.6, h: 54, unit: 'mm' },
  { id: 'cardtent', group: 'Cards', label: 'Tent card 100 × 210 mm', w: 100, h: 210, unit: 'mm' },
  { id: 'dl', group: 'Stationery', label: 'DL flyer 99 × 210 mm', w: 99, h: 210, unit: 'mm' },
  { id: 'voucher', group: 'Stationery', label: 'Voucher 210 × 99 mm', w: 210, h: 99, unit: 'mm' },
  { id: 'envdl', group: 'Stationery', label: 'Envelope DL 110 × 220 mm', w: 220, h: 110, unit: 'mm' },
  { id: 'envc5', group: 'Stationery', label: 'Envelope C5', w: 229, h: 162, unit: 'mm' },
  { id: 'envc4', group: 'Stationery', label: 'Envelope C4', w: 324, h: 229, unit: 'mm' },
  { id: 'env10', group: 'Stationery', label: 'Envelope #10', w: 9.5, h: 4.125, unit: 'in' },
  { id: 'sticker50', group: 'Stickers & labels', label: 'Sticker 50 × 50 mm', w: 50, h: 50, unit: 'mm' },
  { id: 'sticker75', group: 'Stickers & labels', label: 'Sticker 75 × 75 mm', w: 75, h: 75, unit: 'mm' },
  // A round sticker is cut from a square — artwork is generated to the bounding box.
  { id: 'stickerround40', group: 'Stickers & labels', label: 'Round sticker ⌀ 40 mm', w: 40, h: 40, unit: 'mm' },
  { id: 'stickerround50', group: 'Stickers & labels', label: 'Round sticker ⌀ 50 mm', w: 50, h: 50, unit: 'mm' },
  { id: 'stickerround60', group: 'Stickers & labels', label: 'Round sticker ⌀ 60 mm', w: 60, h: 60, unit: 'mm' },
  { id: 'stickeroval7050', group: 'Stickers & labels', label: 'Oval sticker 70 × 50 mm', w: 70, h: 50, unit: 'mm' },
  { id: 'stickerrect6040', group: 'Stickers & labels', label: 'Rectangle sticker 60 × 40 mm', w: 60, h: 40, unit: 'mm' },
  { id: 'stickerrect9050', group: 'Stickers & labels', label: 'Rectangle sticker 90 × 50 mm', w: 90, h: 50, unit: 'mm' },
  { id: 'stickerrect10070', group: 'Stickers & labels', label: 'Rectangle sticker 100 × 70 mm', w: 100, h: 70, unit: 'mm' },
  { id: 'label100x150', group: 'Stickers & labels', label: 'Shipping label 100 × 150 mm', w: 100, h: 150, unit: 'mm' },
  { id: 'bumper', group: 'Stickers & labels', label: 'Bumper sticker 300 × 75 mm', w: 300, h: 75, unit: 'mm' },
  { id: 'a2', group: 'Large format', label: 'A2', w: 420, h: 594, unit: 'mm' },
  { id: 'a1', group: 'Large format', label: 'A1', w: 594, h: 841, unit: 'mm' },
  { id: 'a0', group: 'Large format', label: 'A0', w: 841, h: 1189, unit: 'mm' },
  { id: 'bunting2x5', group: 'Large format', label: 'Bunting 2 × 5 ft', w: 2, h: 5, unit: 'ft' },
  { id: 'bunting3x6', group: 'Large format', label: 'Bunting 3 × 6 ft', w: 3, h: 6, unit: 'ft' },
  { id: 'banner3x8', group: 'Large format', label: 'Banner 3 × 8 ft', w: 8, h: 3, unit: 'ft' },
  { id: 'banner4x10', group: 'Large format', label: 'Banner 4 × 10 ft', w: 10, h: 4, unit: 'ft' },
  { id: 'tarp4x8', group: 'Large format', label: 'Tarpaulin 4 × 8 ft', w: 8, h: 4, unit: 'ft' },
  { id: 'tarp6x12', group: 'Large format', label: 'Tarpaulin 6 × 12 ft', w: 12, h: 6, unit: 'ft' },
  { id: 'rollup85', group: 'Signage', label: 'Roll-up banner 85 × 200 cm', w: 85, h: 200, unit: 'cm' },
  { id: 'rollup100', group: 'Signage', label: 'Roll-up banner 100 × 200 cm', w: 100, h: 200, unit: 'cm' },
  { id: 'xbanner', group: 'Signage', label: 'X-banner 60 × 160 cm', w: 60, h: 160, unit: 'cm' },
  { id: 'yardsign', group: 'Signage', label: 'Yard sign 24 × 18 in', w: 24, h: 18, unit: 'in' },
  { id: 'backdrop8', group: 'Signage', label: 'Backdrop 8 × 8 ft', w: 8, h: 8, unit: 'ft' },
  { id: 'backdrop10', group: 'Signage', label: 'Backdrop 10 × 10 ft', w: 10, h: 10, unit: 'ft' },
  { id: 'vehiclemagnet', group: 'Signage', label: 'Vehicle magnet 24 × 12 in', w: 24, h: 12, unit: 'in' },
  { id: 'teea4', group: 'Apparel & merch', label: 'T-shirt transfer A4', w: 210, h: 297, unit: 'mm' },
  { id: 'teea3', group: 'Apparel & merch', label: 'T-shirt transfer A3', w: 297, h: 420, unit: 'mm' },
  { id: 'mugwrap', group: 'Apparel & merch', label: 'Mug wrap 200 × 90 mm', w: 200, h: 90, unit: 'mm' },
  { id: 'totebag', group: 'Apparel & merch', label: 'Tote bag 250 × 300 mm', w: 250, h: 300, unit: 'mm' },
  { id: 'square', group: 'Square', label: 'Square 210 mm', w: 210, h: 210, unit: 'mm' },
  { id: 'square1x1ft', group: 'Square', label: 'Square 1 × 1 ft', w: 1, h: 1, unit: 'ft' }
]

// How much resolution a job actually needs depends on how far away it is read.
// A 5 ft bunting at 60 DPI is normal trade practice; an A5 flyer at 60 is not.
// Thresholds are keyed on the printed area, which stands in for viewing distance.
const DPI_TIERS = [
  { maxArea: 0.15, want: 300, warn: 150, note: 'read in the hand' }, // up to A3
  { maxArea: 0.50, want: 200, warn: 100, note: 'wall poster' }, //       A2–A1
  { maxArea: 1.50, want: 150, warn: 75, note: 'seen from a few steps back' }, // A0, bunting
  { maxArea: 4.00, want: 100, warn: 50, note: 'seen from across a room' }, //    banner
  { maxArea: Infinity, want: 72, warn: 36, note: 'seen from far off' }
]

function dpiAdvice (wPt, hPt, actualDpi) {
  const areaM2 = ((wPt / 72) * 0.0254) * ((hPt / 72) * 0.0254)
  const tier = DPI_TIERS.find((t) => areaM2 <= t.maxArea)
  return {
    areaM2,
    want: tier.want,
    warn: tier.warn,
    note: tier.note,
    ok: actualDpi >= tier.warn,
    good: actualDpi >= tier.want
  }
}

// The image tool takes no width, height or aspect argument — the shape comes
// out of the wording of the brief and the model picks the pixels. Measured on
// codex-cli 0.153.4: a 10:1 brief came back 2170 × 217 (the shape asked for, at
// 0.47 MP); a 5:1 brief came back 1983 × 793, which is 2.5:1 at 1.57 MP. So ask
// for the page's own proportions instead of rounding every job to one of three
// shapes. The budget below is the figure one of those two renders spent and the
// other did not — a target for the brief, never a size the model is bound to.
const RENDER_PIXELS = 1024 * 1536

// Aspect-driven, so any unit and any custom size works without a lookup table.
function renderSizeFor (wPt, hPt) {
  const ratio = wPt / hPt
  return `${Math.round(Math.sqrt(RENDER_PIXELS * ratio))}x${Math.round(Math.sqrt(RENDER_PIXELS / ratio))}`
}

// 3:2 reads better in a brief than 1.5:1, but only where the page really is a
// tidy ratio — A4 is √2 and saying "2:3" about it was always a rounding.
function ratioLabel (ratio) {
  for (let d = 1; d <= 12; d++) {
    const n = ratio * d
    // Math.round(n) >= 1, or a page thinner than 1:50 rounds to "0:1".
    if (Math.round(n) >= 1 && Math.abs(n - Math.round(n)) < 0.02) return `${Math.round(n)}:${d}`
  }
  return ratio >= 1 ? `${ratio.toFixed(2)}:1` : `1:${(1 / ratio).toFixed(2)}`
}

// What the render size means in words — Codex is told a ratio, not a pixel pair.
function aspectFor (wPt, hPt) {
  const renderSize = renderSizeFor(wPt, hPt)
  const [pxW, pxH] = renderSize.split('x').map(Number)
  const ratio = wPt / hPt
  const orientation = Math.abs(ratio - 1) < 0.02 ? 'square' : ratio < 1 ? 'portrait' : 'landscape'
  return { renderSize, pxW, pxH, orientation, ratio: ratioLabel(ratio) }
}

// Asking for the page's proportions is not the same as getting them: a 5:1
// brief came back 2.5:1 in testing. Only the finished image settles it, so this
// compares what landed against the page — `fill` crops the difference, `fit`
// leaves that much of the page white. Measured after generating, never guessed
// before it.
function aspectStrain (wPt, hPt, imgW, imgH) {
  // Without an image there is nothing to compare. Returning a verdict here
  // would be a silent "all clear" — NaN >= 1.3 is false.
  if (!(imgW > 0) || !(imgH > 0)) return null
  const page = wPt / hPt
  const image = imgW / imgH
  const stretch = Math.max(page / image, image / page)
  return {
    stretch,
    lossPct: Math.round((1 - 1 / stretch) * 100),
    severe: stretch >= 1.3
  }
}

// The whole brief Codex is given for one attempt. Pure, so test/verify.js can
// hold it to its word without an Electron process.
//
// Named files rather than a count, because a retry must fill only the gaps —
// asking again for "4 images" would overwrite the ones that already succeeded.
function generateInstruction (prompt, aspect, names, references = 0, cut = 'none') {
  const many = names.length > 1
  // Older callers passed a boolean; true still means one reference.
  const refCount = references === true ? 1 : Math.max(0, Number(references) || 0)
  const refs = refCount > 1
  return [
    `Generate ${names.length} DIFFERENT image${many ? 's' : ''} using your built-in image model.`,
    `Orientation: ${aspect.orientation}. Aspect ratio ${aspect.ratio}. Target ${aspect.pxW} × ${aspect.pxH} pixels, or the largest the model allows at that ratio.`,
    // Asked only for a shape, the model fills it by stretching what it drew:
    // a 5:1 banner came back with an oval QR code and 2:1 letterforms. Measured
    // — a 5:1 render with these two lines put a circle at 411 × 414 px and a
    // square at 396 × 396.
    'Geometry must be true: circles perfectly circular, squares perfectly square, faces and objects in natural proportion, and lettering at normal letter width.',
    'Do NOT stretch, squash or distort anything to fill the frame. Compose across it instead — more elements, or more space between them.',
    'Use the image model. Do NOT draw the image with code, matplotlib, SVG or any other library.',
    // The attachments arrive through `codex exec -i`, so the agent sees them but
    // has no copy on disk — and must not make one, because every .png in the
    // job folder is counted as a finished variant.
    ...(refCount
      ? [
          refs
            ? `${refCount} reference images are attached to this message. Combine them: take subject, style, colour and composition from across all of them.`
            : 'A reference image is attached to this message. Take subject, style, colour and composition from it.',
          `The orientation and aspect ratio above still win, even where the reference${refs ? 's disagree' : ' disagrees'}.`,
          `Do not save, copy or reproduce the reference file${refs ? 's' : ''} into the folder.`
        ]
      : []),
    // A cut line only works if the artwork was drawn for it — a contour needs
    // the subject on plain white, a shape cut needs art to the edges.
    ...cutBrief(cut),
    `Save the result${many ? 's' : ''} in the current working directory as ${names.join(', ')}.`,
    'Overwrite nothing else in that folder. Create no other files. Reply with only the word DONE.',
    '',
    `Subject: ${prompt}`
  ].join('\n')
}

const clip = (text, max = 140) => {
  const flat = String(text).replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

// Codex writes for a developer reading a terminal. An operator needs to know
// which of the few real causes they hit and what to do about it, so the raw
// text is only ever the fallback — never the whole message.
//
// `fatal` decides whether a second attempt is worth the operator's time. A
// signed-out CLI, a refused prompt, a spent quota or a sandbox that will not
// grant write all fail identically on the retry: the only thing retrying buys
// is the same error twice as late. Those stop the run and report at once.
// Codex CLI is a moving dependency: it ships often and has renamed flags
// before. CODEX_TESTED is the oldest version every job type was run against.
// Older ones get a warning (flags this app passes may not exist yet); newer
// ones are only noted in diagnostics, because Codex releases weekly and a
// warning on every update would teach shops to ignore it. Raise this after
// testing a release, never lower it.
const CODEX_TESTED = '0.167.0'
const CODEX_UPDATE = 'npm install -g @openai/codex@latest'

function parseVersion (text) {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(String(text || ''))
  return m ? m.slice(1, 4).map(Number) : null
}

function compareVersions (a, b) {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1
  return 0
}

// { status: 'ok' | 'old' | 'newer' | 'unknown', version, message }
function codexVersionCheck (versionText, tested = CODEX_TESTED) {
  const version = parseVersion(versionText)
  if (!version) {
    return { status: 'unknown', version: null, message: `Could not read the Codex version ("${clip(versionText, 60)}"). If jobs fail, update Codex: ${CODEX_UPDATE}` }
  }
  const shown = version.join('.')
  const order = compareVersions(version, parseVersion(tested))
  if (order < 0) {
    return { status: 'old', version: shown, message: `Codex ${shown} is older than Printshop was tested with (${tested}). Update it before generating: ${CODEX_UPDATE}` }
  }
  return { status: order > 0 ? 'newer' : 'ok', version: shown, message: '' }
}

// True when a release tag such as `v1.3.0` is a later version than the
// running app. Anything unparseable is not newer, so a malformed answer from
// GitHub never shows a notice.
function isNewerVersion (tag, current) {
  const a = parseVersion(tag)
  const b = parseVersion(current)
  return Boolean(a && b && compareVersions(a, b) > 0)
}

function classifyFailure (raw, { saved = 0, wanted = 0, timedOut = false } = {}) {
  const text = String(raw || '').toLowerCase()
  const partly = saved > 0 ? ` ${saved} of ${wanted} image${saved === 1 ? '' : 's'} was kept.` : ''

  if (timedOut) {
    return { fatal: false, message: `Codex ran out of time and was stopped.${partly} Generating fewer images at once is the reliable fix — each one is a separate round trip to OpenAI.` }
  }
  // clap's wording when Codex no longer (or does not yet) take a flag we pass.
  if (/unexpected argument|unrecognized (option|argument)|unknown (option|flag|argument)|found argument .* which wasn'?t expected/.test(text)) {
    return { fatal: true, message: `This Codex version does not accept the options Printshop sends.${partly} Update Codex (${CODEX_UPDATE}), then try again. If it still fails, Copy diagnostics and send it to us on WhatsApp.` }
  }
  if (/not logged in|logged out|unauthor|401|invalid.*(token|credential)/.test(text)) {
    return { fatal: true, message: 'Codex is signed out. Open Settings and use Sign in to Codex, then try again.' }
  }
  if (/rate.?limit|429|quota|usage limit|too many requests/.test(text)) {
    return { fatal: true, message: `Your ChatGPT plan has hit its usage limit for now.${partly} This clears on its own — wait, or generate fewer images per run.` }
  }
  if (/policy|safety|refus|rejected|cannot (create|generate)|can.?t (create|generate)|not able to (create|generate)/.test(text)) {
    return { fatal: true, message: `OpenAI declined this prompt on content grounds.${partly} Reword the brief — naming real people, brands or logos is the usual cause.` }
  }
  if (/workspace is read-only|read-only workspace|sandbox|seatbelt|landlock|permission denied|eacces|eperm/.test(text)) {
    return { fatal: true, message: `Codex's sandbox refused to write into the job folder.${partly} Pick an output folder under your own user folder — outside OneDrive, Program Files and any network drive — then try again.` }
  }
  if (/enotfound|etimedout|econnreset|econnrefused|network|proxy|tls|certificate/.test(text)) {
    return { fatal: true, message: `Could not reach OpenAI.${partly} Check the connection — a corporate proxy or VPN blocking api.openai.com will do this.` }
  }
  if (/matplotlib|svg|pillow|python|drew|drawing code/.test(text)) {
    return { fatal: false, message: `Codex tried to draw the artwork with code instead of its image model.${partly} Retrying usually lands on the image model.` }
  }
  if (!saved) {
    return { fatal: false, message: `Codex finished without saving any image.${partly || ' '}${clip(raw, 200)}`.trim() }
  }
  return { fatal: false, message: clip(raw, 240) || 'Codex failed without saying why.' }
}

// Codex picks its own output dimensions, so the real DPI can only be known by
// reading the file. IHDR is the first chunk, always at a fixed offset.
function pngSize (buffer) {
  if (buffer.length < 24 || buffer[0] !== 0x89 || buffer[1] !== 0x50) return null
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
}

function sizeToPoints (size) {
  const dpi = Number(size.dpi) || 300
  const w = toPoints(Number(size.w), size.unit, dpi)
  const h = toPoints(Number(size.h), size.unit, dpi)
  if (!(w > 0) || !(h > 0)) throw new Error('Size must be greater than zero.')
  return size.landscape ? { wPt: h, hPt: w } : { wPt: w, hPt: h }
}

// ---------------------------------------------------------------------------
// PDF
// ---------------------------------------------------------------------------

// fill covers the page and lets the overflow fall outside the MediaBox, which
// viewers and RIPs clip; fit contains the image and leaves white margin.
// Either way the image stays centred and keeps its aspect ratio.
function drawRect (imgW, imgH, wPt, hPt, fitMode) {
  const scale = fitMode === 'fit'
    ? Math.min(wPt / imgW, hPt / imgH)
    : Math.max(wPt / imgW, hPt / imgH)
  const width = imgW * scale
  const height = imgH * scale
  return { x: (wPt - width) / 2, y: (hPt - height) / 2, width, height }
}

// ---------------------------------------------------------------------------
// Watermark. Tiled diagonal text — the proof-copy convention, and harder to
// crop out than a single mark in one corner.
// ---------------------------------------------------------------------------

function watermarkTiles (pageW, pageH, textWidth, fontSize) {
  const stepX = Math.max(textWidth * 1.6, fontSize * 6)
  const stepY = Math.max(fontSize * 5, 32)
  const tiles = []
  for (let y = stepY / 2; y < pageH; y += stepY) {
    for (let x = -textWidth / 2; x < pageW; x += stepX) tiles.push({ x, y })
  }
  return tiles
}

function escapeXml (text) {
  return text.replace(/[<>&'"]/g, (c) => (
    { '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]
  ))
}

// Raster watermark. SVG y grows downward, PDF y grows upward — hence the flip.
function watermarkSvg (width, height, text, opacity = 0.25) {
  const fontSize = Math.max(14, Math.min(width, height) / 16)
  const textWidth = text.length * fontSize * 0.58
  const nodes = watermarkTiles(width, height, textWidth, fontSize).map(({ x, y }) => {
    const sy = (height - y).toFixed(1)
    const sx = x.toFixed(1)
    return `<text x="${sx}" y="${sy}" transform="rotate(-45 ${sx} ${sy})">${escapeXml(text)}</text>`
  }).join('')

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${Math.round(width)}" height="${Math.round(height)}">` +
    `<g font-family="Helvetica, Arial, sans-serif" font-size="${fontSize.toFixed(1)}" font-weight="bold" ` +
    `fill="#808080" fill-opacity="${opacity}">${nodes}</g></svg>`
}

function drawWatermark (page, font, watermark, colour, pageW, pageH) {
  const fontSize = Math.max(10, Math.min(pageW, pageH) / 16)
  const textWidth = font.widthOfTextAtSize(watermark.text, fontSize)
  // Keep the mark in the page's own colour space so the RIP has nothing to convert.
  const ink = colour === 'cmyk' ? cmyk(0, 0, 0, 0.5) : rgb(0.5, 0.5, 0.5)

  for (const { x, y } of watermarkTiles(pageW, pageH, textWidth, fontSize)) {
    page.drawText(watermark.text, {
      x,
      y,
      size: fontSize,
      font,
      color: ink,
      opacity: watermark.opacity ?? 0.25,
      rotate: degrees(-45)
    })
  }
}

async function buildPdf (imageBytes, size, fitMode, watermark = null, colour = 'rgb', cut = null) {
  if (cut) return buildStickerPdf(imageBytes, size, fitMode, watermark, colour, cut)
  const { wPt, hPt } = sizeToPoints(size)

  const pdf = await PDFDocument.create()
  const image = await embedImage(pdf, imageBytes)
  const page = pdf.addPage([wPt, hPt])

  page.drawImage(image, drawRect(image.width, image.height, wPt, hPt, fitMode))

  if (watermark && watermark.text) {
    drawWatermark(page, await pdf.embedFont(StandardFonts.HelveticaBold), watermark, colour, wPt, hPt)
  }

  return pdf.save()
}

function embedImage (pdf, bytes) {
  const isPng = bytes[0] === 0x89 && bytes[1] === 0x50
  return isPng ? pdf.embedPng(bytes) : pdf.embedJpg(bytes)
}

// ---------------------------------------------------------------------------
// Stickers. The artwork covers the bleed box (trim plus bleed on every side);
// the cut sits on the trim, or around the artwork for a contour cut.
// ---------------------------------------------------------------------------

// Where the image lands on one sticker, relative to the trim box's bottom-left.
// The contour trace and the PDF both use this, so the cut lines up exactly.
function stickerImageRect (imgW, imgH, wPt, hPt, fitMode, bleedPt) {
  const r = drawRect(imgW, imgH, wPt + 2 * bleedPt, hPt + 2 * bleedPt, fitMode)
  return { x: r.x - bleedPt, y: r.y - bleedPt, width: r.width, height: r.height }
}

// Single sticker, or the sheet it is tiled on. Pure, so the UI can say how
// many fit before anything is exported.
function stickerLayout (size, cut) {
  const { wPt, hPt } = sizeToPoints(size)
  const cellW = wPt + 2 * cut.bleedPt
  const cellH = hPt + 2 * cut.bleedPt
  if (!cut.sheet || cut.sheet === 'single') {
    return { pageW: cellW, pageH: cellH, cols: 1, rows: 1, count: 1, cells: [{ x: 0, y: 0 }], wPt, hPt, cellW, cellH, marks: [], header: null }
  }
  const insetPt = cut.markInsetPt ?? MARK_INSET_PT
  const headerHeightPt = cut.header?.heightPt
  const margins = sheetMargins({ marks: Boolean(cut.marks), header: Boolean(cut.header), insetPt, headerHeightPt })
  // Staggering only makes sense for round cuts; anything else stays on the grid.
  const pattern = cut.pattern === 'staggered' && cut.kind === 'circle' ? 'staggered' : 'grid'
  const layout = sheetLayout(cellW, cellH, cut.sheet, { margins, pattern })
  return {
    ...layout,
    wPt,
    hPt,
    cellW,
    cellH,
    marks: cut.marks ? sheetMarks(layout.pageW, layout.pageH, insetPt) : [],
    header: cut.header ? headerBox(layout.pageW, layout.pageH, margins, headerHeightPt) : null
  }
}

// A Separation colour space named CutContour, shown as 100% magenta. The name
// is what the cutter software keys on; the magenta is only how it looks on
// screen. Overprint is on so the line never knocks a hole in the artwork if a
// RIP prints it by mistake.
// Process black only (K 100) for header text and the QR: it never prints as a
// four-colour smear when slightly off register.
const MARK_INK = cmyk(0, 0, 0, 1)

// The plugin fills its marks with C5 M7 Y9 K100; matched so the sensor sees
// the same black it was set up on.
const REG_MARK_INK = cmyk(0.05, 0.07, 0.09, 1)

function drawRegistrationMarks (page, rects) {
  page.pushOperators(pushGraphicsState(), setFillingColor(REG_MARK_INK))
  for (const m of rects) page.pushOperators(rectangle(m.x, m.y, m.w, m.h))
  page.pushOperators(fill(), popGraphicsState())
}

const HEADER_LAYOUTS = ['brand-left', 'brand-right', 'brand-centre']
const HEADER_FONTS = {
  helvetica: [StandardFonts.Helvetica, StandardFonts.HelveticaBold],
  times: [StandardFonts.TimesRoman, StandardFonts.TimesRomanBold],
  courier: [StandardFonts.Courier, StandardFonts.CourierBold]
}

// '#rrggbb' to a PDF colour. Pure black stays K 100 so it never prints as
// four inks; any other colour goes in as RGB for the RIP to separate.
function headerInk (hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim())
  if (!m) return MARK_INK
  const n = parseInt(m[1], 16)
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255]
  if (r === 0 && g === 0 && b === 0) return MARK_INK
  return rgb(r / 255, g / 255, b / 255)
}

// Standard PDF fonts only encode Latin-1; say so instead of failing deep in pdf-lib.
function headerText (font, text, field, custom) {
  const clean = String(text || '').trim()
  if (!clean || custom) return clean
  try {
    font.encodeText(clean)
  } catch {
    throw new Error(`The sheet header's ${field} uses characters the built-in fonts can't print. Choose a font file (.ttf/.otf) that has them in Settings, or put the text in the logo image.`)
  }
  return clean
}

function fitSize (font, text, want, maxW) {
  if (!text) return want
  const w = font.widthOfTextAtSize(text, want)
  return w > maxW ? want * maxW / w : want
}

// Lines stacked and centred in a box of height h. Each line: { text, font, size }.
// Returns baselines (y from box bottom) for each line.
function stackLines (lines, h) {
  const gap = (l) => l.size * 0.3
  const total = lines.reduce((a, l, i) => a + l.size * 0.74 + (i ? gap(l) : 0), 0)
  let y = (h + total) / 2
  return lines.map((l, i) => {
    if (i) y -= gap(l)
    y -= l.size * 0.74
    return y
  })
}

// Shop header across the top margin. Three blocks — brand (logo, name,
// tagline), QR code and contact (label, phone, extra line) — arranged by
// header.layout. Every size is a share of the strip height, scaled by the
// shop's own percentages, then shrunk only if it would not fit.
// header: { name, tagline, label, phone, extra, logo, qr, layout, nameScale,
//           contactScale, color, font: 'helvetica'|'times'|'courier', fontBytes }
async function drawSheetHeader (pdf, page, box, header) {
  const plan = await layoutSheetHeader(pdf, box, header)
  for (const t of plan.texts) {
    page.drawText(t.text, { x: t.x, y: t.y, size: t.size, font: plan.fonts[t.weight], color: plan.ink })
  }
  // QR as vector squares, so it scans crisply at any print resolution. Always
  // black: a pale brand colour can make a code unreadable.
  if (plan.qr) {
    const { x, y, n, cell, data } = plan.qr
    page.pushOperators(pushGraphicsState(), setFillingColor(MARK_INK))
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        if (data[r * n + c]) page.pushOperators(rectangle(x + c * cell, y + (n - 1 - r) * cell, cell + 0.05, cell + 0.05))
      }
    }
    page.pushOperators(fill(), popGraphicsState())
  }
  if (plan.logo) {
    const { image, x, y, width, height } = plan.logo
    page.drawImage(image, { x, y, width, height })
  }
}

// Where every piece of the header goes, in PDF points (y up). The PDF and the
// Settings preview both draw from this, so the preview cannot drift from print.
async function layoutSheetHeader (pdf, box, header) {
  let regular
  let bold
  const custom = Boolean(header.fontBytes)
  if (custom) {
    pdf.registerFontkit(require('@pdf-lib/fontkit'))
    regular = bold = await pdf.embedFont(header.fontBytes, { subset: true })
  } else {
    const [r, b] = HEADER_FONTS[header.font] || HEADER_FONTS.helvetica
    regular = await pdf.embedFont(r)
    bold = await pdf.embedFont(b)
  }
  const weight = (font) => (font === bold ? 'bold' : 'regular')
  const ink = headerInk(header.color)
  const layout = HEADER_LAYOUTS.includes(header.layout) ? header.layout : 'brand-left'
  const nameScale = Math.min(2, Math.max(0.3, (Number(header.nameScale) || 100) / 100))
  const contactScale = Math.min(2, Math.max(0.3, (Number(header.contactScale) || 100) / 100))

  const name = headerText(bold, header.name, 'shop name', custom)
  const tagline = headerText(regular, header.tagline, 'tagline', custom)
  const label = headerText(regular, header.label, 'order label', custom)
  const phone = headerText(bold, header.phone, 'phone number', custom)
  const extra = headerText(regular, header.extra, 'extra line', custom)
  const gap = 3 * MM
  const h = box.h
  const texts = []

  // Contact block: up to three lines, sized to share the strip height.
  const contact = [
    label && { text: label, font: regular, size: h * 0.22 },
    phone && { text: phone, font: bold, size: h * 0.4 },
    extra && { text: extra, font: regular, size: h * 0.2 }
  ].filter(Boolean)
  const contactRaw = contact.reduce((a, l) => a + l.size * 0.92, 0)
  const contactFit = contactRaw ? Math.min(1, (h * 0.96) / contactRaw) : 1
  for (const l of contact) l.size = fitSize(l.font, l.text, l.size * contactFit * contactScale, box.w * 0.4)
  // Never taller than the strip, whatever the percentage says.
  const contactH = contact.reduce((a, l, i) => a + l.size * 0.74 + (i ? l.size * 0.3 : 0), 0)
  if (contactH > h) for (const l of contact) l.size *= h / contactH
  const contactW = contact.length ? Math.max(...contact.map((l) => l.font.widthOfTextAtSize(l.text, l.size))) : 0

  const qrW = header.qr && header.qr.size ? h : 0
  let logo = null
  let logoW = 0
  if (header.logo) {
    logo = await embedImage(pdf, header.logo)
    logoW = Math.min(h * logo.width / logo.height, box.w * 0.3)
  }

  // Horizontal slots for each block, per layout.
  const right = box.x + box.w
  const slots = {}
  const sideW = qrW + (qrW && contactW ? gap : 0) + contactW
  if (layout === 'brand-left') {
    slots.contact = { x: right - contactW, align: 'right' }
    slots.qr = { x: right - sideW }
    slots.brand = { x: box.x, w: box.w - sideW - (sideW ? gap * 2 : 0), align: 'left' }
  } else if (layout === 'brand-right') {
    slots.qr = { x: box.x }
    slots.contact = { x: box.x + qrW + (qrW ? gap : 0), align: 'left' }
    slots.brand = { x: box.x + sideW + (sideW ? gap * 2 : 0), w: box.w - sideW - (sideW ? gap * 2 : 0), align: 'right' }
  } else {
    slots.qr = { x: box.x }
    slots.contact = { x: right - contactW, align: 'right' }
    const side = Math.max(qrW, contactW) + gap * 2
    slots.brand = { x: box.x + side, w: box.w - side * 2, align: 'centre' }
  }

  // Contact text.
  const baselines = stackLines(contact, h)
  contact.forEach((l, i) => {
    const w = l.font.widthOfTextAtSize(l.text, l.size)
    const x = slots.contact.align === 'right' ? slots.contact.x + contactW - w : slots.contact.x
    texts.push({ text: l.text, x, y: box.y + baselines[i], size: l.size, width: w, weight: weight(l.font) })
  })

  const qr = qrW ? { x: slots.qr.x, y: box.y, size: qrW, n: header.qr.size, cell: qrW / header.qr.size, data: header.qr.data } : null

  // Brand block: logo then name over tagline, fitted into its slot.
  const brand = slots.brand
  const textRoom = Math.max(0, brand.w - (logo ? logoW + gap : 0))
  const lines = [
    name && { text: name, font: bold, size: h * (tagline ? 0.5 : 0.62) * nameScale },
    tagline && { text: tagline, font: regular, size: h * 0.24 * nameScale }
  ].filter(Boolean)
  for (const l of lines) l.size = fitSize(l.font, l.text, l.size, textRoom)
  const linesH = lines.reduce((a, l, i) => a + l.size * 0.74 + (i ? l.size * 0.3 : 0), 0)
  if (linesH > h) for (const l of lines) l.size *= h / linesH
  const textW = lines.length && textRoom > 0 ? Math.max(...lines.map((l) => l.font.widthOfTextAtSize(l.text, l.size))) : 0
  const blockW = (logo ? logoW : 0) + (logo && textW ? gap : 0) + textW
  let x = brand.align === 'left' ? brand.x : brand.align === 'right' ? brand.x + brand.w - blockW : brand.x + (brand.w - blockW) / 2
  let logoPlace = null
  if (logo) {
    const lh = logoW * logo.height / logo.width
    logoPlace = { image: logo, x, y: box.y + (h - lh) / 2, width: logoW, height: lh }
    x += logoW + gap
  }
  if (textW) {
    const ys = stackLines(lines, h)
    lines.forEach((l, i) => {
      const w = l.font.widthOfTextAtSize(l.text, l.size)
      const lx = brand.align === 'right' ? x + textW - w : brand.align === 'centre' ? x + (textW - w) / 2 : x
      texts.push({ text: l.text, x: lx, y: box.y + ys[i], size: l.size, width: w, weight: weight(l.font) })
    })
  }
  return { ink, fonts: { regular, bold }, texts, qr, logo: logoPlace }
}

// The header strip on its own, for the Settings preview: box-relative points
// with y down (SVG), so the screen draws exactly what the PDF will print.
async function headerPreview (sheetKey, header, { marks = true, insetPt } = {}) {
  const { SHEETS } = require('./cutline')
  const sheet = SHEETS[sheetKey] || SHEETS.a4
  const margins = sheetMargins({ marks, header: true, insetPt, headerHeightPt: header.heightPt })
  const box = headerBox(sheet.w, sheet.h, margins, header.heightPt)
  const plan = await layoutSheetHeader(await PDFDocument.create(), box, header)
  const flip = (y) => box.h - (y - box.y)
  return {
    w: box.w,
    h: box.h,
    sheet: sheet.label,
    color: /^#[0-9a-f]{6}$/i.test(String(header.color || '').trim()) ? header.color.trim() : '#000000',
    font: header.fontBytes ? 'custom' : (HEADER_FONTS[header.font] ? header.font : 'helvetica'),
    texts: plan.texts.map((t) => ({ text: t.text, x: t.x - box.x, y: flip(t.y), size: t.size, width: t.width, weight: t.weight })),
    qr: plan.qr && { x: plan.qr.x - box.x, y: flip(plan.qr.y + plan.qr.size), size: plan.qr.size, n: plan.qr.n, data: plan.qr.data },
    logo: plan.logo && { x: plan.logo.x - box.x, y: flip(plan.logo.y + plan.logo.height), width: plan.logo.width, height: plan.logo.height }
  }
}

// A blank sheet with only the marks and header, to check the header before a run.
async function buildHeaderProof (sheetKey, header, { marks = true, insetPt } = {}) {
  const { SHEETS } = require('./cutline')
  const sheet = SHEETS[sheetKey] || SHEETS.a4
  const margins = sheetMargins({ marks, header: true, insetPt, headerHeightPt: header.heightPt })
  const pdf = await PDFDocument.create()
  const page = pdf.addPage([sheet.w, sheet.h])
  await drawSheetHeader(pdf, page, headerBox(sheet.w, sheet.h, margins, header.heightPt), header)
  if (marks) drawRegistrationMarks(page, sheetMarks(sheet.w, sheet.h, insetPt))
  // Show where stickers will start.
  page.drawRectangle({
    x: margins.left,
    y: margins.bottom,
    width: sheet.w - margins.left - margins.right,
    height: sheet.h - margins.top - margins.bottom,
    borderColor: rgb(0.75, 0.75, 0.75),
    borderWidth: 0.5,
    borderDashArray: [4, 4]
  })
  return pdf.save()
}

function addCutContourInk (pdf, page) {
  const ctx = pdf.context
  const tint = ctx.register(ctx.obj({ FunctionType: 2, Domain: [0, 1], C0: [0, 0, 0, 0], C1: [0, 1, 0, 0], N: 1 }))
  const space = ctx.register(ctx.obj([PDFName.of('Separation'), PDFName.of('CutContour'), PDFName.of('DeviceCMYK'), tint]))
  const { Resources } = page.node.normalizedEntries()
  const spaces = Resources.lookupMaybe(PDFName.of('ColorSpace'), PDFDict) || ctx.obj({})
  spaces.set(PDFName.of('CutContour'), space)
  Resources.set(PDFName.of('ColorSpace'), spaces)
  return page.node.newExtGState('GS', ctx.register(ctx.obj({ Type: 'ExtGState', OP: true, op: true, OPM: 1 })))
}

function pathOperators (path, dx, dy) {
  return path.map((cmd) => {
    if (cmd[0] === 'M') return moveTo(cmd[1] + dx, cmd[2] + dy)
    if (cmd[0] === 'L') return lineTo(cmd[1] + dx, cmd[2] + dy)
    if (cmd[0] === 'C') return appendBezierCurve(cmd[1] + dx, cmd[2] + dy, cmd[3] + dx, cmd[4] + dy, cmd[5] + dx, cmd[6] + dy)
    return closePath()
  })
}

const CUT_LINE_WIDTH_PT = 0.25

async function buildStickerPdf (imageBytes, size, fitMode, watermark, colour, cut) {
  const layout = stickerLayout(size, cut)
  const { wPt, hPt, cellW, cellH } = layout
  const b = cut.bleedPt

  const pdf = await PDFDocument.create()
  const image = await embedImage(pdf, imageBytes)
  const page = pdf.addPage([layout.pageW, layout.pageH])
  if (layout.count === 1) {
    // Lets imposition software find the finished size without guessing.
    page.setBleedBox(0, 0, cellW, cellH)
    page.setTrimBox(b, b, wPt, hPt)
  }

  // A contour cut may have shrunk the art to fit its border; use that placement.
  const rect = cut.imageRect || stickerImageRect(image.width, image.height, wPt, hPt, fitMode, b)
  for (const cell of layout.cells) {
    // Clip to this sticker's bleed box, so a Fill overflow never lands on its
    // neighbour. Staggered rows nest into each other, so there the bleed is round.
    const bleedClip = layout.pattern === 'staggered'
      ? pathOperators(shapeCutPath('circle', cellW, cellH), cell.x, cell.y)
      : [rectangle(cell.x, cell.y, cellW, cellH)]
    page.pushOperators(pushGraphicsState(), ...bleedClip, clipPath(), endPath())
    page.drawImage(image, { x: cell.x + b + rect.x, y: cell.y + b + rect.y, width: rect.width, height: rect.height })
    page.pushOperators(popGraphicsState())
  }

  if (watermark && watermark.text) {
    drawWatermark(page, await pdf.embedFont(StandardFonts.HelveticaBold), watermark, colour, layout.pageW, layout.pageH)
  }

  const gs = addCutContourInk(pdf, page)
  page.pushOperators(
    pushGraphicsState(),
    setGraphicsState(gs),
    PDFOperator.of(PDFOperatorNames.StrokingColorspace, [PDFName.of('CutContour')]),
    PDFOperator.of(PDFOperatorNames.StrokingColorN, [PDFNumber.of(1)]),
    setLineWidth(CUT_LINE_WIDTH_PT)
  )
  for (const cell of layout.cells) page.pushOperators(...pathOperators(cut.path, cell.x + b, cell.y + b))
  page.pushOperators(stroke(), popGraphicsState())

  if (layout.marks.length) drawRegistrationMarks(page, layout.marks)
  if (layout.header && cut.header) await drawSheetHeader(pdf, page, layout.header, cut.header)

  return pdf.save()
}

// ---------------------------------------------------------------------------
// Naming
// ---------------------------------------------------------------------------

function slugify (prompt) {
  const slug = prompt.toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 32)
    .replace(/-$/, '')
  return slug || 'artwork'
}

function today (date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

// Pixel canvas for a page at a given DPI — what raster exports are sized to.
function pixelCanvas (wPt, hPt, dpi) {
  return {
    width: Math.max(1, Math.round((wPt / 72) * dpi)),
    height: Math.max(1, Math.round((hPt / 72) * dpi))
  }
}

// How far to upscale a render so it reaches the DPI its page size wants.
// Real-ESRGAN only does 4×, so that is the ceiling — a big banner may still
// fall short, but by far less. Below ~5% gain the wait is not worth it.
const UPSCALE_MAX = 4

function upscalePlan (srcW, srcH, wPt, hPt, fitMode = 'fill') {
  const ptPerPx = fitMode === 'fit'
    ? Math.min(wPt / srcW, hPt / srcH)
    : Math.max(wPt / srcW, hPt / srcH)
  const dpi = 72 / ptPerPx
  const { want } = dpiAdvice(wPt, hPt, dpi)
  const factor = Math.min(UPSCALE_MAX, want / dpi)
  if (factor <= 1.05) return { needed: false, dpi: Math.round(dpi), want }
  return {
    needed: true,
    factor,
    width: Math.round(srcW * factor),
    height: Math.round(srcH * factor),
    dpi: Math.round(dpi),
    reachedDpi: Math.round(dpi * factor),
    want
  }
}

module.exports = {
  stickerImageRect,
  buildHeaderProof,
  headerPreview,
  HEADER_LAYOUTS,
  HEADER_FONTS,
  stickerLayout,
  CUT_LINE_WIDTH_PT,
  upscalePlan,
  UPSCALE_MAX,
  EXPORT_FORMATS,
  COLOUR_SPACES,
  CMYK_CAPABLE,
  watermarkTiles,
  watermarkSvg,
  pixelCanvas,
  PT_PER_UNIT,
  UNITS,
  SIZE_PRESETS,
  toPoints,
  renderSizeFor,
  aspectFor,
  aspectStrain,
  ratioLabel,
  clip,
  classifyFailure,
  CODEX_TESTED,
  codexVersionCheck,
  isNewerVersion,
  generateInstruction,
  dpiAdvice,
  pngSize,
  sizeToPoints,
  drawRect,
  buildPdf,
  slugify,
  today
}
