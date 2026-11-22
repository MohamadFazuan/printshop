'use strict'

// Cut lines for stickers (mirrorkote, vinyl, any kiss- or die-cut stock).
//
// A cutting plotter or its RIP software reads the cut from the PDF as a thin
// stroke in a spot colour named "CutContour" — the convention Roland
// VersaWorks, Mimaki RasterLink, Summa, Graphtec Cutting Master and Flexi all
// recognise. Everything here is pure geometry with no Electron and no sharp,
// so test/verify.js can check it directly.
//
// Paths are arrays of commands in PDF points, y up, origin at the bottom-left
// of the sticker's trim box: ['M', x, y], ['L', x, y],
// ['C', x1, y1, x2, y2, x, y] and ['Z'].

const MM = 2.834645669

const CUT_KINDS = ['none', 'contour', 'rect', 'rounded', 'circle']
const CUT_LABELS = {
  none: 'None',
  contour: 'Contour (die-cut)',
  rect: 'Rectangle',
  rounded: 'Rounded rectangle',
  circle: 'Circle / oval'
}

// Artwork runs this far past a shape cut, so a blade landing slightly off
// still leaves colour at the edge instead of a white sliver.
const BLEED_PT = 2 * MM
const ROUNDED_RADIUS_PT = 3 * MM
// White border between the artwork and a contour cut.
const CONTOUR_OFFSETS_MM = [1, 2, 3]
const DEFAULT_OFFSET_MM = 2
// Sheets leave room for the cutter's registration marks, which the RIP adds.
const SHEET_MARGIN_PT = 10 * MM
const SHEET_GAP_PT = 2 * BLEED_PT

const SHEETS = {
  single: { label: 'Single sticker' },
  a4: { label: 'A4 sheet', w: 210 * MM, h: 297 * MM },
  a3: { label: 'A3 sheet', w: 297 * MM, h: 420 * MM },
  a3plus: { label: 'A3+ sheet', w: 329 * MM, h: 483 * MM }
}

// Bézier constant for a quarter circle.
const KAPPA = 0.5522847498

// ---------------------------------------------------------------------------
// Shape cuts
// ---------------------------------------------------------------------------

function roundedRectPath (x, y, w, h, r) {
  r = Math.max(0, Math.min(r, w / 2, h / 2))
  if (r === 0) return [['M', x, y], ['L', x + w, y], ['L', x + w, y + h], ['L', x, y + h], ['Z']]
  const k = r * KAPPA
  return [
    ['M', x + r, y],
    ['L', x + w - r, y],
    ['C', x + w - r + k, y, x + w, y + r - k, x + w, y + r],
    ['L', x + w, y + h - r],
    ['C', x + w, y + h - r + k, x + w - r + k, y + h, x + w - r, y + h],
    ['L', x + r, y + h],
    ['C', x + r - k, y + h, x, y + h - r + k, x, y + h - r],
    ['L', x, y + r],
    ['C', x, y + r - k, x + r - k, y, x + r, y],
    ['Z']
  ]
}

function ellipsePath (cx, cy, rx, ry) {
  const kx = rx * KAPPA
  const ky = ry * KAPPA
  return [
    ['M', cx + rx, cy],
    ['C', cx + rx, cy + ky, cx + kx, cy + ry, cx, cy + ry],
    ['C', cx - kx, cy + ry, cx - rx, cy + ky, cx - rx, cy],
    ['C', cx - rx, cy - ky, cx - kx, cy - ry, cx, cy - ry],
    ['C', cx + kx, cy - ry, cx + rx, cy - ky, cx + rx, cy],
    ['Z']
  ]
}

function shapeCutPath (kind, wPt, hPt) {
  if (kind === 'rect') return roundedRectPath(0, 0, wPt, hPt, 0)
  if (kind === 'rounded') return roundedRectPath(0, 0, wPt, hPt, ROUNDED_RADIUS_PT)
  if (kind === 'circle') return ellipsePath(wPt / 2, hPt / 2, wPt / 2, hPt / 2)
  throw new Error(`Not a shape cut: ${kind}`)
}

