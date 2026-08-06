'use strict'

// Headless checks on the real src/core.js. No Electron, no network, no API key.
// Run: npm run verify

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { PDFDocument } = require('pdf-lib')

const {
  toPoints, sizeToPoints, renderSizeFor, aspectFor, aspectStrain, pngSize, drawRect, buildPdf,
  slugify, today, SIZE_PRESETS, dpiAdvice, classifyFailure,
  watermarkTiles, watermarkSvg, pixelCanvas, EXPORT_FORMATS, CMYK_CAPABLE
} = require('../src/core')

const tests = []
const test = (name, fn) => tests.push({ name, fn })
const near = (actual, expected, tolerance = 0.01) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `expected ~${expected}, got ${actual}`)

// --- Units -----------------------------------------------------------------
// A shop that works in inches must get the same fidelity as one working in mm.

test('every unit converts to points', () => {
  near(toPoints(210, 'mm', 300), 595.28)
  near(toPoints(21, 'cm', 300), 595.28)
  near(toPoints(8.5, 'in', 300), 612)
  near(toPoints(1200, 'px', 300), 288)
  near(toPoints(1200, 'px', 72), 1200) // px is DPI-relative, everything else is not
})

test('unknown units fail loudly rather than silently defaulting to mm', () => {
  assert.throws(() => toPoints(10, 'furlong', 300), /Unknown unit/)
})

test('page size is correct in every unit', () => {
  const cases = [
    [{ w: 210, h: 297, unit: 'mm' }, 595.28, 841.89],
    [{ w: 8.5, h: 11, unit: 'in' }, 612, 792],
    [{ w: 10, h: 15, unit: 'cm' }, 283.46, 425.2],
    [{ w: 1200, h: 1800, unit: 'px', dpi: 300 }, 288, 432]
  ]
  for (const [size, wPt, hPt] of cases) {
    const points = sizeToPoints(size)
    near(points.wPt, wPt, 0.02)
    near(points.hPt, hPt, 0.02)
  }
})

test('landscape swaps the two numbers instead of re-rounding them', () => {
  const portrait = sizeToPoints({ w: 210, h: 297, unit: 'mm' })
  const landscape = sizeToPoints({ w: 210, h: 297, unit: 'mm', landscape: true })
  assert.equal(landscape.wPt, portrait.hPt)
  assert.equal(landscape.hPt, portrait.wPt)
})

test('a zero or negative size is refused before it reaches the API', () => {
  assert.throws(() => sizeToPoints({ w: 0, h: 297, unit: 'mm' }), /greater than zero/)
  assert.throws(() => sizeToPoints({ w: -5, h: 297, unit: 'mm' }), /greater than zero/)
})

// --- Render size -----------------------------------------------------------
// Aspect-driven so custom sizes work without anyone maintaining a lookup table.

test('render size follows the page aspect, whatever the unit', () => {
  const pick = (size) => {
    const { wPt, hPt } = sizeToPoints(size)
    return renderSizeFor(wPt, hPt)
  }
  assert.equal(pick({ w: 210, h: 297, unit: 'mm' }), '1024x1536')
  assert.equal(pick({ w: 8.5, h: 11, unit: 'in', landscape: true }), '1536x1024')
  assert.equal(pick({ w: 210, h: 210, unit: 'mm' }), '1024x1024')
  assert.equal(pick({ w: 1200, h: 1800, unit: 'px', dpi: 300 }), '1024x1536')
})

test('every preset resolves to a supported render size', () => {
  for (const preset of SIZE_PRESETS) {
    const { wPt, hPt } = sizeToPoints(preset)
    assert.ok(['1024x1024', '1024x1536', '1536x1024'].includes(renderSizeFor(wPt, hPt)), preset.id)
  }
})

// The picker opens a new optgroup every time `group` changes as it walks the
// list, so a group split across the array shows the same heading twice. This is
// the only thing keeping preset order honest as the catalogue grows.
test('preset groups stay contiguous so the picker cannot repeat a heading', () => {
  const seen = []
  let previous = null
  for (const preset of SIZE_PRESETS) {
    if (preset.group === previous) continue
    assert.ok(!seen.includes(preset.group), `${preset.group} appears in two separate runs`)
    seen.push(preset.group)
    previous = preset.group
  }
})

test('preset ids are unique, or settings restore the wrong page', () => {
  const ids = SIZE_PRESETS.map((p) => p.id)
  assert.equal(new Set(ids).size, ids.length)
})

