'use strict'

const api = window.printshop
const $ = (id) => document.getElementById(id)

let catalog = null
let settings = null
let lastJob = null
let selectedFile = null
let promptBeforeCodex = null
let codexFound = null

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

function renderSizeFor (wPt, hPt) {
  const ratio = wPt / hPt
  if (ratio < 0.9) return '1024x1536'
  if (ratio > 1.1) return '1536x1024'
  return '1024x1024'
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

// PNG is RGB-only by spec, and CMYK needs a profile — say which, not just "no".
function refreshExportOptions () {
  if (!catalog) return
  const format = picked('format')
  const colour = picked('colour')
  const cmykOk = catalog.cmykCapable.includes(format)

  $('colourCmyk').disabled = !cmykOk
  if (!cmykOk && colour === 'cmyk') document.querySelector('input[name="colour"][value="rgb"]').checked = true

  $('watermarkField').hidden = picked('watermark') !== 'on'

  const note = []
  if (!cmykOk) note.push(`${format.toUpperCase()} has no CMYK colour space`)
  else if (picked('colour') === 'cmyk' && !settings?.iccPath) note.push('Set a CMYK profile in Settings before exporting')
  else if (picked('colour') === 'cmyk') note.push(`Using ${settings.iccPath.split('/').pop()}`)
  $('colourNote').textContent = note.join(' · ')
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

  const count = Number($('count').value)
  $('estimate').textContent =
    `No per-image cost — runs on your ChatGPT plan · ${count} × ~${renderSize} · takes minutes`

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

  for (const u of catalog.units) $('customUnit').append(new Option(u, u))
  $('customUnit').value = 'mm'

  await loadSettings()
  await detectCodex()
  await refreshCodexLogin()
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

  if (!codexFound) $('settingsPane').hidden = false
}

async function loadSettings () {
  settings = unwrap(await api.getSettings())
  $('outputDir').value = settings.outputDir
  $('iccPath').value = settings.iccPath || ''
  $('watermarkText').value = settings.watermarkText || 'PROOF'
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
  $('progressTitle').textContent = title
  paintProgress()
}

api.onProgress((event) => {
  if (event.phase === 'start') {
    startProgress(event.total)
    appendLog(`Codex CLI · ${event.total} × ${event.renderSize}`)
  } else if (event.phase === 'log') {
    appendLog(event.text)
  } else if (event.phase === 'image') {
    jobDone = event.done
    appendLog(`Image ${event.done} of ${event.total} written`)
    paintProgress()
  } else if (event.phase === 'done') {
    jobDone = event.done
    stopProgress('Done')
    appendLog('Finished')
  } else if (event.phase === 'failed') {
    stopProgress('Failed')
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
  // Clear the previous job so nothing on screen belongs to an older run.
  $('resultsCard').hidden = true
  $('savedCard').hidden = true

  try {
    const job = unwrap(await api.generate({
      prompt: $('prompt').value,
      size: currentSize(),
      count: Number($('count').value)
    }), $('genError'))

    lastJob = job
    selectedFile = null
    renderGrid(job)
    $('resultsCard').hidden = false
    $('savedCard').hidden = true
  } catch { /* message already rendered */ } finally {
    button.textContent = original
    refresh()
  }
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
      for (const node of grid.querySelectorAll('.thumb')) node.classList.remove('selected')
      button.classList.add('selected')
      $('selectedLabel').textContent = `Selected variant ${index + 1}`
      $('saveExport').disabled = false
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

    wrap.append(button, zoom)
    grid.append(wrap)
  })

  // The DPI shown before generating was a prediction; this is what actually landed.
  const dim = job.dims?.[0]
  const measured = dim?.width
    ? (() => {
        const { wPt, hPt } = pointsOf(currentSize())
        const scale = fitMode() === 'fit'
          ? Math.min(wPt / dim.width, hPt / dim.height)
          : Math.max(wPt / dim.width, hPt / dim.height)
        const dpi = Math.round(72 / scale)
        const advice = dpiAdvice(wPt, hPt, dpi)
        return ` · ${dim.width} × ${dim.height} px → ${dpi} DPI on this page${advice.ok ? '' : ` (below the ${advice.warn} DPI this size wants)`}`
      })()
    : ''

  $('selectedLabel').textContent =
    `${job.files.length} image${job.files.length > 1 ? 's' : ''} saved${measured} — click one`
  $('saveExport').disabled = true
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
  button.textContent = 'Exporting…'
  hide($('pdfError'))

  try {
    const { outPath, bytes } = unwrap(await api.saveExport({
      file: selectedFile,
      size: currentSize(),
      fitMode: fitMode(),
      format: picked('format'),
      colour: picked('colour'),
      watermark: watermark()
    }), $('pdfError'))

    const kept = lastJob.files.length
    $('savedPath').textContent = outPath
    $('savedNote').textContent =
      `${(bytes / 1024 / 1024).toFixed(1)} MB · ${picked('colour').toUpperCase()}` +
      `${watermark() ? ' · watermarked' : ''} · all ${kept} generated image${kept > 1 ? 's are' : ' is'} kept in the same folder.`
    $('savedCard').hidden = false
  } catch { /* message already rendered */ } finally {
    button.disabled = false
    button.textContent = 'Export'
  }
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

for (const id of ['preset', 'landscape', 'customW', 'customH', 'customUnit', 'dpi', 'count', 'prompt']) {
  $(id).addEventListener('input', refresh)
}

for (const radio of document.querySelectorAll('input[name="fit"]')) radio.addEventListener('change', refresh)
$('watermarkText').addEventListener('input', refreshExportOptions)

$('preset').addEventListener('change', () => {
  $('customRow').hidden = $('preset').value !== 'custom'
  refresh()
})

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

for (const group of ['format', 'colour', 'watermark']) {
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

$('generate').addEventListener('click', generate)
$('saveExport').addEventListener('click', saveExport)
$('openFolder').addEventListener('click', () => api.reveal({ target: lastJob.jobDir }))

$('openSettings').addEventListener('click', () => { $('settingsPane').hidden = false })
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
      watermarkText: $('watermarkText').value
    }), $('settingsError'))
    $('settingsMsg').textContent = 'Saved.'
    await loadSettings()
    await detectCodex()
    refreshExportOptions()
    refresh()
  } catch { /* message already rendered */ }
})

boot()