// ---------------------------------------------------------------------------
// Contour cuts. The artwork is drawn on plain white (the brief asks for it),
// so the subject is whatever is not white and reachable from the border.
// ---------------------------------------------------------------------------

// Background = near-white pixels connected to the image edge. White inside the
// subject (an eye, a highlight) is not reachable from the edge, so it stays
// part of the sticker instead of punching a hole in it.
function subjectMask (rgba, width, height, { threshold = 235 } = {}) {
  const n = width * height
  const light = new Uint8Array(n)
  for (let i = 0; i < n; i++) {
    const o = i * 4
    const alpha = rgba[o + 3]
    light[i] = alpha < 128 || (rgba[o] >= threshold && rgba[o + 1] >= threshold && rgba[o + 2] >= threshold) ? 1 : 0
  }
  const background = floodFromEdges(light, width, height)
  const mask = new Uint8Array(n)
  for (let i = 0; i < n; i++) mask[i] = background[i] ? 0 : 1
  return mask
}

// Marks every cell where open[i] is 1 and that connects to the border.
function floodFromEdges (open, width, height) {
  const seen = new Uint8Array(width * height)
  const stack = []
  const push = (i) => { if (open[i] && !seen[i]) { seen[i] = 1; stack.push(i) } }
  for (let x = 0; x < width; x++) { push(x); push((height - 1) * width + x) }
  for (let y = 0; y < height; y++) { push(y * width); push(y * width + width - 1) }
  while (stack.length) {
    const i = stack.pop()
    const x = i % width
    if (x > 0) push(i - 1)
    if (x < width - 1) push(i + 1)
    if (i >= width) push(i - width)
    if (i < width * (height - 1)) push(i + width)
  }
  return seen
}

// Distance from every cell to the nearest set cell, by a two-pass chamfer
// (1 for a straight step, √2 for a diagonal) — close enough to round for a
// blade, and linear time.
function distanceField (mask, W, H) {
  const dist = new Float32Array(W * H)
  for (let i = 0; i < dist.length; i++) dist[i] = mask[i] ? 0 : 1e9
  const d2 = Math.SQRT2
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x
      let d = dist[i]
      if (x > 0) d = Math.min(d, dist[i - 1] + 1)
      if (y > 0) {
        d = Math.min(d, dist[i - W] + 1)
        if (x > 0) d = Math.min(d, dist[i - W - 1] + d2)
        if (x < W - 1) d = Math.min(d, dist[i - W + 1] + d2)
      }
      dist[i] = d
    }
  }
  for (let y = H - 1; y >= 0; y--) {
    for (let x = W - 1; x >= 0; x--) {
      const i = y * W + x
      let d = dist[i]
      if (x < W - 1) d = Math.min(d, dist[i + 1] + 1)
      if (y < H - 1) {
        d = Math.min(d, dist[i + W] + 1)
        if (x < W - 1) d = Math.min(d, dist[i + W + 1] + d2)
        if (x > 0) d = Math.min(d, dist[i + W - 1] + d2)
      }
      dist[i] = d
    }
  }
  return dist
}

// Growing a C into an O encloses a pocket of background; fill it, or the
// trace would cut a hole there.
function fillHoles (mask, W, H) {
  const empty = new Uint8Array(W * H)
  for (let i = 0; i < mask.length; i++) empty[i] = mask[i] ? 0 : 1
  const outside = floodFromEdges(empty, W, H)
  for (let i = 0; i < mask.length; i++) if (!outside[i]) mask[i] = 1
  return mask
}

// Grows the mask by `radius` pixels onto a canvas padded so the border may run
// past the image. It first grows further and shrinks back (a morphological
// close), so the notches between letters and close-set parts bridge over into
// one smooth outline, the way a sticker border is drawn by hand.
function dilate (mask, width, height, radius, closeBy = radius * 0.75) {
  const pad = Math.ceil(radius + closeBy) + 2
  const W = width + pad * 2
  const H = height + pad * 2
  const src = new Uint8Array(W * H)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (mask[y * width + x]) src[(y + pad) * W + x + pad] = 1
    }
  }

  const grow = distanceField(src, W, H)
  const grown = new Uint8Array(W * H)
  for (let i = 0; i < grown.length; i++) grown[i] = grow[i] <= radius + closeBy ? 1 : 0
  fillHoles(grown, W, H)

  let out = grown
  if (closeBy > 0) {
    const inverse = new Uint8Array(W * H)
    for (let i = 0; i < grown.length; i++) inverse[i] = grown[i] ? 0 : 1
    const shrink = distanceField(inverse, W, H)
    out = new Uint8Array(W * H)
    for (let i = 0; i < out.length; i++) out[i] = shrink[i] > closeBy ? 1 : 0
    fillHoles(out, W, H)
  }
  return { mask: out, width: W, height: H, pad }
}

