'use strict'

const api = window.printshop
const $ = (id) => document.getElementById(id)

let catalog = null
let settings = null
let lastJob = null
let selectedFile = null
let selectedIndex = 0
let promptBeforeCodex = null
let codexFound = null
let codexLoggedIn = false
let upscaleAvailable = false
let exporting = false
let references = []
let licence = null
const MAX_REFERENCES = 4

// ---------------------------------------------------------------------------
// Size maths — mirrors toPoints() / renderSizeFor() / dpiAdvice() in core.js.
// ---------------------------------------------------------------------------

const DPI_TIERS = [
  { maxArea: 0.15, want: 300, warn: 150, note: 'read in the hand' },
  { maxArea: 0.50, want: 200, warn: 100, note: 'wall poster' },
  { maxArea: 1.50, want: 150, warn: 75, note: 'seen from a few steps back' },
  { maxArea: 4.00, want: 100, warn: 50, note: 'seen from across a room' },
  { maxArea: Infinity, want: 72, warn: 36, note: 'seen from far off' }
]

function dpiAdvice (wPt, hPt, actualDpi) {
  const areaM2 = ((wPt / 72) * 0.0254) * ((hPt / 72) * 0.0254)
  const tier = DPI_TIERS.find((t) => areaM2 <= t.maxArea)
  return { ...tier, ok: actualDpi >= tier.warn, good: actualDpi >= tier.want }
}

function toPoints (value, unit, dpi) {
  if (unit === 'px') return (value * 72) / dpi
  return value * catalog.ptPerUnit[unit]
}

const RENDER_PIXELS = 1024 * 1536

function renderSizeFor (wPt, hPt) {
  const ratio = wPt / hPt
  return `${Math.round(Math.sqrt(RENDER_PIXELS * ratio))}x${Math.round(Math.sqrt(RENDER_PIXELS / ratio))}`
}

// Mirrors aspectStrain() in core.js. The brief asks for the page's own shape,
// but the model is free to ignore it — so this measures what actually landed
// against the page, and only after the images are back.
function aspectStrain (wPt, hPt, imgW, imgH) {
  if (!(imgW > 0) || !(imgH > 0)) return null
  const page = wPt / hPt
  const image = imgW / imgH
  const stretch = Math.max(page / image, image / page)
  return { stretch, lossPct: Math.round((1 - 1 / stretch) * 100), severe: stretch >= 1.3 }
}

function currentSize () {
  const dpi = Number($('dpi').value) || 300
  const landscape = $('landscape').checked
  const id = $('preset').value

  if (id === 'custom') {
    const w = Number($('customW').value)
    const h = Number($('customH').value)
    const unit = $('customUnit').value
    return { w, h, unit, dpi, landscape, label: `${w}x${h}${unit}` }
  }

  const preset = catalog.presets.find((p) => p.id === id)
  return { w: preset.w, h: preset.h, unit: preset.unit, dpi, landscape, label: preset.label }
}

function pointsOf (size) {
  const w = toPoints(size.w, size.unit, size.dpi)
  const h = toPoints(size.h, size.unit, size.dpi)
  return size.landscape ? { wPt: h, hPt: w } : { wPt: w, hPt: h }
}

const picked = (name) => document.querySelector(`input[name="${name}"]:checked`).value

function fitMode () {
  return picked('fit')
}

function watermark () {
  if (picked('watermark') !== 'on') return null
  const text = $('watermarkText').value.trim() || 'PROOF'
  return { text, opacity: 0.25 }
}

function cutOptions () {
  const kind = $('cutKind').value
  if (!kind || kind === 'none') return null
  return {
    kind,
    offsetMm: Number($('cutOffset').value),
    sheet: $('sheet').value,
    marks: $('sheetMarks').checked,
    markInsetMm: markInsetMm(),
    header: $('sheetHeader').checked,
    pattern: kind === 'circle' ? $('sheetPattern').value : 'grid'
  }
}

// Distance of the cutting marks from the paper edge, clamped to what the app allows.
function markInsetMm () {
  const limits = catalog?.markInset || { defaultMm: 10, minMm: 3, maxMm: 40 }
  const value = Number($('markInset').value)
  if (!Number.isFinite(value) || $('markInset').value === '') return limits.defaultMm
  return Math.min(limits.maxMm, Math.max(limits.minMm, value))
}

// A cut line is a vector path in a spot colour, so only PDF can carry it.
function refreshCut () {
  const cut = cutOptions()
  $('cutOffsetField').hidden = cut?.kind !== 'contour'
  $('sheetField').hidden = !cut
  $('sheetExtrasField').hidden = !cut || cut.sheet === 'single'
  $('patternField').hidden = !cut || cut.sheet === 'single' || cut.kind !== 'circle'
  $('markInset').disabled = !$('sheetMarks').checked
  for (const radio of document.querySelectorAll('input[name="format"]')) {
    radio.disabled = Boolean(cut) && radio.value !== 'pdf'
  }
  if (cut && picked('format') !== 'pdf') document.querySelector('input[name="format"][value="pdf"]').checked = true

  const note = $('cutNote')
  if (!cut) {
    note.hidden = true
  } else {
    note.textContent = cut.kind === 'contour'
      ? `Codex draws the design on plain white; export traces its outline with a ${cut.offsetMm} mm white border. ` +
        'The cut is a CutContour spot-colour line in the PDF, which cutter software reads.'
      : 'Artwork runs 2 mm past the cut (bleed), so a blade landing slightly off leaves no white edge. ' +
        'The cut is a CutContour spot-colour line in the PDF.'
    note.hidden = false
  }
}

