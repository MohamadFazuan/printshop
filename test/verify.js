'use strict'

// Headless checks on the real src/core.js. No Electron, no network, no API key.
// Run: npm run verify

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { PDFDocument } = require('pdf-lib')

const {
  toPoints, sizeToPoints, renderSizeFor, aspectFor, aspectStrain, ratioLabel, pngSize, drawRect, buildPdf,
  slugify, today, SIZE_PRESETS, dpiAdvice, classifyFailure, generateInstruction,
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

// The image tool has no size argument, so the brief asks for the page's own
// proportions. Rounding every job to one of three shapes is what used to tell a
// 10 × 2 ft banner operator the piece could not be rendered at all.
test('the render size carries the page aspect, whatever the unit', () => {
  const ratioOf = (size) => {
    const { wPt, hPt } = sizeToPoints(size)
    const [w, h] = renderSizeFor(wPt, hPt).split('x').map(Number)
    return { asked: w / h, page: wPt / hPt }
  }
  for (const size of [
    { w: 210, h: 297, unit: 'mm' },
    { w: 8.5, h: 11, unit: 'in', landscape: true },
    { w: 210, h: 210, unit: 'mm' },
    { w: 1200, h: 1800, unit: 'px', dpi: 300 },
    { w: 10, h: 2, unit: 'ft' }
  ]) {
    const { asked, page } = ratioOf(size)
    near(asked, page, page * 0.01)
  }
})

test('every preset asks for its own shape, including the long ones', () => {
  for (const preset of SIZE_PRESETS) {
    const { wPt, hPt } = sizeToPoints(preset)
    const [w, h] = renderSizeFor(wPt, hPt).split('x').map(Number)
    assert.ok(w > 0 && h > 0, preset.id)
    near(w / h, wPt / hPt, (wPt / hPt) * 0.01)
  }
})

test('a ratio reads as whole numbers where the page really is one', () => {
  assert.equal(ratioLabel(5), '5:1')
  assert.equal(ratioLabel(4), '4:1')
  assert.equal(ratioLabel(1.5), '3:2')
  assert.equal(ratioLabel(1), '1:1')
  // A4 is √2, and calling that "2:3" was a rounding the brief passed on to Codex.
  assert.equal(ratioLabel(210 / 297), '1:1.41')
})

test('a very thin page never reads as "0:1" in the brief', () => {
  // Rounding a ratio under 1:50 to a whole numerator gives 0, and "Aspect
  // ratio 0:1" is the one label Codex cannot act on.
  for (const ratio of [1 / 60, 1 / 200, 0.0199, 0.001]) {
    const label = ratioLabel(ratio)
    assert.ok(!label.startsWith('0:'), `${ratio} produced ${label}`)
    assert.match(label, /^1:\d/)
  }
  assert.equal(ratioLabel(1 / 60), '1:60.00')
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
// Asking for the page's shape is not the same as getting it — a 5:1 brief came
// back 2.5:1 in testing. So strain is measured against the image that actually
// landed, and says what fill will crop or fit will leave white. Judging it from
// the page alone is what produced a warning for shapes the model renders fine.

test('an image that matches the page costs nothing', () => {
  const { wPt, hPt } = sizeToPoints({ w: 10, h: 2, unit: 'ft' })
  assert.ok(!aspectStrain(wPt, hPt, 2804, 561).severe, 'a 5:1 image on a 5:1 page is exact')
})

test('an image the model shaped differently is flagged with what it costs', () => {
  const { wPt, hPt } = sizeToPoints({ w: 10, h: 2, unit: 'ft' })
  // The measured miss: a 5:1 brief came back 1983 × 793.
  const strain = aspectStrain(wPt, hPt, 1983, 793)
  assert.equal(strain.severe, true)
  assert.equal(strain.lossPct, 50, 'half a 5:1 page is lost to a 2.5:1 image')
})

test('strain refuses to judge without an image rather than clearing it', () => {
  const { wPt, hPt } = sizeToPoints({ w: 10, h: 2, unit: 'ft' })
  // The trap: NaN >= 1.3 is false, so a caller that forgot the image used to
  // get a confident "nothing wrong here" on a page the model may have missed.
  assert.equal(aspectStrain(wPt, hPt), null)
  assert.equal(aspectStrain(wPt, hPt, 0, 0), null)
  assert.equal(aspectStrain(wPt, hPt, 2804, undefined), null)
})

test('a small difference is not worth a banner', () => {
  const { wPt, hPt } = sizeToPoints({ w: 210, h: 297, unit: 'mm' })
  assert.ok(!aspectStrain(wPt, hPt, 1055, 1491).severe, 'the shape that was asked for')
  assert.ok(!aspectStrain(wPt, hPt, 1024, 1536).severe, 'close enough not to nag')
})

// --- The brief Codex is given ----------------------------------------------
// The instruction is the whole contract with the agent. Every line here exists
// because its absence cost a job: artwork drawn in matplotlib, a stray file in
// the folder counted as a variant, a reference image copied in beside the real
// output.

const A4 = aspectFor(595.28, 841.89)

test('without a reference the brief says nothing about one', () => {
  const brief = generateInstruction('a red mountain', A4, ['01.png', '02.png'])
  assert.match(brief, /Generate 2 DIFFERENT images/)
  assert.match(brief, /Subject: a red mountain/)
  assert.ok(!/reference/i.test(brief), 'a reference must not be implied when none was attached')
})

test('an attached reference is described, bounded, and kept out of the folder', () => {
  const brief = generateInstruction('a red mountain', A4, ['01.png'], true)
  assert.match(brief, /reference image is attached/i)
  // Without this the agent follows the reference's shape and the page crops.
  assert.match(brief, /aspect ratio above still win/i)
  // Every .png in the job folder is counted as a finished variant, so a copied
  // reference would be handed back to the operator as generated artwork.
  assert.match(brief, /Do not save, copy or reproduce the reference/i)
})

test('the brief forbids distorting content to fill the frame', () => {
  const { wPt, hPt } = sizeToPoints({ w: 10, h: 2, unit: 'ft' })
  const brief = generateInstruction('a menu banner', aspectFor(wPt, hPt), ['01.png'])
  // Told only the shape, the model stretched a 5:1 banner to fit: the QR code
  // came back 136 × 61 px — an oval — and the type twice its natural width.
  // These two lines are what made a measured circle land at 411 × 414.
  assert.match(brief, /circles perfectly circular/i)
  assert.match(brief, /Do NOT stretch, squash or distort/i)
  // Every page gets them; distortion is never wanted on something being printed.
  assert.match(generateInstruction('x', aspectFor(595.28, 841.89), ['01.png']), /circles perfectly circular/i)
})

test('the aspect ratio is stated whether or not a reference is attached', () => {
  for (const withRef of [false, true]) {
    assert.match(generateInstruction('x', A4, ['01.png'], withRef), /Aspect ratio 1:1\.41/)
  }
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
  // A 4 × 10 ft page is 2.5:1 and the brief asks for that. If Codex answers 3:2
  // anyway, the page is 1.67× longer than the image it has to be filled with.
  const { lossPct, stretch } = aspectStrain(wPt, hPt, 1536, 1024)
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
  assert.equal(a4.ratio, '1:1.41', 'A4 is √2 — calling it 2:3 asked Codex for a shape the page is not')
  assert.ok(a4.pxW < a4.pxH, 'portrait must not hand over landscape pixels')

  // The case that started this: a 10 × 2 ft banner is a shape the model will
  // compose for, so the brief has to name it rather than round it to 3:2.
  const banner = describe({ w: 10, h: 2, unit: 'ft' })
  assert.equal(banner.orientation, 'landscape')
  assert.equal(banner.ratio, '5:1')
  near(banner.pxW / banner.pxH, 5, 0.05)

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