// Walks the pixel-edge boundary of every filled region. Each boundary edge is
// directed with the filled pixel on its left, so edges chain into closed
// loops. Returns loops of [x, y] pixel-corner coordinates (y down).
function traceLoops (mask, width, height) {
  const at = (x, y) => (x >= 0 && y >= 0 && x < width && y < height ? mask[y * width + x] : 0)
  const key = (x, y) => y * (width + 1) + x
  const out = new Map()
  const add = (x1, y1, x2, y2) => {
    const k = key(x1, y1)
    const list = out.get(k)
    if (list) list.push([x2, y2]); else out.set(k, [[x2, y2]])
  }
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!at(x, y)) continue
      if (!at(x, y - 1)) add(x + 1, y, x, y)
      if (!at(x - 1, y)) add(x, y, x, y + 1)
      if (!at(x, y + 1)) add(x, y + 1, x + 1, y + 1)
      if (!at(x + 1, y)) add(x + 1, y + 1, x + 1, y)
    }
  }

  const loops = []
  for (const [startKey, firstList] of out) {
    while (firstList.length) {
      const sx = startKey % (width + 1)
      const sy = Math.floor(startKey / (width + 1))
      const loop = [[sx, sy]]
      let [cx, cy] = firstList.pop()
      let px = sx
      let py = sy
      let guard = 0
      while (!(cx === sx && cy === sy) && guard++ < 1e7) {
        loop.push([cx, cy])
        const list = out.get(key(cx, cy))
        if (!list || !list.length) break
        // Two ways out only where regions touch at a corner; turning the same
        // way every time keeps each region's loop separate.
        let pick = list.length - 1
        if (list.length > 1) {
          const dx = cx - px
          const dy = cy - py
          pick = list.findIndex(([nx, ny]) => ((nx - cx) * dy - (ny - cy) * dx) < 0)
          if (pick < 0) pick = list.length - 1
        }
        const [nx, ny] = list.splice(pick, 1)[0]
        px = cx; py = cy; cx = nx; cy = ny
      }
      if (loop.length >= 4) loops.push(loop)
    }
  }
  return loops
}

function polygonArea (pts) {
  let s = 0
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    s += (pts[j][0] + pts[i][0]) * (pts[j][1] - pts[i][1])
  }
  return s / 2
}

// Rounds off the pixel staircase. Two passes are enough for a blade.
function chaikin (pts, passes = 2) {
  let cur = pts
  for (let p = 0; p < passes; p++) {
    const next = []
    for (let i = 0; i < cur.length; i++) {
      const [ax, ay] = cur[i]
      const [bx, by] = cur[(i + 1) % cur.length]
      next.push([0.75 * ax + 0.25 * bx, 0.75 * ay + 0.25 * by], [0.25 * ax + 0.75 * bx, 0.25 * ay + 0.75 * by])
    }
    cur = next
  }
  return cur
}