// --- Shape strain ----------------------------------------------------------
// The model renders only 1:1, 2:3 and 3:2. A roll-up or a bumper sticker is far
// longer than any of those, so artwork is lost to cropping — the operator has to
// hear that before printing, not after.

test('a piece far longer than any render shape is flagged', () => {
  const strain = (id) => {
    const preset = SIZE_PRESETS.find((p) => p.id === id)
    const { wPt, hPt } = sizeToPoints(preset)
    return aspectStrain(wPt, hPt)
  }
  assert.ok(strain('rollup85').severe, 'an 85 × 200 cm roll-up cannot be rendered at 2:3 without loss')
  assert.ok(strain('bumper').severe, 'a 4:1 bumper sticker cannot be rendered at 3:2 without loss')
  assert.ok(!strain('a4').severe, 'A4 is close enough to 2:3 to render honestly')
  assert.ok(!strain('square').severe, 'a square page matches a square render exactly')
})

// --- Failure classification ------------------------------------------------
// Generation runs for minutes, so a wrong verdict here is expensive: retrying a
// cause that cannot change makes the operator wait twice as long for the same
// message. This is the observed Windows failure — the sandbox refused the image
// tool's save while shell writes in the same run succeeded.

test('a sandbox refusal stops the run instead of retrying into the same wall', () => {
  const verdict = classifyFailure('Unable to save: the workspace is read-only.')
  assert.equal(verdict.fatal, true)
  assert.match(verdict.message, /OneDrive/, 'the message has to name where to move the folder')
})

test('causes that cannot change on a second attempt are all fatal', () => {
  for (const raw of [
    'stream error: 401 unauthorized',
    'You are not logged in. Run codex login.',
    'rate limit exceeded, try again later',
    'I cannot create that image — it violates the content policy',
    'EACCES: permission denied, open /jobs/01.png',
    'request to api.openai.com failed, reason: ENOTFOUND'
  ]) {
    assert.equal(classifyFailure(raw).fatal, true, raw)
  }
})

test('a one-off slip is worth a second attempt', () => {
  // Codex drawing with matplotlib instead of the image model is the classic
  // deviation, and asking again usually lands on the image model.
  assert.equal(classifyFailure('I drew the poster with matplotlib and saved it').fatal, false)
  assert.equal(classifyFailure('').fatal, false, 'an unexplained failure has earned no verdict yet')
  assert.equal(classifyFailure('killed', { timedOut: true }).fatal, false)
})

test('a partly finished job says what was kept', () => {
  const { message } = classifyFailure('rate limit exceeded', { saved: 3, wanted: 4 })
  assert.match(message, /3 of 4 images was kept/)
  assert.doesNotMatch(classifyFailure('rate limit exceeded', { saved: 0, wanted: 4 }).message, /kept/)
})

test('shape strain reports how much artwork is actually lost', () => {
  const { wPt, hPt } = sizeToPoints(SIZE_PRESETS.find((p) => p.id === 'banner4x10'))
  const { lossPct, stretch } = aspectStrain(wPt, hPt)
  // 10:4 page against a 3:2 render — the page is 1.67× longer than the render.
  near(stretch, 1.667, 0.01)
  assert.equal(lossPct, 40)
})

// --- Resolution advice -----------------------------------------------------
// A bunting read from across a room and a flyer in the hand cannot share one
// threshold, or the app either cries wolf on banners or stays quiet on flyers.

test('required DPI relaxes as the printed piece gets bigger', () => {
  const at = (id) => {
    const preset = SIZE_PRESETS.find((p) => p.id === id)
    const { wPt, hPt } = sizeToPoints(preset)
    return dpiAdvice(wPt, hPt, 0)
  }
  const a5 = at('a5').warn
  const a2 = at('a2').warn
  const bunting = at('bunting2x5').warn
  const banner = at('banner4x10').warn
  assert.ok(a5 > a2, `A5 (${a5}) should demand more than A2 (${a2})`)
  assert.ok(a2 > bunting, `A2 (${a2}) should demand more than a bunting (${bunting})`)
  assert.ok(bunting >= banner, `bunting (${bunting}) should not demand less than a banner (${banner})`)
})