// Shows the cut on the selected variant before anything is exported — a
// contour is traced, so it is worth seeing.
let previewToken = 0
async function updateCutPreview () {
  const figure = $('cutPreview')
  const cut = cutOptions()
  if (!cut || !selectedFile || !lastJob) {
    figure.hidden = true
    return
  }
  const token = ++previewToken
  const caption = $('cutCaption')
  caption.textContent = cut.kind === 'contour' ? 'Tracing the outline…' : ''
  figure.hidden = false

  const result = await api.cutPreview({ file: selectedFile, size: currentSize(), fitMode: fitMode(), cut })
  if (token !== previewToken) return
  const svg = $('cutSvg')
  svg.replaceChildren()
  $('sheetSvg').replaceChildren()
  $('sheetSvg').toggleAttribute('hidden', true)
  if (!result.ok) {
    svg.toggleAttribute('hidden', true)
    caption.textContent = result.error
    caption.className = 'small warn'
    return
  }
  const p = result.data
  svg.toggleAttribute('hidden', false)
  svg.setAttribute('viewBox', `0 0 ${p.boxW} ${p.boxH}`)
  const ns = 'http://www.w3.org/2000/svg'
  const el = (name, attrs) => {
    const node = document.createElementNS(ns, name)
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v)
    return node
  }
  svg.append(
    el('rect', { x: 0, y: 0, width: p.boxW, height: p.boxH, class: 'paper' }),
    el('image', { href: lastJob.urls[selectedIndex], x: p.image.x, y: p.image.y, width: p.image.w, height: p.image.h, preserveAspectRatio: 'none' }),
    el('rect', { x: p.trim.x, y: p.trim.y, width: p.trim.w, height: p.trim.h, class: 'trim' }),
    el('path', { d: p.d, class: 'cut' })
  )
  const bits = ['Magenta = cut line', 'dashed = trim edge']
  if (p.pieces > 1) bits.push(`${p.pieces} separate pieces`)
  if (p.shrunk) bits.push(`artwork shrunk ${p.shrunk}% so the border fits inside the sticker`)
  if (cut.sheet !== 'single') {
    const sheet = catalog.sheets.find((s) => s.id === cut.sheet)?.label.replace(' sheet', '')
    bits.push(p.sheet?.pattern === 'staggered'
      ? `${p.count} per ${sheet} sheet (${p.rows} staggered rows)`
      : `${p.count} per ${sheet} sheet (${p.cols} × ${p.rows})`)
    if (cut.marks) bits.push(`4 cutting marks, ${cut.markInsetMm} mm from the edge`)
    if (p.sheet?.headerMissing) bits.push('shop header is empty — fill it in Settings')
  }
  if (p.sheet) drawSheetPreview(p, el)
  caption.textContent = bits.join(' · ')
  caption.className = 'muted small'
}

// Whole sheet at thumbnail size: stickers, cut lines, marks and header strip.
function drawSheetPreview (p, el) {
  const s = p.sheet
  const svg = $('sheetSvg')
  svg.setAttribute('viewBox', `0 0 ${s.pageW} ${s.pageH}`)
  const defs = el('defs', {})
  const sym = el('symbol', { id: 'sheetCell', viewBox: `0 0 ${p.boxW} ${p.boxH}` })
  // Staggered rows nest into each other, so the art is shown clipped round, as printed.
  if (s.pattern === 'staggered') {
    const clip = el('clipPath', { id: 'sheetCellClip' })
    clip.append(el('ellipse', { cx: p.boxW / 2, cy: p.boxH / 2, rx: p.boxW / 2, ry: p.boxH / 2 }))
    defs.append(clip)
    sym.setAttribute('clip-path', 'url(#sheetCellClip)')
  }
  sym.append(
    el('image', { href: lastJob.urls[selectedIndex], x: p.image.x, y: p.image.y, width: p.image.w, height: p.image.h, preserveAspectRatio: 'none' }),
    // Presentation attributes, not a class: CSS does not reach into <use> copies.
    el('path', { d: p.d, fill: 'none', stroke: '#e0007a', 'stroke-width': 2 })
  )
  defs.append(sym)
  svg.append(defs, el('rect', { x: 0, y: 0, width: s.pageW, height: s.pageH, class: 'paper' }))
  for (const c of s.cells) svg.append(el('use', { href: '#sheetCell', x: c.x, y: c.y, width: s.cellW, height: s.cellH }))
  if (s.header) svg.append(el('rect', { x: s.header.x, y: s.header.y, width: s.header.w, height: s.header.h, class: 'header-box' }))
  if (s.marks) svg.append(el('path', { d: s.marks, class: 'mark' }))
  svg.toggleAttribute('hidden', false)
}

// PNG is RGB-only by spec, and CMYK needs a profile — say which, not just "no".
function refreshExportOptions () {
  if (!catalog) return
  lockProChoices()
  refreshCut()
  const format = picked('format')
  const colour = picked('colour')
  const cmykOk = catalog.cmykCapable.includes(format)

  $('colourCmyk').disabled = !cmykOk
  if (!cmykOk && colour === 'cmyk') document.querySelector('input[name="colour"][value="rgb"]').checked = true

  $('watermarkField').hidden = picked('watermark') !== 'on'

  $('resolutionField').hidden = !upscaleAvailable
  const aiNote = $('upscaleNote')
  if (upscaleAvailable && picked('resolution') === 'ai') {
    aiNote.textContent = 'AI upscale adds real detail up to the DPI this page wants (4× at most). ' +
      'Takes a few minutes the first time for each variant and size; repeat exports reuse it.'
    aiNote.hidden = false
  } else {
    aiNote.hidden = true
  }

  const note = []
  if (!cmykOk) note.push(`${format.toUpperCase()} has no CMYK colour space`)
  else if (picked('colour') === 'cmyk' && !settings?.iccPath) note.push('Set a CMYK profile in Settings before exporting')
  else if (picked('colour') === 'cmyk') note.push(`Using ${settings.iccPath.split('/').pop()}`)
  $('colourNote').textContent = note.join(' · ')
  disableProControls()
}

// ---------------------------------------------------------------------------
// Licence. Main checks every generate and export too; this only keeps Basic
// from picking what main would refuse, and says why.
// ---------------------------------------------------------------------------

function isPro () {
  return Boolean(licence && licence.features.includes('cut'))
}

// Before the options are read: a Basic licence never has a Pro choice selected.
function lockProChoices () {
  if (isPro()) return
  $('cutKind').value = 'none'
  document.querySelector('input[name="resolution"][value="original"]').checked = true
  document.querySelector('input[name="colour"][value="rgb"]').checked = true
  if (picked('format') === 'tiff') document.querySelector('input[name="format"][value="pdf"]').checked = true
}

// After the other rules have set what is enabled: switch the Pro controls off.
function disableProControls () {
  const basic = !isPro()
  for (const note of document.querySelectorAll('.pro-note')) note.hidden = !basic
  if (!basic) return
  $('cutKind').disabled = true
  document.querySelector('input[name="resolution"][value="ai"]').disabled = true
  $('colourCmyk').disabled = true
  document.querySelector('input[name="format"][value="tiff"]').disabled = true
  $('upscaleNote').hidden = true
}

function showLicence (summary) {
  licence = summary
  $('licenceSummary').textContent = licence
    ? `${licence.tierLabel}${licence.name ? ` · ${licence.name}` : ''} · ${licence.email}${licence.issued ? ` · since ${licence.issued}` : ''}`
    : 'Not activated'
  $('upgradeFromSettings').hidden = !licence || isPro()
  $('cutKind').disabled = false
  for (const id of ['ai', 'original']) document.querySelector(`input[name="resolution"][value="${id}"]`).disabled = false
  document.querySelector('input[name="format"][value="tiff"]').disabled = false
  refreshExportOptions()
  updateCutPreview()
  renderSetup()
}

// ---------------------------------------------------------------------------
// First-run checklist. Each step that is not done says what to do next, so a
// new shop never meets the missing piece as a failure minutes into a job.
// ---------------------------------------------------------------------------