// Ramer–Douglas–Peucker on a closed loop, iterative so a long outline cannot
// overflow the stack.
function simplify (pts, tolerance) {
  if (pts.length < 8) return pts
  // Split the loop at its two farthest-apart points so each half is an open run.
  let far = 0
  let best = -1
  for (let i = 1; i < pts.length; i++) {
    const d = (pts[i][0] - pts[0][0]) ** 2 + (pts[i][1] - pts[0][1]) ** 2
    if (d > best) { best = d; far = i }
  }
  const keep = new Uint8Array(pts.length)
  keep[0] = 1; keep[far] = 1
  const runs = [[0, far], [far, pts.length]]
  const tol2 = tolerance * tolerance
  while (runs.length) {
    const [s, e] = runs.pop()
    const [ax, ay] = pts[s]
    const [bx, by] = pts[e % pts.length]
    const dx = bx - ax
    const dy = by - ay
    const len2 = dx * dx + dy * dy || 1e-12
    let idx = -1
    let max = tol2
    for (let i = s + 1; i < e; i++) {
      const [x, y] = pts[i]
      const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / len2))
      const d = (x - ax - t * dx) ** 2 + (y - ay - t * dy) ** 2
      if (d > max) { max = d; idx = i }
    }
    if (idx >= 0) { keep[idx] = 1; runs.push([s, idx], [idx, e]) }
  }
  return pts.filter((_, i) => keep[i])
}

// Shrinks the image's placement about the sticker centre until the artwork
// plus its border fits inside the trim. Models often draw right to the edge
// even when asked not to; without this the cut would be clamped onto the trim
// and the border would vanish on that side.
function fitContourRect ({ mask, width, height }, rect, offsetPt, trim) {
  let minX = width, minY = height, maxX = -1, maxY = -1
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!mask[y * width + x]) continue
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }
  }
  if (maxX < 0) return { rect, scale: 1 }
  const k = rect.width / width
  // Subject box in points, y up.
  const left = rect.x + minX * k
  const right = rect.x + (maxX + 1) * k
  const top = rect.y + rect.height - minY * k
  const bottom = rect.y + rect.height - (maxY + 1) * k
  const cx = trim.w / 2
  const cy = trim.h / 2
  const limits = [1]
  if (left < cx) limits.push((cx - offsetPt) / (cx - left))
  if (right > cx) limits.push((trim.w - offsetPt - cx) / (right - cx))
  if (bottom < cy) limits.push((cy - offsetPt) / (cy - bottom))
  if (top > cy) limits.push((trim.h - offsetPt - cy) / (top - cy))
  const scale = Math.max(0.05, Math.min(...limits))
  if (scale >= 0.999) return { rect, scale: 1 }
  return {
    scale,
    rect: {
      x: cx + (rect.x - cx) * scale,
      y: cy + (rect.y - cy) * scale,
      width: rect.width * scale,
      height: rect.height * scale
    }
  }
}

// mask: subject pixels of the image as traced (at any resolution).
// rect: where the image sits on the sticker, in points, relative to the trim
// box (drawRect output shifted for bleed). Returns the cut path, the number of
// separate pieces, and how many tiny specks were ignored.
function contourCutPath ({ mask, width, height }, rect, offsetPt, trim) {
  const ptPerPx = rect.width / width
  const radius = offsetPt / ptPerPx
  const grown = dilate(mask, width, height, radius)
  const loops = traceLoops(grown.mask, grown.width, grown.height)
  if (!loops.length) throw new Error('No artwork found to cut around — the image looks blank or entirely white.')

  const areas = loops.map((l) => Math.abs(polygonArea(l)))
  const biggest = Math.max(...areas)
  // Specks of noise become their own tiny stickers otherwise.
  const kept = loops.filter((_, i) => areas[i] >= biggest * 0.02)

  const path = []
  for (const loop of kept) {
    // Straighten the pixel staircase first, then round the corners that
    // leaves: a blade follows a smooth curve better than a jagged one.
    const smooth = simplify(chaikin(simplify(loop, 1.2), 3), 0.25)
    smooth.forEach(([px, py], i) => {
      let x = rect.x + (px - grown.pad) * ptPerPx
      let y = rect.y + rect.height - (py - grown.pad) * ptPerPx
      // Never cut past the sticker's own edge, even where the artwork bleeds.
      if (trim) {
        x = Math.max(0, Math.min(trim.w, x))
        y = Math.max(0, Math.min(trim.h, y))
      }
      path.push([i === 0 ? 'M' : 'L', round3(x), round3(y)])
    })
    path.push(['Z'])
  }
  return { path, pieces: kept.length, ignored: loops.length - kept.length }
}

const round3 = (n) => Math.round(n * 1000) / 1000

// ---------------------------------------------------------------------------
// Sheets
// ---------------------------------------------------------------------------