test('a 1536 px render is judged fine on a banner and short on a flyer', () => {
  const verdict = (id) => {
    const preset = SIZE_PRESETS.find((p) => p.id === id)
    const { wPt, hPt } = sizeToPoints(preset)
    const { pxW, pxH } = aspectFor(wPt, hPt)
    const dpi = 72 / Math.max(wPt / pxW, hPt / pxH)
    return { dpi, ...dpiAdvice(wPt, hPt, dpi) }
  }
  const a6 = verdict('a6')
  assert.ok(a6.ok, `A6 at ${a6.dpi.toFixed(0)} DPI should pass`)
  assert.ok(!a6.good, 'but 247 DPI is still under the 300 an in-hand piece wants — do not claim otherwise')
  assert.ok(!verdict('a2').ok, 'A2 from a 1536 px render is genuinely too soft')
  const banner = verdict('banner4x10')
  assert.ok(!banner.ok, `a 4×10 ft banner at ${banner.dpi.toFixed(0)} DPI must still be flagged`)
})

test('feet convert like every other unit', () => {
  near(toPoints(1, 'ft', 300), 72 * 12)
  const { wPt, hPt } = sizeToPoints({ w: 2, h: 5, unit: 'ft' })
  near(wPt, 1728)
  near(hPt, 4320)
})

// --- Codex handoff ---------------------------------------------------------
// Codex is told an orientation and a ratio in words, so those words must match
// the geometry — a portrait page described as landscape produces a wrong crop.

test('the aspect handed to Codex agrees with the page it will be printed on', () => {
  const describe = (size) => {
    const { wPt, hPt } = sizeToPoints(size)
    return aspectFor(wPt, hPt)
  }
  const a4 = describe({ w: 210, h: 297, unit: 'mm' })
  assert.equal(a4.orientation, 'portrait')
  assert.equal(a4.ratio, '2:3')
  assert.ok(a4.pxW < a4.pxH, 'portrait must not hand over landscape pixels')

  const wide = describe({ w: 11, h: 8.5, unit: 'in' })
  assert.equal(wide.orientation, 'landscape')
  assert.ok(wide.pxW > wide.pxH)

  const square = describe({ w: 210, h: 210, unit: 'mm' })
  assert.equal(square.orientation, 'square')
  assert.equal(square.ratio, '1:1')
})

test('image dimensions are read from the file, never assumed', () => {
  const real = fs.readFileSync(path.join(__dirname, '..', 'build', 'icon.png'))
  assert.deepEqual(pngSize(real), { width: 1024, height: 1024 })
  assert.equal(pngSize(Buffer.from('not a png')), null)
  assert.equal(pngSize(Buffer.alloc(0)), null)
})

// --- Placement -------------------------------------------------------------
// The point of the two modes: fit must never crop, fill must never leave white.

test('fit contains the image and touches exactly one pair of edges', () => {
  const r = drawRect(1024, 1536, 595.28, 841.89, 'fit')
  assert.ok(r.width <= 595.28 + 0.01 && r.height <= 841.89 + 0.01, 'fit must not overflow the page')
  const touchesWidth = Math.abs(r.width - 595.28) < 0.01
  const touchesHeight = Math.abs(r.height - 841.89) < 0.01
  assert.ok(touchesWidth || touchesHeight, 'fit must be as large as the page allows')
})

test('fill covers the page so no white edge is printed', () => {
  const r = drawRect(1024, 1536, 595.28, 841.89, 'fill')
  assert.ok(r.width >= 595.28 - 0.01 && r.height >= 841.89 - 0.01, 'fill must cover the page')
})

test('both modes centre the image and preserve its aspect ratio', () => {
  for (const mode of ['fit', 'fill']) {
    const r = drawRect(1024, 1536, 612, 792, mode)
    near(r.x + r.width / 2, 306, 0.01)
    near(r.y + r.height / 2, 396, 0.01)
    near(r.width / r.height, 1024 / 1536, 0.0001)
  }
})

test('fit and fill genuinely differ on a mismatched aspect', () => {
  const fit = drawRect(1024, 1536, 612, 792, 'fit')
  const fill = drawRect(1024, 1536, 612, 792, 'fill')
  assert.ok(Math.abs(fit.width - fill.width) > 1, 'the two modes produced the same placement')
})

// --- PDF -------------------------------------------------------------------

test('the written PDF really is the requested page size', async () => {
  const image = fs.readFileSync(path.join(__dirname, '..', 'build', 'icon.png'))
  const cases = [
    [{ w: 210, h: 297, unit: 'mm' }, 595.28, 841.89],
    [{ w: 8.5, h: 11, unit: 'in' }, 612, 792],
    [{ w: 10, h: 15, unit: 'cm' }, 283.46, 425.2],
    [{ w: 1200, h: 1800, unit: 'px', dpi: 300 }, 288, 432]
  ]
  for (const [size, wPt, hPt] of cases) {
    const reloaded = await PDFDocument.load(await buildPdf(image, size, 'fill'))
    assert.equal(reloaded.getPageCount(), 1)
    const page = reloaded.getPage(0).getSize()
    near(page.width, wPt, 0.02)
    near(page.height, hPt, 0.02)
  }
})