function setupStep (id, done, text, { go = true } = {}) {
  $(id).classList.toggle('done', done)
  $(`${id}Text`).textContent = text
  $(`${id}Go`).hidden = done || !go
  $(id).querySelector('.tick').textContent = done ? '✓' : $(id).querySelector('.tick').dataset.n
}

function renderSetup () {
  if (!catalog) return
  setupStep('stepLicence', Boolean(licence), licence
    ? `${licence.tierLabel} · ${licence.email}`
    : 'Paste the key you received on WhatsApp. No key yet? Buy one from the licence screen.')
  setupStep('stepInstall', Boolean(codexFound), codexFound
    ? `Found ${codexFound.version}`
    : 'Printshop makes artwork through Codex CLI on your ChatGPT plan. Install it, then come back to this window.')
  setupStep('stepLogin', codexLoggedIn, codexLoggedIn
    ? 'Signed in'
    : codexFound ? 'Opens your browser to sign in with your ChatGPT account.' : 'Available once Codex is installed.',
  { go: Boolean(codexFound) })
  $('setupCard').hidden = Boolean(licence && codexFound && codexLoggedIn)
}

for (const li of document.querySelectorAll('.steps li')) {
  const tick = li.querySelector('.tick')
  tick.dataset.n = tick.textContent
}

// Re-check Codex when the window comes back into focus while setup is open:
// the usual way to finish a step is to install or sign in elsewhere.
let setupChecking = false
window.addEventListener('focus', async () => {
  if ($('setupCard').hidden || setupChecking || !catalog) return
  setupChecking = true
  try {
    await detectCodex()
    await refreshCodexLogin()
    refresh()
  } finally {
    setupChecking = false
  }
})

$('stepLicenceGo').addEventListener('click', () => openLicencePane(true))
$('stepInstallGo').addEventListener('click', () => openSettings('codex'))
$('stepLoginGo').addEventListener('click', async () => {
  const button = $('stepLoginGo')
  button.disabled = true
  button.textContent = 'Browser opened…'
  $('stepLoginText').textContent = 'Finish sign-in in your browser, then come back here.'
  const result = await api.codexLogin()
  button.disabled = false
  button.textContent = 'Sign in'
  await refreshCodexLogin()
  if (!result.ok && !codexLoggedIn) $('stepLoginText').textContent = result.error
  refresh()
})

function openLicencePane (canCancel) {
  $('licenceKey').value = ''
  hide($('licenceError'))
  $('cancelLicence').hidden = !canCancel
  $('licencePane').hidden = false
  $('licenceKey').focus()
}

$('activateLicence').addEventListener('click', async () => {
  const button = $('activateLicence')
  button.disabled = true
  try {
    showLicence(unwrap(await api.setLicence({ key: $('licenceKey').value }), $('licenceError')))
    $('licencePane').hidden = true
  } catch { /* shown in licenceError */ } finally {
    button.disabled = false
  }
})
$('cancelLicence').addEventListener('click', () => { $('licencePane').hidden = true })
$('buyLicence').addEventListener('click', () => api.buyLicence({ upgrade: Boolean(licence) }))
$('changeLicence').addEventListener('click', () => openLicencePane(Boolean(licence)))
$('upgradeFromSettings').addEventListener('click', () => api.buyLicence({ upgrade: true }))
for (const button of document.querySelectorAll('.pro-note .upgrade')) {
  button.addEventListener('click', () => api.buyLicence({ upgrade: true }))
}

// Exact: scale is points-per-pixel once the image is placed on the page.
function effectiveDpi (wPt, hPt, renderSize) {
  const [pxW, pxH] = renderSize.split('x').map(Number)
  const scale = fitMode() === 'fit'
    ? Math.min(wPt / pxW, hPt / pxH)
    : Math.max(wPt / pxW, hPt / pxH)
  return 72 / scale
}

// ---------------------------------------------------------------------------
// Live readouts
// ---------------------------------------------------------------------------