// Tiles copies of a sticker (its bleed box, cellW × cellH) on a sheet. Tries
// the sheet both ways up and keeps whichever holds more.
// Registration marks for the shop's Teneth CutterPro cutter, drawn exactly as
// its CorelDRAW plugin (ThAddFourLMark2) draws them: filled 1 mm bars, an L at
// each bottom corner and a bar with an inward 5 mm tick on each side higher up.
// The inset is each mark's outer edge, arms MARK_LENGTH long overall.
const MARK_LENGTH_PT = 20 * MM
const MARK_TICK_PT = 5 * MM
const MARK_INSET_PT = 10 * MM
const MARK_WIDTH_PT = 1 * MM
const MARK_CLEAR_PT = 5 * MM
// The plugin puts the top of the upper bars at 280 - 50 - inset mm from the
// bottom edge, whatever the paper height (its m_gap is fixed at 280).
const MARK_TOP_BASE_PT = 230 * MM
const HEADER_HEIGHT_PT = 15 * MM
const HEADER_GAP_PT = 4 * MM
const HEADER_HEIGHT_MIN_MM = 10
const HEADER_HEIGHT_MAX_MM = 30

function clampHeaderHeight (heightPt) {
  const mm = Number(heightPt) / MM
  if (!Number.isFinite(mm) || !mm) return HEADER_HEIGHT_PT
  return Math.min(HEADER_HEIGHT_MAX_MM, Math.max(HEADER_HEIGHT_MIN_MM, mm)) * MM
}

const MARK_INSET_MIN_MM = 3
const MARK_INSET_MAX_MM = 40
const LAYOUT_PATTERNS = ['grid', 'staggered']

function clampInset (insetPt) {
  const mm = Number(insetPt) / MM
  if (!Number.isFinite(mm)) return MARK_INSET_PT
  return Math.min(MARK_INSET_MAX_MM, Math.max(MARK_INSET_MIN_MM, mm)) * MM
}

// Filled rectangles { x, y, w, h } in points, y up, origin at the sheet's
// bottom-left corner. Same coordinates as the plugin, so the cutter software
// finds them where it expects.
function sheetMarks (pageW, pageH, insetPt = MARK_INSET_PT) {
  const i = clampInset(insetPt)
  const len = MARK_LENGTH_PT
  const wd = MARK_WIDTH_PT
  const t = MARK_TICK_PT
  const top = MARK_TOP_BASE_PT - i
  const r = (x, y, w, h) => ({ x, y, w, h })
  return [
    // Bottom-left L.
    r(i, i, wd, len), r(i, i, len, wd),
    // Bottom-right L.
    r(pageW - i - wd, i, wd, len), r(pageW - i - len, i, len, wd),
    // Left bar, tick pointing in; the tick's lower edge is the bar's midpoint.
    r(i, top - len, wd, len), r(i, top - len / 2, t, wd),
    // Right bar, mirrored.
    r(pageW - i - wd, top - len, wd, len), r(pageW - i - t, top - len / 2, t, wd)
  ]
}

// Space each edge keeps free of stickers, so the sensor sees clean paper
// around every mark and the header never overlaps the art.
// The marks move with insetPt, and the stickers move with them: a mark further
// from the edge leaves less room on the sheet.
function sheetMargins ({ marks = false, header = false, insetPt = MARK_INSET_PT, headerHeightPt = HEADER_HEIGHT_PT } = {}) {
  const m = { top: SHEET_MARGIN_PT, right: SHEET_MARGIN_PT, bottom: SHEET_MARGIN_PT, left: SHEET_MARGIN_PT }
  if (marks) {
    const inset = clampInset(insetPt)
    const side = inset + MARK_TICK_PT + MARK_CLEAR_PT
    m.left = side
    m.right = side
    m.bottom = inset + MARK_WIDTH_PT + MARK_CLEAR_PT
  }
  if (header) m.top = SHEET_MARGIN_PT + clampHeaderHeight(headerHeightPt) + HEADER_GAP_PT
  return m
}

