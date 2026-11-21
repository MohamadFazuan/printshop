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
  watermarkTiles, watermarkSvg, pixelCanvas, EXPORT_FORMATS, CMYK_CAPABLE,
  upscalePlan, stickerLayout, stickerImageRect
} = require('../src/core')
const cutline = require('../src/cutline')
const { PDFName, PDFDict } = require('pdf-lib')

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

test('several references are counted, combined, and all kept out of the folder', () => {
  const brief = generateInstruction('a red mountain', A4, ['01.png'], 3)
  assert.match(brief, /3 reference images are attached/i)
  assert.match(brief, /Combine them/i)
  assert.match(brief, /aspect ratio above still win/i)
  assert.match(brief, /Do not save, copy or reproduce the reference files/i)
  // A count of one reads exactly like the single-reference brief.
  assert.equal(generateInstruction('x', A4, ['01.png'], 1), generateInstruction('x', A4, ['01.png'], true))
  assert.ok(!/reference/i.test(generateInstruction('x', A4, ['01.png'], 0)))
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

// --- Upscaling ----------------------------------------------------------------
// Real-ESRGAN takes ~90 s an image, so the plan decides whether to pay that at
// all, and how far: to the DPI the page wants, never past the model's 4×.

test('an A4 render is upscaled just far enough to reach 300 DPI', () => {
  const { wPt, hPt } = sizeToPoints({ w: 210, h: 297, unit: 'mm' })
  const plan = upscalePlan(1055, 1491, wPt, hPt)
  assert.equal(plan.needed, true)
  assert.equal(plan.dpi, 128)
  assert.equal(plan.reachedDpi, 300)
  assert.equal(plan.height, 3508)
})

test('a banner is capped at 4× even when that falls short', () => {
  const { wPt, hPt } = sizeToPoints({ w: 10, h: 2, unit: 'ft' })
  const plan = upscalePlan(2500, 500, wPt, hPt)
  assert.equal(plan.factor, 4)
  assert.deepEqual([plan.width, plan.height], [10000, 2000])
  assert.ok(plan.reachedDpi < plan.want)
})

test('an image that already meets the page is left alone', () => {
  const { wPt, hPt } = sizeToPoints({ w: 210, h: 297, unit: 'mm' })
  assert.equal(upscalePlan(4000, 5600, wPt, hPt).needed, false)
  // Within 5% is not worth a 90-second wait.
  assert.equal(upscalePlan(2420, 3420, wPt, hPt).needed, false)
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


// --- Cut lines -------------------------------------------------------------
// A cutter keys on the spot colour's name, so the name, the geometry and the
// sheet maths are what a print shop would check before trusting a file.

// RGBA canvas: white, with filled discs drawn in black.
function canvasWithDiscs (w, h, discs) {
  const rgba = new Uint8Array(w * h * 4).fill(255)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (discs.some(([cx, cy, r]) => (x - cx) ** 2 + (y - cy) ** 2 <= r * r)) {
        const o = (y * w + x) * 4
        rgba[o] = rgba[o + 1] = rgba[o + 2] = 0
      }
    }
  }
  return rgba
}

test('a contour cut sits the chosen border outside the artwork', () => {
  const w = 200
  const rgba = canvasWithDiscs(w, w, [[100, 100, 50]])
  const mask = cutline.subjectMask(rgba, w, w)
  // 200 px across 100 pt: 0.5 pt per px; a 2 mm border is ~11.3 px.
  const rect = { x: 0, y: 0, width: 100, height: 100 }
  const offset = 2 * cutline.MM
  const { path, pieces } = cutline.contourCutPath({ mask, width: w, height: w }, rect, offset)
  assert.equal(pieces, 1)
  const radii = path.filter((c) => c[0] !== 'Z').map(([, x, y]) => Math.hypot(x - 50, y - 50))
  const expected = 25 + offset // disc radius 50 px = 25 pt
  for (const r of radii) near(r, expected, 0.9)
})

test('white inside the artwork does not punch a hole in the cut', () => {
  const w = 120
  const rgba = canvasWithDiscs(w, w, [[60, 60, 40]])
  // A white eye in the middle of the black disc.
  for (let y = 50; y < 70; y++) for (let x = 50; x < 70; x++) rgba.fill(255, (y * w + x) * 4, (y * w + x) * 4 + 3)
  const mask = cutline.subjectMask(rgba, w, w)
  assert.equal(mask[60 * w + 60], 1, 'interior white was treated as background')
  const { path } = cutline.contourCutPath({ mask, width: w, height: w }, { x: 0, y: 0, width: 120, height: 120 }, 3)
  assert.equal(path.filter((c) => c[0] === 'Z').length, 1)
})

test('parts close together share one outline; specks are dropped', () => {
  const w = 300
  // Two discs 6 px apart, plus a 1 px speck far away.
  const rgba = canvasWithDiscs(w, w, [[90, 150, 50], [196, 150, 50], [290, 10, 1]])
  const mask = cutline.subjectMask(rgba, w, w)
  const out = cutline.contourCutPath({ mask, width: w, height: w }, { x: 0, y: 0, width: 150, height: 150 }, 2 * cutline.MM)
  assert.equal(out.pieces, 1)
  assert.equal(out.ignored, 1)
})

test('a blank image refuses a contour cut instead of cutting nothing', () => {
  const w = 50
  const mask = cutline.subjectMask(new Uint8Array(w * w * 4).fill(255), w, w)
  assert.throws(() => cutline.contourCutPath({ mask, width: w, height: w }, { x: 0, y: 0, width: 50, height: 50 }, 3), /No artwork/)
})

test('shape cuts land on the trim edge', () => {
  const xs = (p) => p.filter((c) => c[0] !== 'Z').flatMap((c) => c.slice(1).filter((_, i) => i % 2 === 0))
  const rect = cutline.shapeCutPath('rect', 100, 60)
  assert.deepEqual([Math.min(...xs(rect)), Math.max(...xs(rect))], [0, 100])
  const circle = cutline.shapeCutPath('circle', 80, 80)
  near(Math.min(...xs(circle)), 0)
  near(Math.max(...xs(circle)), 80)
  assert.throws(() => cutline.shapeCutPath('contour', 10, 10), /Not a shape/)
})

test('sheets tile the most stickers and keep the margins', () => {
  const size = { w: 50, h: 50, unit: 'mm' }
  const cut = { bleedPt: cutline.BLEED_PT, sheet: 'a4' }
  const a4 = stickerLayout(size, cut)
  // 54 mm cells, 4 mm gap, 10 mm margins: 3 across 190 mm, 4 down 277 mm.
  assert.equal(a4.count, 12)
  for (const c of a4.cells) {
    assert.ok(c.x >= cutline.SHEET_MARGIN_PT - 0.01 && c.y >= cutline.SHEET_MARGIN_PT - 0.01)
    assert.ok(c.x + a4.cellW <= a4.pageW - cutline.SHEET_MARGIN_PT + 0.01)
  }
  assert.equal(stickerLayout(size, { ...cut, sheet: 'a3plus' }).count, 40)
  // A long sticker turns the sheet landscape if more fit that way.
  const bumper = stickerLayout({ w: 300, h: 75, unit: 'mm' }, { ...cut, sheet: 'a3' })
  assert.ok(bumper.pageW > bumper.pageH)
  assert.throws(() => stickerLayout({ w: 400, h: 400, unit: 'mm' }, cut), /too big/)
})

test('a sticker PDF carries the cut as a CutContour spot colour, with trim and bleed', async () => {
  const image = fs.readFileSync(path.join(__dirname, '..', 'build', 'icon.png'))
  const size = { w: 50, h: 50, unit: 'mm' }
  const { wPt, hPt } = sizeToPoints(size)
  const cut = { kind: 'rounded', sheet: 'single', bleedPt: cutline.BLEED_PT, path: cutline.shapeCutPath('rounded', wPt, hPt) }
  const doc = await PDFDocument.load(await buildPdf(image, size, 'fill', null, 'rgb', cut))
  const page = doc.getPage(0)
  near(page.getSize().width, wPt + 2 * cutline.BLEED_PT, 0.02)
  near(page.getTrimBox().width, wPt, 0.02)
  near(page.getTrimBox().x, cutline.BLEED_PT, 0.02)
  const spaces = page.node.Resources().lookup(PDFName.of('ColorSpace'), PDFDict)
  const sep = doc.context.lookup(spaces.get(PDFName.of('CutContour'))).toString()
  assert.match(sep, /\/Separation \/CutContour \/DeviceCMYK/)

  const sheet = await PDFDocument.load(await buildPdf(image, size, 'fill', null, 'rgb', { ...cut, sheet: 'a3' }))
  near(sheet.getPage(0).getSize().width, 297 * cutline.MM, 0.05)
})

test('cutting marks match the shop sheet: bottom L corners and side ticks, 20 mm arms', () => {
  const W = 297 * cutline.MM
  const H = 420 * cutline.MM
  const marks = cutline.sheetMarks(W, H)
  assert.equal(marks.length, 6)
  const inset = 10 * cutline.MM
  const len = 20 * cutline.MM
  // Bottom-left L: corner at the inset, both arms 20 mm.
  assert.deepEqual(marks[0][1], [inset, inset])
  near(marks[0][0][1] - inset, len)
  near(marks[0][2][0] - inset, len)
  // Bottom-right L mirrors it.
  assert.deepEqual(marks[1][1], [W - inset, inset])
  // Side bars are 20 mm, centred at the same height on both sides, ticks pointing in.
  near(marks[2][1][1] - marks[2][0][1], len)
  near(marks[4][1][1] - marks[4][0][1], len)
  near(marks[3][0][1], H / 2)
  near(marks[5][0][1], H / 2)
  assert.ok(marks[3][1][0] > marks[3][0][0] && marks[5][1][0] < marks[5][0][0])
  // No marks along the top: that edge belongs to the header.
  for (const line of marks) for (const [, y] of line) assert.ok(y <= H / 2 + len / 2 + 0.01)
})

test('stickers keep clear of the marks and the header', () => {
  const size = { w: 50, h: 50, unit: 'mm' }
  const { wPt, hPt } = sizeToPoints(size)
  const base = { kind: 'circle', sheet: 'a3', bleedPt: cutline.BLEED_PT, path: cutline.shapeCutPath('circle', wPt, hPt) }
  const header = { name: 'SHOP', label: '', phone: '', logo: null, qr: null }
  const L = stickerLayout(size, { ...base, marks: true, header })
  const m = L.margins
  near(m.left, 20.5 * cutline.MM)
  near(m.right, 20.5 * cutline.MM)
  assert.ok(m.bottom >= 15 * cutline.MM)
  assert.ok(m.top >= 29 * cutline.MM - 0.01)
  for (const c of L.cells) {
    assert.ok(c.x >= m.left - 0.01 && c.x + L.cellW <= L.pageW - m.right + 0.01)
    assert.ok(c.y >= m.bottom - 0.01 && c.y + L.cellH <= L.header.y + 0.01)
  }
  assert.equal(L.marks.length, 6)
  // Off by default on a single sticker.
  assert.equal(stickerLayout(size, { ...base, sheet: 'single', marks: true }).marks.length, 0)
})

test('the mark distance from the edge moves the marks and the stickers with it', () => {
  const size = { w: 50, h: 50, unit: 'mm' }
  const { wPt, hPt } = sizeToPoints(size)
  const base = { kind: 'circle', sheet: 'a3', bleedPt: cutline.BLEED_PT, path: cutline.shapeCutPath('circle', wPt, hPt), marks: true }
  const near10 = stickerLayout(size, { ...base, markInsetPt: 10 * cutline.MM })
  const far = stickerLayout(size, { ...base, markInsetPt: 30 * cutline.MM })
  near(far.marks[0][1][0], 30 * cutline.MM)
  near(far.marks[0][1][1], 30 * cutline.MM)
  assert.ok(far.count < near10.count, `${far.count} should be fewer than ${near10.count}`)
  for (const c of far.cells) assert.ok(c.x >= far.margins.left - 0.01 && c.y >= far.margins.bottom - 0.01)
  // Out-of-range values are clamped, never trusted.
  near(cutline.clampInset(0), 3 * cutline.MM)
  near(cutline.clampInset(999 * cutline.MM), 40 * cutline.MM)
})

test('staggered rows fit more round stickers and never overlap', () => {
  const size = { w: 50, h: 50, unit: 'mm' }
  const { wPt, hPt } = sizeToPoints(size)
  const base = { kind: 'circle', sheet: 'a3', bleedPt: cutline.BLEED_PT, path: cutline.shapeCutPath('circle', wPt, hPt), marks: true }
  const grid = stickerLayout(size, base)
  const stag = stickerLayout(size, { ...base, pattern: 'staggered' })
  assert.equal(stag.pattern, 'staggered')
  assert.ok(stag.count > grid.count, `staggered ${stag.count} vs grid ${grid.count}`)
  // Bleed circles stay apart by at least the gap; nothing crosses the margins.
  const r = stag.cellW / 2
  for (let i = 0; i < stag.cells.length; i++) {
    const a = stag.cells[i]
    assert.ok(a.x >= stag.margins.left - 0.01 && a.x + stag.cellW <= stag.pageW - stag.margins.right + 0.01)
    assert.ok(a.y >= stag.margins.bottom - 0.01 && a.y + stag.cellH <= stag.pageH - stag.margins.top + 0.01)
    for (let j = i + 1; j < stag.cells.length; j++) {
      const b = stag.cells[j]
      assert.ok(Math.hypot(a.x - b.x, a.y - b.y) >= 2 * r + cutline.SHEET_GAP_PT - 0.01)
    }
  }
  // Squares and rectangles ignore the request and stay on the grid.
  const rect = { kind: 'rounded', sheet: 'a3', bleedPt: cutline.BLEED_PT, path: cutline.shapeCutPath('rounded', wPt, hPt), pattern: 'staggered' }
  assert.equal(stickerLayout(size, rect).pattern, 'grid')
})

test('rectangle stickers tile without rotating and keep their shape', () => {
  const size = { w: 90, h: 50, unit: 'mm' }
  const { wPt, hPt } = sizeToPoints(size)
  const L = stickerLayout(size, { kind: 'rounded', sheet: 'a4', bleedPt: cutline.BLEED_PT, path: cutline.shapeCutPath('rounded', wPt, hPt), marks: true })
  near(L.cellW, wPt + 2 * cutline.BLEED_PT)
  near(L.cellH, hPt + 2 * cutline.BLEED_PT)
  assert.ok(L.count >= 4)
  assert.ok(SIZE_PRESETS.some((p) => p.id === 'stickerrect9050'))
})

test('a marked sheet PDF draws the marks and header in process black', async () => {
  const image = fs.readFileSync(path.join(__dirname, '..', 'build', 'icon.png'))
  const size = { w: 50, h: 50, unit: 'mm' }
  const { wPt, hPt } = sizeToPoints(size)
  const header = { name: 'ECO GLOBAL PRINTING', label: 'Untuk Tempahan:', phone: '013-712 9937', logo: image, qr: { size: 3, data: [1, 0, 1, 0, 1, 0, 1, 0, 1] } }
  const cut = { kind: 'circle', sheet: 'a3', bleedPt: cutline.BLEED_PT, path: cutline.shapeCutPath('circle', wPt, hPt), marks: true, header }
  const doc = await PDFDocument.load(await buildPdf(image, size, 'fill', null, 'rgb', cut))
  const page = doc.getPage(0)
  const content = page.node.normalizedEntries().Contents
  const streams = (content.asArray ? content.asArray() : [content]).map((ref) => doc.context.lookup(ref))
  const { inflateSync } = require('node:zlib')
  const text = streams.map((st) => {
    const raw = Buffer.from(st.getContents())
    try { return inflateSync(raw).toString('latin1') } catch { return raw.toString('latin1') }
  }).join('\n')
  assert.match(text, /0 0 0 1 K/)
  assert.match(text, /0 0 0 1 k/)

  await assert.rejects(
    buildPdf(image, size, 'fill', null, 'rgb', { ...cut, header: { ...header, name: '印刷店' } }),
    /characters the built-in fonts can't print/
  )
})

async function headerPdfText (header, sheet = 'a4') {
  const { buildHeaderProof } = require('../src/core')
  const doc = await PDFDocument.load(await buildHeaderProof(sheet, header))
  const page = doc.getPage(0)
  const content = page.node.normalizedEntries().Contents
  const streams = (content.asArray ? content.asArray() : [content]).map((ref) => doc.context.lookup(ref))
  const { inflateSync } = require('node:zlib')
  return streams.map((st) => {
    const raw = Buffer.from(st.getContents())
    try { return inflateSync(raw).toString('latin1') } catch { return raw.toString('latin1') }
  }).join('\n')
}

test('header height moves the stickers down and is clamped', () => {
  const tall = cutline.sheetMargins({ header: true, headerHeightPt: 25 * cutline.MM })
  const short = cutline.sheetMargins({ header: true, headerHeightPt: 10 * cutline.MM })
  near(tall.top - short.top, 15 * cutline.MM)
  near(cutline.clampHeaderHeight(100 * cutline.MM), 30 * cutline.MM)
  near(cutline.clampHeaderHeight(2 * cutline.MM), 10 * cutline.MM)
  const box = cutline.headerBox(595, 842, tall, 25 * cutline.MM)
  near(box.h, 25 * cutline.MM)
})

test('header layouts, colour and extra lines all reach the PDF', async () => {
  const base = { name: 'ECO GLOBAL', tagline: 'Siap 1 jam', label: 'Untuk Tempahan:', phone: '013-712 9937', extra: '@ecoglobal', logo: null, qr: { size: 3, data: [1, 0, 1, 0, 1, 0, 1, 0, 1] }, heightPt: 18 * cutline.MM }
  for (const layout of ['brand-left', 'brand-right', 'brand-centre']) {
    const text = await headerPdfText({ ...base, layout })
    assert.match(text, /Tj/)
  }
  // Brand colour as RGB; black stays process black.
  const red = await headerPdfText({ ...base, color: '#cc0000' })
  assert.match(red, /0\.8 0 0 rg/)
  const black = await headerPdfText({ ...base, color: '#000000' })
  assert.match(black, /0 0 0 1 k/)
  // Times is a different built-in font from Helvetica.
  const { buildHeaderProof } = require('../src/core')
  const times = await PDFDocument.load(await buildHeaderProof('a4', { ...base, font: 'times' }))
  const fonts = times.getPage(0).node.Resources().lookup(PDFName.of('Font'), PDFDict)
  const names = fonts.values().map((ref) => times.context.lookup(ref).get(PDFName.of('BaseFont')).toString())
  assert.ok(names.some((n) => /Times/.test(n)), names.join(','))
})

test('a font file lets the header print non-Latin names', async () => {
  const candidates = ['/System/Library/Fonts/Supplemental/Arial Unicode.ttf', '/usr/share/fonts/truetype/droid/DroidSansFallbackFull.ttf']
  const file = candidates.find((f) => fs.existsSync(f))
  if (!file) return // no CJK font on this machine; covered on the dev Mac
  const { buildHeaderProof } = require('../src/core')
  const bytes = await buildHeaderProof('a4', { name: '环球印刷', phone: '013-712 9937', label: '', logo: null, qr: null, fontBytes: fs.readFileSync(file) })
  assert.ok(bytes.length > 1000)
})

test('the contour trace and the PDF place the image identically', () => {
  // Same numbers in, same rectangle out — the cut cannot drift off the art.
  const r = stickerImageRect(1024, 1536, 100, 150, 'fill', 5)
  const d = drawRect(1024, 1536, 110, 160, 'fill')
  near(r.x, d.x - 5)
  near(r.width, d.width)
})

test('the brief asks for plain white behind a contour sticker', () => {
  const aspect = aspectFor(142, 142)
  assert.match(generateInstruction('a cat', aspect, ['01.png'], 0, 'contour'), /pure white/)
  assert.match(generateInstruction('a cat', aspect, ['01.png'], 0, 'circle'), /circle/)
  assert.doesNotMatch(generateInstruction('a cat', aspect, ['01.png']), /sticker/)
})

test('artwork drawn to the edge is shrunk so its border still fits', () => {
  const w = 100
  // A disc touching every edge of the image.
  const mask = cutline.subjectMask(canvasWithDiscs(w, w, [[50, 50, 50]]), w, w)
  const rect = { x: 0, y: 0, width: 100, height: 100 }
  const { rect: placed, scale } = cutline.fitContourRect({ mask, width: w, height: w }, rect, 5, { w: 100, h: 100 })
  assert.ok(scale < 1)
  const { path } = cutline.contourCutPath({ mask, width: w, height: w }, placed, 5, { w: 100, h: 100 })
  const xs = path.filter((c) => c[0] !== 'Z').map((c) => c[1])
  assert.ok(Math.min(...xs) > -0.01 && Math.max(...xs) < 100.01)
  // Untouched when it already fits.
  const small = cutline.subjectMask(canvasWithDiscs(w, w, [[50, 50, 20]]), w, w)
  assert.equal(cutline.fitContourRect({ mask: small, width: w, height: w }, rect, 5, { w: 100, h: 100 }).scale, 1)
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