function refresh () {
  if (!catalog) return
  const size = currentSize()
  const readout = $('pageReadout')

  if (!(size.w > 0) || !(size.h > 0)) {
    hide($('shapeNote'))
    readout.textContent = 'Enter a width and height'
    readout.className = 'warn'
    $('estimate').textContent = 'Estimated —'
    $('generate').disabled = true
    return
  }

  const { wPt, hPt } = pointsOf(size)
  const renderSize = renderSizeFor(wPt, hPt)
  const dpi = Math.round(effectiveDpi(wPt, hPt, renderSize))
  const advice = dpiAdvice(wPt, hPt, dpi)
  const shown = size.landscape ? `${size.h} × ${size.w}` : `${size.w} × ${size.h}`

  // What counts as enough resolution depends on the size — a bunting read from
  // across a room does not need what a flyer in the hand needs.
  const verdict = advice.good
    ? 'fine for print'
    : advice.ok
      ? `usable — ${advice.note}, ${advice.want} DPI would be ideal`
      : `too low — ${advice.note} still wants ${advice.warn}+ DPI`

  readout.textContent =
    `${shown} ${size.unit} · ${Math.round(wPt)} × ${Math.round(hPt)} pt · ${dpi} DPI · ${verdict}`
  readout.className = advice.ok ? 'muted' : 'warn'

  // The brief asks for the page's proportions; the model does not always
  // oblige. Only the finished image settles it, so this appears after a job and
  // is re-judged against the page currently selected.
  const shapeNote = $('shapeNote')
  const landed = lastJob?.dims?.[selectedIndex]
  const strain = landed ? aspectStrain(wPt, hPt, landed.width, landed.height) : null
  if (strain?.severe) {
    const which = lastJob.files.length > 1 ? `Variant ${selectedIndex + 1} came back` : 'Codex returned'
    show(shapeNote, `${which} ${(landed.width / landed.height).toFixed(2)}:1 for a ${(wPt / hPt).toFixed(2)}:1 page. About ${strain.lossPct}% of the artwork is cropped on Fill, or the same amount of the page is left blank on Fit. Another run may land closer.`)
    shapeNote.className = 'banner warn'
  } else {
    hide(shapeNote)
  }

  const count = Number($('count').value)
  // Each image is a separate round trip to OpenAI, so the wait scales with count.
  const minutes = count <= 1 ? '2–5 minutes' : `${count * 2}–${count * 5} minutes`
  $('estimate').textContent =
    `No per-image cost — runs on your ChatGPT plan · ${count} × ~${renderSize} · about ${minutes}`

  $('generate').disabled = !codexFound || !$('prompt').value.trim()
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

function unwrap (result, target) {
  if (result.ok) {
    if (target) hide(target)
    return result.data
  }
  if (target) show(target, result.error)
  throw new Error(result.error)
}

function show (el, text) { el.textContent = text; el.hidden = false }
function hide (el) { el.hidden = true }

async function boot () {
  catalog = unwrap(await api.catalog())

  const preset = $('preset')
  let group = null
  for (const p of catalog.presets) {
    if (p.group !== group) {
      group = p.group
      preset.append(Object.assign(document.createElement('optgroup'), { label: group }))
    }
    preset.lastElementChild.append(new Option(p.label, p.id))
  }
  preset.append(new Option('Custom…', 'custom'))
  preset.value = 'a4'

  for (const kind of catalog.cutKinds) $('cutKind').append(new Option(kind.label, kind.id))
  for (const mm of catalog.contourOffsetsMm) $('cutOffset').append(new Option(`${mm} mm`, String(mm)))
  $('cutOffset').value = String(catalog.defaultOffsetMm)
  for (const sheet of catalog.sheets) $('sheet').append(new Option(sheet.label, sheet.id))

  for (const u of catalog.units) $('customUnit').append(new Option(u, u))
  $('customUnit').value = 'mm'

  showLicence(unwrap(await api.licence()))
  if (!licence) {
    openLicencePane(false)
    const problem = unwrap(await api.licenceProblem())
    if (problem) show($('licenceError'), problem)
  }
  await loadSettings()
  await detectCodex()
  await refreshCodexLogin()
  try { upscaleAvailable = unwrap(await api.upscaleStatus()).available } catch { upscaleAvailable = false }
  refreshExportOptions()
  refresh()
}

async function refreshCodexLogin () {
  const status = unwrap(await api.codexStatus())
  $('codexLoginState').textContent = status.installed
    ? (status.loggedIn ? `Signed in — ${status.text}` : `Not signed in. ${status.text}`)
    : 'Codex CLI not installed.'
  $('codexLogin').hidden = !status.installed || status.loggedIn
  $('codexLogout').hidden = !status.loggedIn
  codexLoggedIn = Boolean(status.installed && status.loggedIn)
  renderSetup()
}

// Codex is the whole engine now — without it the app cannot generate at all.
async function detectCodex () {
  codexFound = unwrap(await api.detectCodex())
  $('codexTools').hidden = !codexFound
  $('codexPath').value = settings.codexPath || ''
  $('codexState').textContent = codexFound
    ? `Found ${codexFound.version} at ${codexFound.bin}`
    : 'Not found — install Codex CLI, or set its full path here.'

  const warning = $('codexWarning')
  if (codexFound) hide(warning)
  else show(warning, 'Codex CLI not found. Printshop generates artwork through Codex on your ChatGPT plan, so it cannot generate until Codex is installed and signed in.')
  renderSetup()
}

async function loadSettings () {
  settings = unwrap(await api.getSettings())
  $('outputDir').value = settings.outputDir
  $('iccPath').value = settings.iccPath || ''
  $('watermarkText').value = settings.watermarkText || 'PROOF'
  for (const key of HEADER_FIELDS) $(key).value = settings[key] ?? ''
  refreshHeaderFont()
  scheduleHeaderPreview()
  // Default the header on once the shop has filled one in.
  if (!headerTouched) $('sheetHeader').checked = Boolean(settings.headerName || settings.headerPhone || settings.headerLogoPath)
}
let headerTouched = false

const HEADER_FIELDS = [
  'headerName', 'headerTagline', 'headerLabel', 'headerPhone', 'headerExtra', 'headerQr', 'headerLogoPath',
  'headerLayout', 'headerHeightMm', 'headerNameScale', 'headerContactScale', 'headerColor', 'headerFont', 'headerFontPath'
]

function headerValues () {
  const values = {}
  for (const key of HEADER_FIELDS) {
    const input = $(key)
    values[key] = input.type === 'number' ? Number(input.value) : input.value
  }
  return values
}

function refreshHeaderFont () {
  const custom = $('headerFont').value === 'custom'
  $('headerFontPathField').hidden = !custom
  $('browseFont').hidden = !custom
}

// ---------------------------------------------------------------------------
// Progress. Percentage comes from images actually written; the clock keeps
// running between events so a quiet stretch never looks like a freeze.
// ---------------------------------------------------------------------------

let jobStartedAt = 0
let lastEventAt = 0
let jobTimer = null
let jobDone = 0
let jobTotal = 0

function elapsedText () {
  const s = Math.floor((Date.now() - jobStartedAt) / 1000)
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
}

function paintProgress (label) {
  const pct = jobTotal ? Math.round((jobDone / jobTotal) * 100) : 0
  // The image model can work silently for minutes. Showing how long since the
  // last real step is the difference between "slow" and "hung".
  const quiet = Math.floor((Date.now() - lastEventAt) / 1000)
  const idle = jobTimer && quiet > 20 ? ` · working, ${quiet}s since last step` : ''
  $('progressStat').textContent =
    `${label ?? `${jobDone}/${jobTotal} images · ${pct}%`} · ${elapsedText()}${idle}`
  $('progressFill').classList.toggle('indeterminate', jobDone === 0)
  $('progressFill').style.width = jobDone === 0 ? '' : `${pct}%`
}

function appendLog (text) {
  lastEventAt = Date.now()
  const log = $('progressLog')
  const lines = log.textContent ? log.textContent.split('\n') : []

  // Codex emits a step twice — once started, once completed. Collapse the pair
  // into one line that gains its tick rather than printing the command again.
  const bare = text.replace(/^✓ /, '')
  if (text.startsWith('✓ ') && lines.length && lines[lines.length - 1].endsWith(bare)) {
    lines[lines.length - 1] = `[${elapsedText()}] ✓ ${bare}`
  } else {
    lines.push(`[${elapsedText()}] ${text}`)
  }

  log.textContent = lines.join('\n')
  log.scrollTop = log.scrollHeight
}

function startProgress (total) {
  jobStartedAt = Date.now()
  lastEventAt = jobStartedAt
  jobDone = 0
  jobTotal = total
  $('progressLog').textContent = ''
  $('progressTitle').textContent = 'Generating'
  $('progressCard').hidden = false
  $('progressCard').scrollIntoView({ behavior: 'smooth', block: 'end' })
  paintProgress('starting')
  clearInterval(jobTimer)
  jobTimer = setInterval(() => paintProgress(), 1000)
}

function stopProgress (title) {
  clearInterval(jobTimer)
  jobTimer = null
  $('cancelJob').hidden = true
  $('progressTitle').textContent = title
  paintProgress()
}

api.onProgress((event) => {
  if (event.phase === 'start') {
    startProgress(event.total)
    $('cancelJob').hidden = false
    $('cancelJob').disabled = false
    $('cancelJob').textContent = 'Cancel'
    hide($('jobNote'))
    appendLog(`Codex CLI · ${event.total} × ${event.renderSize}${event.reference ? ` · reference: ${event.reference}` : ''}`)
  } else if (event.phase === 'upscale') {
    if (exporting) {
      $('saveExport').textContent = `Upscaling… ${Math.floor(event.percent || 0)}%`
      $('cancelExport').hidden = false
    }
  } else if (event.phase === 'log') {
    appendLog(event.text)
  } else if (event.phase === 'image') {
    jobDone = event.done
    appendLog(`Image ${event.done} of ${event.total} written`)
    paintProgress()
  } else if (event.phase === 'retry') {
    // Silence here reads as a hang, and a retry is the most common reason the
    // wait suddenly doubles.
    appendLog(`Attempt ${event.attempt} of ${event.of} — asking again for ${event.missing} image${event.missing === 1 ? '' : 's'}`)
    $('progressTitle').textContent = 'Retrying'
  } else if (event.phase === 'done') {
    jobDone = event.done
    if (event.shortfall > 0) {
      stopProgress(event.cancelled
        ? `Cancelled — kept ${event.done} of ${event.total}`
        : `Finished short — ${event.done} of ${event.total}`)
      show($('jobNote'), event.note)
      $('jobNote').className = event.cancelled ? 'banner' : 'banner warn'
      $('retryRow').hidden = false
      appendLog(`Kept ${event.done} of ${event.total}`)
    } else {
      stopProgress('Done')
      appendLog('Finished')
    }
  } else if (event.phase === 'cancelled') {
    stopProgress('Cancelled')
    appendLog(event.text)
    show($('jobNote'), event.text)
    $('jobNote').className = 'banner'
    $('retryRow').hidden = false
  } else if (event.phase === 'failed') {
    stopProgress('Failed')
    show($('jobNote'), event.text)
    $('jobNote').className = 'banner warn'
    $('retryRow').hidden = false
    appendLog(event.text)
  }
})

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

async function generate () {
  const button = $('generate')
  const original = 'Generate'
  button.disabled = true
  button.textContent = 'Generating… (minutes)'
  hide($('genError'))
  hide($('referenceError'))
  hide($('jobNote'))
  $('retryRow').hidden = true
  // Clear the previous job so nothing on screen belongs to an older run.
  $('resultsCard').hidden = true
  $('savedCard').hidden = true
  lastJob = null
  hide($('shapeNote'))
  $('outputPane').scrollTo({ top: 0 })
  $('progressCard').querySelector('details').open = true

  try {
    const job = unwrap(await api.generate({
      prompt: $('prompt').value,
      size: currentSize(),
      count: Number($('count').value),
      referencePaths: references.map((r) => r.path),
      cut: $('cutKind').value
    }), $('genError'))

    // Cancelled before any image landed: the progress card already says so.
    if (!job.files.length) return
    lastJob = job
    selectedFile = null
    selectedIndex = 0
    renderGrid(job)
    $('resultsCard').hidden = false
    // The log has done its job once images exist; fold it so they sit higher.
    // A short or failed job keeps it open — that is when the log is read.
    if (!job.shortfall) $('progressCard').querySelector('details').open = false
    $('resultsCard').scrollIntoView({ behavior: 'smooth', block: 'start' })
    $('savedCard').hidden = true
  } catch { /* message already rendered */ } finally {
    button.textContent = original
    refresh()
  }
}

// The DPI shown before generating was a prediction; this is what actually landed.
function measuredFor (job, index) {
  const dim = job.dims?.[index]
  if (!dim?.width) return ''
  const { wPt, hPt } = pointsOf(currentSize())
  const scale = fitMode() === 'fit'
    ? Math.min(wPt / dim.width, hPt / dim.height)
    : Math.max(wPt / dim.width, hPt / dim.height)
  const dpi = Math.round(72 / scale)
  const advice = dpiAdvice(wPt, hPt, dpi)
  return ` · ${dim.width} × ${dim.height} px → ${dpi} DPI on this page${advice.ok ? '' : ` (below the ${advice.warn} DPI this size wants)`}`
}

function renderGrid (job) {
  const grid = $('grid')
  grid.replaceChildren()

  job.files.forEach((file, index) => {
    const wrap = document.createElement('div')
    wrap.className = 'thumb-wrap'

    const button = document.createElement('button')
    button.className = 'thumb'
    button.type = 'button'
    const img = document.createElement('img')
    img.src = job.urls[index]
    img.alt = `Variant ${index + 1}`
    button.append(img)

    button.addEventListener('click', () => {
      selectedFile = file
      selectedIndex = index
      for (const node of grid.querySelectorAll('.thumb')) node.classList.remove('selected')
      button.classList.add('selected')
      $('selectedLabel').textContent = `Selected variant ${index + 1}${measuredFor(job, index)}`
      $('saveExport').disabled = false
      // Variants differ in shape, so the warning belongs to the one picked.
      refresh()
      updateCutPreview()
    })
    button.addEventListener('dblclick', () => openLightbox(index))

    const zoom = document.createElement('button')
    zoom.className = 'ghost small zoom'
    zoom.type = 'button'
    zoom.textContent = '⤢'
    zoom.title = 'View larger'
    zoom.setAttribute('aria-label', `View variant ${index + 1} larger`)
    // Otherwise the click falls through and also changes the selection.
    zoom.addEventListener('click', (event) => {
      event.stopPropagation()
      openLightbox(index)
    })

    // Editing a result ("same scene, swap the cat for a dog") is the usual next
    // go, so the output goes straight back in as a reference.
    const reuse = document.createElement('button')
    reuse.className = 'ghost small reuse'
    reuse.type = 'button'
    reuse.textContent = 'Use as reference'
    reuse.setAttribute('aria-label', `Use variant ${index + 1} as a reference image`)
    reuse.addEventListener('click', () => withReferenceErrors(async () => {
      if (references.length >= MAX_REFERENCES) {
        throw new Error(`Already ${MAX_REFERENCES} reference images — remove one first.`)
      }
      // Every job names its output 01.png, 02.png…, so say which job it came from.
      const jobName = file.split(/[\\/]/).slice(-2, -1)[0]
      const picked = unwrap(await api.describeReferences({ paths: [file] }), $('referenceError'))
      addReferences(picked.map((ref) => ({ ...ref, name: jobName ? `${jobName} · ${ref.name}` : ref.name })))
      $('referenceField').scrollIntoView({ behavior: 'smooth', block: 'center' })
      $('prompt').focus()
    }))

    wrap.append(button, zoom, reuse)
    grid.append(wrap)
  })

  $('selectedLabel').textContent =
    `${job.files.length} image${job.files.length > 1 ? 's' : ''} saved${measuredFor(job, 0)} — click one`
  $('saveExport').disabled = true
  updateCutPreview()
}

// ---------------------------------------------------------------------------
// Lightbox
// ---------------------------------------------------------------------------

let lightboxIndex = -1

function openLightbox (index) {
  if (!lastJob || !lastJob.files[index]) return
  lightboxIndex = index

  const dim = lastJob.dims?.[index]
  const many = lastJob.files.length
  $('lightboxImg').src = lastJob.urls[index]
  $('lightboxImg').alt = `Variant ${index + 1}`
  $('lightboxCaption').textContent =
    `Variant ${index + 1} of ${many}` +
    `${dim?.width ? ` · ${dim.width} × ${dim.height} px` : ''}` +
    ` · ${lastJob.files[index].split('/').pop()}`

  $('lightboxPrev').disabled = many < 2
  $('lightboxNext').disabled = many < 2
  $('lightbox').hidden = false
  $('lightbox').focus()
}

function closeLightbox () {
  $('lightbox').hidden = true
  lightboxIndex = -1
}

function stepLightbox (delta) {
  if (lightboxIndex < 0) return
  const many = lastJob.files.length
  openLightbox((lightboxIndex + delta + many) % many)
}

async function saveExport () {
  if (!selectedFile) return
  const button = $('saveExport')
  button.disabled = true
  const upscale = upscaleAvailable && picked('resolution') === 'ai'
  button.textContent = 'Exporting…'
  exporting = true
  hide($('pdfError'))

  try {
    const { outPath, bytes, upscaled, cut } = unwrap(await api.saveExport({
      file: selectedFile,
      size: currentSize(),
      fitMode: fitMode(),
      format: picked('format'),
      colour: picked('colour'),
      watermark: watermark(),
      upscale,
      cut: cutOptions()
    }), $('pdfError'))

    const kept = lastJob.files.length
    $('savedPath').textContent = outPath
    $('savedNote').textContent =
      `${(bytes / 1024 / 1024).toFixed(1)} MB · ${picked('colour').toUpperCase()}` +
      `${upscaled ? ` · AI-upscaled ${upscaled.from} → ${upscaled.dpi} DPI` : ''}` +
      `${cut ? ` · CutContour line${cut.count > 1 ? `, ${cut.count} stickers on the sheet` : ''}${cut.marks ? ', cutting marks' : ''}${cut.header ? ', shop header' : ''}` : ''}` +
      `${watermark() ? ' · watermarked' : ''} · all ${kept} generated image${kept > 1 ? 's are' : ' is'} kept in the same folder.`
    $('savedCard').hidden = false
    $('savedCard').scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  } catch { /* message already rendered */ } finally {
    exporting = false
    button.disabled = false
    button.textContent = 'Export'
    $('cancelExport').hidden = true
  }
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

for (const id of ['preset', 'landscape', 'customW', 'customH', 'customUnit', 'dpi', 'count', 'prompt']) {
  $(id).addEventListener('input', refresh)
}

for (const radio of document.querySelectorAll('input[name="fit"]')) {
  radio.addEventListener('change', () => { refresh(); updateCutPreview() })
}
$('watermarkText').addEventListener('input', refreshExportOptions)

$('preset').addEventListener('change', () => {
  $('customRow').hidden = $('preset').value !== 'custom'
  // A round sticker preset means a round cut, unless one was already chosen.
  // Round and oval presets cut as circles; rectangle presets as rounded rectangles.
  const preset = $('preset').value
  if ($('cutKind').value === 'none') {
    if (/^sticker(round|oval)/.test(preset)) $('cutKind').value = 'circle'
    else if (/^stickerrect/.test(preset)) $('cutKind').value = 'rounded'
  }
  refresh()
  refreshExportOptions()
  updateCutPreview()
})

for (const id of ['cutKind', 'cutOffset', 'sheet']) {
  $(id).addEventListener('change', () => {
    refreshExportOptions()
    updateCutPreview()
  })
}
for (const id of ['landscape', 'customW', 'customH', 'customUnit']) $(id).addEventListener('change', updateCutPreview)

$('enhancePrompt').addEventListener('click', async () => {
  const button = $('enhancePrompt')
  const before = $('prompt').value
  button.disabled = true
  button.textContent = 'Asking Codex…'
  $('codexStatus').textContent = 'Codex is writing — this takes a few seconds.'

  const result = await api.enhancePrompt({ brief: before, size: currentSize() })
  if (result.ok) {
    promptBeforeCodex = before
    $('prompt').value = result.data.prompt
    $('codexStatus').textContent = `Rewritten by ${result.data.version}. Edit it before generating if you want.`
    $('revertPrompt').hidden = false
  } else {
    $('codexStatus').textContent = ''
    show($('genError'), result.error)
  }

  button.disabled = false
  button.textContent = 'Improve with Codex'
  refresh()
})

$('revertPrompt').addEventListener('click', () => {
  if (promptBeforeCodex === null) return
  $('prompt').value = promptBeforeCodex
  promptBeforeCodex = null
  $('revertPrompt').hidden = true
  $('codexStatus').textContent = ''
  refresh()
})

// Same brief, same size — a failed or short run is usually worth one more go,
// and images already on disk are left alone.
$('retryJob').addEventListener('click', () => {
  $('retryRow').hidden = true
  generate()
})

for (const group of ['format', 'colour', 'watermark', 'resolution']) {
  for (const radio of document.querySelectorAll(`input[name="${group}"]`)) {
    radio.addEventListener('change', refreshExportOptions)
  }
}

$('codexLogin').addEventListener('click', async () => {
  const button = $('codexLogin')
  button.disabled = true
  button.textContent = 'Browser opened…'
  $('codexLoginState').textContent = 'Finish sign-in in your browser — pick Continue with Google there if that is your ChatGPT account.'

  const result = await api.codexLogin()
  if (!result.ok) show($('settingsError'), result.error)
  button.disabled = false
  button.textContent = 'Sign in to Codex'
  await refreshCodexLogin()
  await detectCodex()
  refresh()
})

$('codexLogout').addEventListener('click', async () => {
  const result = await api.codexLogout()
  if (!result.ok) show($('settingsError'), result.error)
  await refreshCodexLogin()
  refresh()
})

$('browseLogo').addEventListener('click', async () => {
  hide($('settingsError'))
  const result = await api.pickLogo()
  if (!result.ok) { show($('settingsError'), result.error); return }
  if (result.data) $('headerLogoPath').value = result.data
  scheduleHeaderPreview()
})

// The mark distance is a per-shop habit, so it is remembered on this machine.
try {
  const saved = localStorage.getItem('markInsetMm')
  if (saved) $('markInset').value = saved
} catch { /* storage unavailable: keep the default */ }
$('markInset').addEventListener('change', () => {
  $('markInset').value = markInsetMm()
  try { localStorage.setItem('markInsetMm', $('markInset').value) } catch { /* not fatal */ }
  updateCutPreview()
})
$('sheetPattern').addEventListener('change', updateCutPreview)

$('headerFont').addEventListener('change', refreshHeaderFont)

// Live header strip in Settings. Positions come from main, from the same
// layout the PDF prints with; text is stretched to the PDF's measured width so
// a screen font with different metrics cannot make it look like it fits.
const HEADER_FAMILIES = {
  helvetica: 'Helvetica, Arial, sans-serif',
  times: '"Times New Roman", Times, serif',
  courier: '"Courier New", Courier, monospace'
}
let headerPreviewSeq = 0
let headerPreviewTimer = null
let headerFontLoaded = null

function scheduleHeaderPreview () {
  clearTimeout(headerPreviewTimer)
  headerPreviewTimer = setTimeout(updateHeaderPreview, 250)
}

async function updateHeaderPreview () {
  const seq = ++headerPreviewSeq
  const result = await api.previewHeader({ values: headerValues(), sheet: $('sheet').value, markInsetMm: markInsetMm() })
  if (seq !== headerPreviewSeq) return
  const svg = $('headerSvg')
  const msg = $('headerPreviewMsg')
  svg.replaceChildren()
  msg.className = 'muted small'
  if (!result.ok) {
    msg.textContent = result.error
    msg.className = 'small warn'
    return
  }
  const p = result.data
  if (!p) {
    msg.textContent = 'Fill in a shop name, phone, QR link or logo to see the header.'
    return
  }
  let family = HEADER_FAMILIES[p.font] || HEADER_FAMILIES.helvetica
  if (p.font === 'custom' && p.fontBytes) {
    try {
      const face = new FontFace('PrintshopHeaderFont', p.fontBytes)
      await face.load()
      if (headerFontLoaded) document.fonts.delete(headerFontLoaded)
      document.fonts.add(face)
      headerFontLoaded = face
      family = 'PrintshopHeaderFont, sans-serif'
    } catch { /* falls back to sans; widths still match the PDF */ }
    if (seq !== headerPreviewSeq) return
  }
  const ns = 'http://www.w3.org/2000/svg'
  const el = (name, attrs) => {
    const node = document.createElementNS(ns, name)
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v)
    return node
  }
  svg.setAttribute('viewBox', `0 0 ${p.w} ${p.h}`)
  if (p.logo) svg.append(el('image', { href: p.logo.href, x: p.logo.x, y: p.logo.y, width: p.logo.width, height: p.logo.height, preserveAspectRatio: 'none' }))
  if (p.qr) {
    const cell = p.qr.size / p.qr.n
    let d = ''
    for (let r = 0; r < p.qr.n; r++) {
      for (let c = 0; c < p.qr.n; c++) {
        if (p.qr.data[r * p.qr.n + c]) d += `M${p.qr.x + c * cell} ${p.qr.y + r * cell}h${cell}v${cell}h${-cell}z`
      }
    }
    svg.append(el('path', { d, fill: '#000', 'shape-rendering': 'crispEdges' }))
  }
  for (const t of p.texts) {
    const node = el('text', {
      x: t.x,
      y: t.y,
      'font-size': t.size,
      'font-family': family,
      'font-weight': p.font === 'custom' ? 'normal' : t.weight,
      fill: p.color,
      textLength: t.width,
      lengthAdjust: 'spacingAndGlyphs'
    })
    node.textContent = t.text
    svg.append(node)
  }
  const sheetName = $('sheet').value === 'single' ? `${p.sheet} (test sheet size)` : p.sheet
  msg.textContent = `Actual layout on ${sheetName}, ${Math.round(p.w / 2.8346)} × ${Math.round(p.h / 2.8346)} mm. Test print to check colour and font.`
}

for (const key of HEADER_FIELDS) {
  $(key).addEventListener('input', scheduleHeaderPreview)
  $(key).addEventListener('change', scheduleHeaderPreview)
}
$('sheet').addEventListener('change', scheduleHeaderPreview)
$('markInset').addEventListener('change', scheduleHeaderPreview)

$('browseFont').addEventListener('click', async () => {
  hide($('settingsError'))
  const result = await api.pickFont()
  if (!result.ok) { show($('settingsError'), result.error); return }
  if (result.data) $('headerFontPath').value = result.data
  scheduleHeaderPreview()
})

$('testHeader').addEventListener('click', async () => {
  hide($('settingsError'))
  $('headerTestMsg').textContent = 'Building…'
  const sheet = $('sheet').value
  const result = await api.testHeader({ values: headerValues(), sheet, markInsetMm: markInsetMm() })
  if (!result.ok) {
    $('headerTestMsg').textContent = ''
    show($('settingsError'), result.error)
    return
  }
  $('headerTestMsg').textContent = `Opened ${result.data.split('/').pop()} — not saved until you press Save.`
})

for (const id of ['sheetMarks', 'sheetHeader']) {
  $(id).addEventListener('change', () => {
    if (id === 'sheetHeader') headerTouched = true
    refreshExportOptions()
    updateCutPreview()
  })
}

$('browseIcc').addEventListener('click', async () => {
  hide($('settingsError'))
  const result = await api.pickIcc()
  if (!result.ok) { show($('settingsError'), result.error); return }
  if (result.data) $('iccPath').value = result.data
})

$('lightboxClose').addEventListener('click', closeLightbox)
$('lightboxPrev').addEventListener('click', () => stepLightbox(-1))
$('lightboxNext').addEventListener('click', () => stepLightbox(1))

// Clicking the backdrop closes; clicking the image or the bar must not.
$('lightbox').addEventListener('click', (event) => {
  if (event.target === $('lightbox')) closeLightbox()
})

document.addEventListener('keydown', (event) => {
  if ($('lightbox').hidden) return
  if (event.key === 'Escape') closeLightbox()
  else if (event.key === 'ArrowLeft') stepLightbox(-1)
  else if (event.key === 'ArrowRight') stepLightbox(1)
})

// References outlive a job on purpose — the usual run is several goes at the
// same source images with a different prompt each time.
function renderReferences () {
  const list = $('referenceList')
  list.replaceChildren(...references.map((ref, index) => {
    const size = ref.bytes >= 1024 * 1024
      ? `${(ref.bytes / 1024 / 1024).toFixed(1)} MB`
      : `${Math.max(1, Math.round(ref.bytes / 1024))} KB`
    const item = document.createElement('li')
    item.className = 'reference'
    // Name and size ride on the tooltip — the pane is too narrow for a row each.
    item.title = `${ref.name}\n${ref.width} × ${ref.height} px · ${size}`
    const thumb = document.createElement('img')
    thumb.src = ref.url
    thumb.alt = `Reference ${index + 1}: ${ref.name}`
    const remove = document.createElement('button')
    remove.className = 'remove'
    remove.type = 'button'
    remove.textContent = '✕'
    remove.setAttribute('aria-label', `Remove ${ref.name}`)
    remove.addEventListener('click', () => {
      references.splice(index, 1)
      hide($('referenceError'))
      renderReferences()
    })
    item.append(thumb, remove)
    return item
  }))
  list.hidden = references.length === 0
  const full = references.length >= MAX_REFERENCES
  $('pickReference').disabled = full
  $('pickReference').textContent = full ? 'Full (4)' : references.length ? 'Add…' : 'Attach…'
}

// Same file twice adds nothing but a second upload. Past the cap, say what was
// dropped rather than silently ignoring it.
function addReferences (picked) {
  const known = new Set(references.map((r) => r.path))
  const fresh = picked.filter((r) => r && !known.has(r.path) && known.add(r.path))
  const room = MAX_REFERENCES - references.length
  references.push(...fresh.slice(0, room))
  renderReferences()
  if (fresh.length > room) {
    show($('referenceError'), `Only ${MAX_REFERENCES} reference images fit — ${fresh.length - room} not added.`)
  }
}

async function withReferenceErrors (fn) {
  hide($('referenceError'))
  try {
    await fn()
  } catch (error) {
    // unwrap() renders a refusal from main itself. Anything else — an older
    // window still running the previous preload, a dialog that threw — would
    // otherwise leave the button looking dead.
    if ($('referenceError').hidden) show($('referenceError'), error.message)
  }
}

$('pickReference').addEventListener('click', () => withReferenceErrors(async () => {
  addReferences(unwrap(await api.pickReference(), $('referenceError')) || [])
}))

// A File with a path on disk (Finder drag, copied file) is described where it
// is. One without (a screenshot on the clipboard, an image dragged out of a
// browser) is written to a temp file by main first.
async function ingestFiles (files) {
  const images = [...files].filter((f) => f.type.startsWith('image/') || /\.(png|jpe?g|webp)$/i.test(f.name))
  if (!images.length) throw new Error('Only PNG, JPEG or WebP images can be references.')
  const room = MAX_REFERENCES - references.length
  if (room <= 0) throw new Error(`Already ${MAX_REFERENCES} reference images — remove one first.`)
  const picked = []
  for (const file of images.slice(0, room)) {
    const onDisk = api.pathForFile(file)
    if (onDisk) {
      picked.push(...unwrap(await api.describeReferences({ paths: [onDisk] }), $('referenceError')))
    } else {
      picked.push(unwrap(await api.saveReferenceData({ type: file.type, data: await file.arrayBuffer() }), $('referenceError')))
    }
  }
  addReferences(picked)
  if (images.length > room) {
    show($('referenceError'), `Only ${MAX_REFERENCES} reference images fit — ${images.length - room} not added.`)
  }
}

// Electron navigates the whole window to a file dropped anywhere it is not
// handled, which throws away the session. Swallow every drop; act only on the
// compose card.
const composeCard = $('composeCard')
let dragDepth = 0
const hasFiles = (event) => [...(event.dataTransfer?.types || [])].includes('Files')

document.addEventListener('dragover', (event) => event.preventDefault())
document.addEventListener('drop', (event) => event.preventDefault())

composeCard.addEventListener('dragenter', (event) => {
  if (!hasFiles(event)) return
  dragDepth++
  composeCard.classList.add('dropping')
})
composeCard.addEventListener('dragleave', () => {
  if (dragDepth > 0 && --dragDepth === 0) composeCard.classList.remove('dropping')
})
composeCard.addEventListener('drop', (event) => {
  dragDepth = 0
  composeCard.classList.remove('dropping')
  if (!hasFiles(event)) return
  withReferenceErrors(() => ingestFiles(event.dataTransfer.files))
})

// Paste text into the prompt as usual; only an image on the clipboard becomes
// a reference.
document.addEventListener('paste', (event) => {
  const files = [...(event.clipboardData?.items || [])]
    .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
    .map((item) => item.getAsFile())
    .filter(Boolean)
  if (!files.length) return
  event.preventDefault()
  withReferenceErrors(() => ingestFiles(files))
})

$('generate').addEventListener('click', generate)
$('saveExport').addEventListener('click', saveExport)

// Copies a support summary (versions, Codex state, last error) to the
// clipboard in the main process, then says so on the button for a moment.
async function copyDiagnostics (button) {
  const label = button.textContent
  button.disabled = true
  button.textContent = 'Copying…'
  const result = await api.copyDiagnostics()
  button.textContent = result.ok ? 'Copied' : 'Could not copy'
  setTimeout(() => { button.textContent = label; button.disabled = false }, 2000)
}
$('copyDiagnostics').addEventListener('click', () => copyDiagnostics($('copyDiagnostics')))
$('copyJobDiagnostics').addEventListener('click', () => copyDiagnostics($('copyJobDiagnostics')))

// Cancel kills the running Codex or upscaler process in the main process.
// Images already saved stay; the job's own handler reports the outcome.
async function cancelJob (button, kind) {
  button.disabled = true
  button.textContent = 'Cancelling…'
  await api.cancelJob({ kind })
}
$('cancelJob').addEventListener('click', () => cancelJob($('cancelJob'), 'generate'))
$('cancelExport').addEventListener('click', () => cancelJob($('cancelExport'), 'upscale'))
$('openFolder').addEventListener('click', () => api.reveal({ target: lastJob.jobDir }))

// Settings sidebar: one section at a time. Arrow keys move between tabs.
function showSettingsTab (name) {
  const tabs = [...document.querySelectorAll('.settings-nav [data-tab]')]
  for (const tab of tabs) {
    const on = tab.dataset.tab === name
    tab.setAttribute('aria-selected', String(on))
    tab.tabIndex = on ? 0 : -1
  }
  for (const panel of document.querySelectorAll('.settings-panels [data-panel]')) panel.hidden = panel.dataset.panel !== name
  document.querySelector('.settings-panels').scrollTop = 0
}
function openSettings (tab) {
  if (tab) showSettingsTab(tab)
  $('settingsPane').hidden = false
}
document.querySelector('.settings-nav').addEventListener('click', (e) => {
  const tab = e.target.closest('[data-tab]')
  if (tab) showSettingsTab(tab.dataset.tab)
})
document.querySelector('.settings-nav').addEventListener('keydown', (e) => {
  if (!['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight'].includes(e.key)) return
  const tabs = [...document.querySelectorAll('.settings-nav [data-tab]')]
  const i = tabs.findIndex((t) => t.getAttribute('aria-selected') === 'true')
  const step = e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : -1
  const next = tabs[(i + step + tabs.length) % tabs.length]
  showSettingsTab(next.dataset.tab)
  next.focus()
  e.preventDefault()
})
showSettingsTab('licence')

$('openSettings').addEventListener('click', () => openSettings())
$('closeSettings').addEventListener('click', () => { $('settingsPane').hidden = true })

$('browseFolder').addEventListener('click', async () => {
  const folder = unwrap(await api.pickFolder())
  if (folder) $('outputDir').value = folder
})

$('saveSettings').addEventListener('click', async () => {
  hide($('settingsError'))
  try {
    unwrap(await api.saveSettings({
      outputDir: $('outputDir').value.trim(),
      codexPath: $('codexPath').value,
      iccPath: $('iccPath').value,
      watermarkText: $('watermarkText').value,
      ...headerValues()
    }), $('settingsError'))
    $('settingsMsg').textContent = 'Saved.'
    await loadSettings()
    await detectCodex()
    refreshExportOptions()
    refresh()
  } catch { /* message already rendered */ }
})

boot()