// --- Watermark -------------------------------------------------------------
// A proof mark that misses part of the page, or that a crop removes, is no mark.

test('watermark tiles cover the whole page, not just the middle', () => {
  const w = 595.28
  const h = 841.89
  const tiles = watermarkTiles(w, h, 120, 40)
  assert.ok(tiles.length > 4, `expected a tiled mark, got ${tiles.length} tile(s)`)
  assert.ok(tiles.some((t) => t.y < h / 3), 'nothing near the bottom')
  assert.ok(tiles.some((t) => t.y > (h * 2) / 3), 'nothing near the top')
  assert.ok(tiles.some((t) => t.x > w / 2), 'nothing on the right half')
})

test('watermark tile count scales with the page, and stays bounded', () => {
  const small = watermarkTiles(283, 425, 60, 20).length
  const large = watermarkTiles(841, 1190, 60, 20).length
  assert.ok(large > small, 'a bigger page should take more tiles')
  assert.ok(large < 5000, `runaway tile count: ${large}`)
})

test('watermark text is XML-escaped so it cannot break the SVG', () => {
  const svg = watermarkSvg(400, 600, 'Bob & "Sons" <Ltd>')
  assert.ok(svg.includes('&amp;') && svg.includes('&quot;') && svg.includes('&lt;'))
  assert.ok(!/<text[^>]*>[^<]*<Ltd>/.test(svg), 'raw angle brackets leaked into markup')
  assert.ok(svg.startsWith('<svg') && svg.endsWith('</svg>'))
})

// --- Export targets --------------------------------------------------------

test('raster exports are sized to the page at the chosen DPI', () => {
  const { wPt, hPt } = sizeToPoints({ w: 210, h: 297, unit: 'mm' })
  assert.deepEqual(pixelCanvas(wPt, hPt, 300), { width: 2480, height: 3508 }) // A4 @300
  assert.deepEqual(pixelCanvas(wPt, hPt, 150), { width: 1240, height: 1754 })
  const tiny = pixelCanvas(1, 1, 1)
  assert.ok(tiny.width >= 1 && tiny.height >= 1, 'must never produce a zero-pixel canvas')
})

test('CMYK is offered only where the format can actually hold it', () => {
  assert.ok(!CMYK_CAPABLE.includes('png'), 'PNG has no CMYK colour space')
  for (const format of CMYK_CAPABLE) assert.ok(EXPORT_FORMATS.includes(format))
})

test('a watermarked PDF stays one page at the requested size', async () => {
  const image = fs.readFileSync(path.join(__dirname, '..', 'build', 'icon.png'))
  const size = { w: 210, h: 297, unit: 'mm' }
  const plain = await buildPdf(image, size, 'fill')
  const marked = await buildPdf(image, size, 'fill', { text: 'PROOF' })

  const reloaded = await PDFDocument.load(marked)
  assert.equal(reloaded.getPageCount(), 1)
  near(reloaded.getPage(0).getSize().width, 595.28, 0.02)
  assert.ok(marked.length > plain.length, 'the watermark added no content')
})

// --- Naming ----------------------------------------------------------------

test('slugs stay filesystem-safe and never end up empty', () => {
  assert.equal(slugify('A red mountain, at sunrise!'), 'a-red-mountain-at-sunrise')
  assert.equal(slugify('   '), 'artwork')
  assert.equal(slugify('日本語のみ'), 'artwork')
  assert.ok(slugify('x'.repeat(200)).length <= 32)
  assert.ok(!/[/\\:]/.test(slugify('a/b\\c:d')))
})

test('date folders sort chronologically', () => {
  assert.equal(today(new Date(2026, 7, 4)), '2026-08-04')
})

// --- Runner ----------------------------------------------------------------

;(async () => {
  let failed = 0
  for (const { name, fn } of tests) {
    try {
      await fn()
      console.log(`  ok   ${name}`)
    } catch (error) {
      failed++
      console.log(`  FAIL ${name}\n       ${error.message}`)
    }
  }
  console.log(`\n${tests.length - failed}/${tests.length} passed`)
  process.exit(failed ? 1 : 0)
})()