// The header strip sits inside the top margin, aligned with the side margins.
function headerBox (pageW, pageH, margins, heightPt = HEADER_HEIGHT_PT) {
  const h = clampHeaderHeight(heightPt)
  return { x: margins.left, y: pageH - SHEET_MARGIN_PT - h, w: pageW - margins.left - margins.right, h }
}

// Staggered (honeycomb) packing for round stickers: every other row shifts by
// half a pitch and the rows close up to sqrt(3)/2 of it, so the gap between
// neighbouring circles stays the same as on the grid. An oval is a stretched
// circle, so the same packing is stretched with it.
function staggeredFit (pageW, pageH, cellW, cellH, m, gap) {
  const availW = pageW - m.left - m.right
  const availH = pageH - m.top - m.bottom
  if (availW < cellW || availH < cellH) return null
  const px = cellW + gap
  const py = (cellH + gap * cellH / cellW) * Math.sqrt(3) / 2
  const rows = 1 + Math.floor((availH - cellH) / py + 1e-9)
  const full = 1 + Math.floor((availW - cellW) / px + 1e-9)
  const shifted = availW - cellW - px / 2 >= -1e-9 ? 1 + Math.floor((availW - cellW - px / 2) / px + 1e-9) : 0

  let best = null
  // Try the shifted row first and second; with an odd row count one wins.
  for (const phase of [0, 1]) {
    const perRow = Array.from({ length: rows }, (_, r) => ((r + phase) % 2 ? shifted : full))
    const count = perRow.reduce((a, n) => a + n, 0)
    if (!best || count > best.count) best = { perRow, phase, count }
  }
  if (!best.count) return null

  const rowW = (r) => (best.perRow[r] ? (best.perRow[r] - 1) * px + cellW + ((r + best.phase) % 2 ? px / 2 : 0) : 0)
  const usedW = Math.max(...best.perRow.map((_, r) => rowW(r)))
  const usedH = (rows - 1) * py + cellH
  const x0 = m.left + (availW - usedW) / 2
  const top = pageH - m.top - (availH - usedH) / 2
  const cells = []
  for (let r = 0; r < rows; r++) {
    const dx = (r + best.phase) % 2 ? px / 2 : 0
    for (let c = 0; c < best.perRow[r]; c++) cells.push({ x: x0 + dx + c * px, y: top - cellH - r * py })
  }
  return { pageW, pageH, cols: full, rows, count: best.count, cells }
}

function sheetLayout (cellW, cellH, sheetKey, { margin = SHEET_MARGIN_PT, margins = null, gap = SHEET_GAP_PT, pattern = 'grid' } = {}) {
  const sheet = SHEETS[sheetKey]
  if (!sheet || !sheet.w) throw new Error(`Unknown sheet: ${sheetKey}`)
  const m = margins || { top: margin, right: margin, bottom: margin, left: margin }

  if (pattern === 'staggered') {
    const fits = [staggeredFit(sheet.w, sheet.h, cellW, cellH, m, gap), staggeredFit(sheet.h, sheet.w, cellW, cellH, m, gap)].filter(Boolean)
    if (!fits.length) throw new Error(`This sticker is too big for ${sheet.label.replace(' sheet', '')} once the margins take their space. Pick a bigger sheet or a single sticker.`)
    const pick = fits.reduce((a, b) => (b.count > a.count ? b : a))
    return { ...pick, margins: m, pattern }
  }

  const fit = (pageW, pageH) => {
    const cols = Math.floor((pageW - m.left - m.right + gap) / (cellW + gap))
    const rows = Math.floor((pageH - m.top - m.bottom + gap) / (cellH + gap))
    return { pageW, pageH, cols: Math.max(0, cols), rows: Math.max(0, rows) }
  }
  const portrait = fit(sheet.w, sheet.h)
  const landscape = fit(sheet.h, sheet.w)
  const pick = landscape.cols * landscape.rows > portrait.cols * portrait.rows ? landscape : portrait
  const count = pick.cols * pick.rows
  if (!count) {
    const extra = margins ? ' once the cutting marks and header take their space' : ` with ${Math.round(margin / MM)} mm margins`
    throw new Error(`This sticker is too big for ${sheet.label.replace(' sheet', '')}${extra}. Pick a bigger sheet or a single sticker.`)
  }

  const usedW = pick.cols * cellW + (pick.cols - 1) * gap
  const usedH = pick.rows * cellH + (pick.rows - 1) * gap
  // Centre the grid in the area the margins leave free.
  const x0 = m.left + (pick.pageW - m.left - m.right - usedW) / 2
  const y0 = m.bottom + (pick.pageH - m.top - m.bottom - usedH) / 2
  const cells = []
  for (let r = 0; r < pick.rows; r++) {
    for (let c = 0; c < pick.cols; c++) {
      // Top row first, as a person reads the sheet.
      cells.push({ x: x0 + c * (cellW + gap), y: y0 + usedH - cellH - r * (cellH + gap) })
    }
  }
  return { pageW: pick.pageW, pageH: pick.pageH, cols: pick.cols, rows: pick.rows, count, cells, margins: m, pattern: 'grid' }
}

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------

