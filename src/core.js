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

// Presets stay in their native unit — never pre-converted to mm.
const SIZE_PRESETS = [
  { id: 'a3', group: 'ISO', label: 'A3', w: 297, h: 420, unit: 'mm' },
  { id: 'a4', group: 'ISO', label: 'A4', w: 210, h: 297, unit: 'mm' },
  { id: 'a5', group: 'ISO', label: 'A5', w: 148, h: 210, unit: 'mm' },
  { id: 'a6', group: 'ISO', label: 'A6', w: 105, h: 148, unit: 'mm' },
  { id: 'letter', group: 'US', label: 'Letter', w: 8.5, h: 11, unit: 'in' },
  { id: 'legal', group: 'US', label: 'Legal', w: 8.5, h: 14, unit: 'in' },
  { id: 'tabloid', group: 'US', label: 'Tabloid', w: 11, h: 17, unit: 'in' },
  { id: 'photo4x6', group: 'Photo', label: '4 × 6 in', w: 4, h: 6, unit: 'in' },
  { id: 'photo5x7', group: 'Photo', label: '5 × 7 in', w: 5, h: 7, unit: 'in' },
  { id: 'photo8x10', group: 'Photo', label: '8 × 10 in', w: 8, h: 10, unit: 'in' },
  { id: 'photo10x15', group: 'Photo', label: '10 × 15 cm', w: 10, h: 15, unit: 'cm' },
  { id: 'photo13x18', group: 'Photo', label: '13 × 18 cm', w: 13, h: 18, unit: 'cm' },
  { id: 'a2', group: 'Large format', label: 'A2', w: 420, h: 594, unit: 'mm' },
  { id: 'a1', group: 'Large format', label: 'A1', w: 594, h: 841, unit: 'mm' },
  { id: 'a0', group: 'Large format', label: 'A0', w: 841, h: 1189, unit: 'mm' },
  { id: 'bunting2x5', group: 'Large format', label: 'Bunting 2 × 5 ft', w: 2, h: 5, unit: 'ft' },
  { id: 'bunting3x6', group: 'Large format', label: 'Bunting 3 × 6 ft', w: 3, h: 6, unit: 'ft' },
  { id: 'banner3x8', group: 'Large format', label: 'Banner 3 × 8 ft', w: 8, h: 3, unit: 'ft' },
  { id: 'banner4x10', group: 'Large format', label: 'Banner 4 × 10 ft', w: 10, h: 4, unit: 'ft' },
  { id: 'square', group: 'Square', label: 'Square', w: 210, h: 210, unit: 'mm' }
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

// Aspect-driven, so any unit and any custom size works without a lookup table.
function renderSizeFor (wPt, hPt) {
  const ratio = wPt / hPt
  if (ratio < 0.9) return '1024x1536'
  if (ratio > 1.1) return '1536x1024'
  return '1024x1024'
}

// What the render size means in words — Codex is told a ratio, not a pixel pair.
function aspectFor (wPt, hPt) {
  const renderSize = renderSizeFor(wPt, hPt)
  const [pxW, pxH] = renderSize.split('x').map(Number)
  if (pxW === pxH) return { renderSize, pxW, pxH, orientation: 'square', ratio: '1:1' }
  return pxW < pxH
    ? { renderSize, pxW, pxH, orientation: 'portrait', ratio: '2:3' }
    : { renderSize, pxW, pxH, orientation: 'landscape', ratio: '3:2' }
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
  dpiAdvice,
  pngSize,
  sizeToPoints,
  drawRect,
  buildPdf,
  slugify,
  today
}
