'use strict'

// Everything here is pure and Electron-free so it can be exercised headlessly
// by test/verify.js. Anything privileged (fs, net, keys, IPC) lives in main.js.

const { PDFDocument, StandardFonts, degrees, rgb, cmyk } = require('pdf-lib')

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
  { id: 'stickerround60', group: 'Stickers & labels', label: 'Round sticker ⌀ 60 mm', w: 60, h: 60, unit: 'mm' },
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
function generateInstruction (prompt, aspect, names, hasReference = false) {
  const many = names.length > 1
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
    // The attachment arrives through `codex exec -i`, so the agent sees it but
    // has no copy on disk — and must not make one, because every .png in the
    // job folder is counted as a finished variant.
    ...(hasReference
      ? [
          'A reference image is attached to this message. Take subject, style, colour and composition from it.',
          'The orientation and aspect ratio above still win, even where the reference disagrees.',
          'Do not save, copy or reproduce the reference file itself into the folder.'
        ]
      : []),
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
function classifyFailure (raw, { saved = 0, wanted = 0, timedOut = false } = {}) {
  const text = String(raw || '').toLowerCase()
  const partly = saved > 0 ? ` ${saved} of ${wanted} image${saved === 1 ? '' : 's'} was kept.` : ''

  if (timedOut) {
    return { fatal: false, message: `Codex ran out of time and was stopped.${partly} Generating fewer images at once is the reliable fix — each one is a separate round trip to OpenAI.` }
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

async function buildPdf (imageBytes, size, fitMode, watermark = null, colour = 'rgb') {
  const { wPt, hPt } = sizeToPoints(size)

  const pdf = await PDFDocument.create()
  const isPng = imageBytes[0] === 0x89 && imageBytes[1] === 0x50
  const image = isPng ? await pdf.embedPng(imageBytes) : await pdf.embedJpg(imageBytes)
  const page = pdf.addPage([wPt, hPt])

  page.drawImage(image, drawRect(image.width, image.height, wPt, hPt, fitMode))

  if (watermark && watermark.text) {
    const font = await pdf.embedFont(StandardFonts.HelveticaBold)
    const fontSize = Math.max(10, Math.min(wPt, hPt) / 16)
    const textWidth = font.widthOfTextAtSize(watermark.text, fontSize)
    // Keep the mark in the page's own colour space so the RIP has nothing to convert.
    const ink = colour === 'cmyk' ? cmyk(0, 0, 0, 0.5) : rgb(0.5, 0.5, 0.5)

    for (const { x, y } of watermarkTiles(wPt, hPt, textWidth, fontSize)) {
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

module.exports = {
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
  generateInstruction,
  dpiAdvice,
  pngSize,
  sizeToPoints,
  drawRect,
  buildPdf,
  slugify,
  today
}