function translatePath (path, dx, dy) {
  return path.map((cmd) => {
    if (cmd[0] === 'Z') return cmd
    const out = [cmd[0]]
    for (let i = 1; i < cmd.length; i += 2) out.push(cmd[i] + dx, cmd[i + 1] + dy)
    return out
  })
}

// SVG path data for the on-screen preview: SVG is y down, so flip against the
// height of the box the path lives in.
function pathToSvg (path, boxH) {
  return path.map((cmd) => {
    if (cmd[0] === 'Z') return 'Z'
    const nums = []
    for (let i = 1; i < cmd.length; i += 2) nums.push(cmd[i].toFixed(2), (boxH - cmd[i + 1]).toFixed(2))
    return `${cmd[0]}${nums.join(' ')}`
  }).join('')
}

// What the brief tells Codex, so the artwork suits the cut.
function cutBrief (kind) {
  if (kind === 'contour') {
    return [
      'This is a die-cut sticker: the printer cuts around the outline of the artwork.',
      'Draw ONE bold, self-contained sticker design isolated on a plain, flat, pure white (#FFFFFF) background — no scenery, no gradient, no drop shadow, no frame, no border.',
      'Give the design a clean, solid outline so its edge is crisp, keep separate parts close together, and leave a clear white margin of about 8% on every side. Nothing may touch the edges of the image.'
    ]
  }
  if (kind === 'circle') {
    return [
      'This is a round sticker cut to a circle (an oval if the frame is not square).',
      'Fill the whole frame edge to edge with the background colour or pattern, since the corners are trimmed away. Keep all text, faces and important detail inside the central circle, well clear of its edge.'
    ]
  }
  if (kind === 'rect' || kind === 'rounded') {
    return [
      `This is a ${kind === 'rounded' ? 'rounded-corner ' : ''}rectangular sticker.`,
      'Fill the whole frame edge to edge with the background — it is trimmed at the edge. Keep text and important detail about 5% inside every edge.'
    ]
  }
  return []
}

module.exports = {
  MM,
  CUT_KINDS,
  CUT_LABELS,
  BLEED_PT,
  ROUNDED_RADIUS_PT,
  CONTOUR_OFFSETS_MM,
  DEFAULT_OFFSET_MM,
  SHEETS,
  SHEET_MARGIN_PT,
  MARK_LENGTH_PT,
  MARK_TICK_PT,
  MARK_INSET_PT,
  MARK_WIDTH_PT,
  MARK_CLEAR_PT,
  MARK_TOP_BASE_PT,
  HEADER_HEIGHT_PT,
  sheetMarks,
  clampInset,
  clampHeaderHeight,
  HEADER_HEIGHT_MIN_MM,
  HEADER_HEIGHT_MAX_MM,
  MARK_INSET_MIN_MM,
  MARK_INSET_MAX_MM,
  LAYOUT_PATTERNS,
  sheetMargins,
  headerBox,
  SHEET_GAP_PT,
  shapeCutPath,
  roundedRectPath,
  ellipsePath,
  subjectMask,
  floodFromEdges,
  distanceField,
  fillHoles,
  dilate,
  traceLoops,
  polygonArea,
  chaikin,
  simplify,
  contourCutPath,
  fitContourRect,
  sheetLayout,
  translatePath,
  pathToSvg,
  cutBrief
}
