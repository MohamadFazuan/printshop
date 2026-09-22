'use strict'

const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron')
const path = require('node:path')
const fs = require('node:fs/promises')
const os = require('node:os')
const crypto = require('node:crypto')
const { pathToFileURL } = require('node:url')
const { execFile, spawn } = require('node:child_process')
const { promisify } = require('node:util')

const execFileAsync = promisify(execFile)

// `codex exec` appends piped stdin to the prompt, so stdin must be closed or it
// blocks forever waiting for EOF. execFile leaves it open; spawn with 'ignore'
// does not.
// Windows has no signals, so kill() reaches only the process we spawned. Codex
// launches its own children, and orphaning them leaves the job folder locked
// against the next attempt — which is what made a timeout poison every retry.
function killTree (child) {
  if (process.platform !== 'win32') {
    child.kill('SIGKILL')
    return
  }
  spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    .on('error', () => { child.kill() })
}

function runDetached (bin, args, timeoutMs, onLine) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let pending = ''
    const timer = setTimeout(() => {
      killTree(child)
      const error = new Error(`Timed out after ${Math.round(timeoutMs / 1000)}s.`)
      error.timedOut = true
      reject(error)
    }, timeoutMs)

    child.stdout.on('data', (chunk) => {
      stdout += chunk
      if (!onLine) return
      pending += chunk
      const lines = pending.split('\n')
      pending = lines.pop()
      for (const line of lines) if (line.trim()) onLine(line)
    })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', (error) => { clearTimeout(timer); reject(error) })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve({ stdout, stderr })
      else reject(new Error(stderr.trim() || stdout.trim() || `Exited with code ${code}.`))
    })
  })
}

const sharp = require('sharp')

const {
  PT_PER_UNIT, UNITS, SIZE_PRESETS,
  EXPORT_FORMATS, COLOUR_SPACES, CMYK_CAPABLE,
  renderSizeFor, aspectFor, pngSize, sizeToPoints, buildPdf, slugify, today,
  watermarkSvg, pixelCanvas, clip, classifyFailure, generateInstruction
} = require('./core')

// ---------------------------------------------------------------------------
// Settings. The key is encrypted at rest and never leaves the main process.
// ---------------------------------------------------------------------------

function configPath () {
  return path.join(app.getPath('userData'), 'config.json')
}

function defaultOutputDir () {
  return path.join(os.homedir(), 'Printshop')
}

async function readConfig () {
  try {
    return JSON.parse(await fs.readFile(configPath(), 'utf8'))
  } catch {
    return { outputDir: defaultOutputDir() }
  }
}

async function writeConfig (config) {
  await fs.mkdir(path.dirname(configPath()), { recursive: true })
  await fs.writeFile(configPath(), JSON.stringify(config, null, 2), 'utf8')
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------

function handle (channel, fn) {
  ipcMain.handle(channel, async (_event, payload) => {
    try {
      return { ok: true, data: await fn(payload ?? {}) }
    } catch (error) {
      // Verbatim — a swallowed billing or content-policy error looks like a crash.
      return { ok: false, error: error.message || String(error) }
    }
  })
}

// ---------------------------------------------------------------------------
// Progress. Generation takes minutes on Codex, so silence reads as a hang.
// ---------------------------------------------------------------------------

let mainWindow = null

function emitProgress (payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('job:progress', payload)
}


// Codex JSONL → one human line. Unknown types still report something rather
// than vanishing, so a change in Codex's schema degrades instead of going dark.
function describeCodexEvent (line) {
  let event
  try { event = JSON.parse(line) } catch { return null }

  switch (event.type) {
    case 'thread.started': return 'Codex session started'
    case 'turn.started': return 'Thinking…'
    case 'turn.completed': {
      const used = event.usage?.output_tokens
      return used ? `Turn complete · ${used} output tokens` : 'Turn complete'
    }
    case 'turn.failed': return `Failed: ${clip(event.error?.message || 'unknown error')}`
    case 'item.started':
    case 'item.completed': {
      const item = event.item || {}
      const prefix = event.type === 'item.started' ? '' : '✓ '
      if (item.type === 'agent_message') return item.text ? clip(item.text) : null
      if (item.type === 'reasoning') return `${prefix}Reasoning`
      if (item.type === 'command_execution') return `${prefix}$ ${clip(item.command || '', 90)}`
      if (item.type === 'file_change') return `${prefix}Writing file`
      return `${prefix}${String(item.type || 'step').replace(/_/g, ' ')}`
    }
    default: return null
  }
}

// ---------------------------------------------------------------------------
// Codex CLI — the only engine. Two jobs: rewriting a rough brief into an
// art-directed prompt, and generating the artwork with its built-in image
// model. Both run on the user's ChatGPT login, so there is no API key anywhere
// in this app and nothing is billed per image.
// ---------------------------------------------------------------------------

// npm's Windows install is a codex.cmd batch shim, and Node refuses to spawn
// .cmd/.bat without a shell (CVE-2024-27980) — it throws EINVAL. So every
// Windows path has to point at the real binary the shim would have launched.
const WIN_ARCH = process.arch === 'arm64' ? 'arm64' : 'x64'
const WIN_TRIPLE = process.arch === 'arm64'
  ? 'aarch64-pc-windows-msvc'
  : 'x86_64-pc-windows-msvc'

function vendorExe (npmPrefix) {
  return path.join(
    npmPrefix, 'node_modules', '@openai', 'codex',
    'node_modules', '@openai', `codex-win32-${WIN_ARCH}`,
    'vendor', WIN_TRIPLE, 'bin', 'codex.exe'
  )
}

function unshim (bin) {
  if (process.platform !== 'win32' || !/\.(cmd|bat|ps1)$/i.test(bin)) return [bin]
  return [vendorExe(path.dirname(bin)), bin]
}

const CODEX_CANDIDATES = process.platform === 'win32'
  ? [
      vendorExe(path.join(process.env.APPDATA || '', 'npm')),
      path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Links', 'codex.exe'),
      path.join(process.env.LOCALAPPDATA || '', 'Programs', 'codex', 'codex.exe')
    ]
  : [
      '/opt/homebrew/bin/codex',
      '/usr/local/bin/codex',
      path.join(os.homedir(), '.local/bin/codex'),
      '/usr/bin/codex'
    ]

// A macOS GUI app does not inherit the shell PATH, so `which codex` is useless
// there. A Windows one does inherit the user PATH, which is where npm, nvm and
// pnpm put their shims — so `where` is the only way to find a custom prefix.
async function codexOnPath () {
  if (process.platform !== 'win32') return []
  try {
    const { stdout } = await execFileAsync('where.exe', ['codex'], { timeout: 5000 })
    return stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  } catch { return [] }
}

async function findCodex (override) {
  const tried = new Set()
  for (const raw of [override, ...(await codexOnPath()), ...CODEX_CANDIDATES]) {
    if (!raw) continue
    for (const bin of unshim(raw)) {
      if (tried.has(bin)) continue
      tried.add(bin)
      try {
        const { stdout } = await execFileAsync(bin, ['--version'], { timeout: 10000 })
        return { bin, version: stdout.trim() }
      } catch { /* next candidate */ }
    }
  }
  return null
}

const explainFailure = (raw, context) => classifyFailure(raw, context).message

function enhanceInstruction (brief, size) {
  const orientation = size.landscape ? 'landscape' : 'portrait'
  const dimensions = size.landscape ? `${size.h} × ${size.w}` : `${size.w} × ${size.h}`
  return [
    `You are writing a prompt for an AI image generator. The result will be printed at ${size.label || 'a custom size'} (${dimensions} ${size.unit}), ${orientation}.`,
    'Rewrite the brief below into ONE vivid, art-directed image prompt.',
    'Cover subject, composition, colour palette, lighting and style. Compose for the stated orientation.',
    'Never name the paper size, dimensions, units or DPI in your output — the generator does not understand them and they waste the prompt.',
    '80 words maximum. Output ONLY the prompt text — no preamble, no quotes, no markdown, no explanation.',
    '',
    `Brief: ${brief}`
  ].join('\n')
}

// One agent deviation — wrong filename, artwork drawn in code, a refusal on one
// variant — used to lose the whole job. A second pass asks only for what is
// still missing, so earlier successes survive.
const GENERATE_ATTEMPTS = 2

// macOS grants the working directory write access implicitly under Seatbelt, so
// -C alone was enough there. The Windows sandbox does not: its image tool
// refuses with "the workspace is read-only" even though shell writes succeed.
// Naming the job folder as a writable root fixes that without widening the
// sandbox anywhere else. TOML literal strings are single-quoted and take no
// escapes, which is what a C:\ path needs; a quote in the path forces the
// escaped form instead.
function tomlPath (value) {
  return value.includes("'")
    ? `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
    : `'${value}'`
}

// Codex writes the images itself, inside the job folder, on the ChatGPT plan.
async function generateViaCodex ({ prompt, size, count, jobDir, codexBin, referencePath }) {
  const { wPt, hPt } = sizeToPoints(size)
  const aspect = aspectFor(wPt, hPt)
  const wanted = Array.from({ length: count }, (_, i) => `${String(i + 1).padStart(2, '0')}.png`)
  const pngs = async () => (await fs.readdir(jobDir).catch(() => []))
    .filter((name) => name.toLowerCase().endsWith('.png'))

  // Files landing on disk is the only honest measure of how far along we are —
  // Codex's own chatter says nothing about how many images remain.
  let seen = 0
  const poll = setInterval(async () => {
    const found = (await pngs()).length
    if (found !== seen) {
      seen = found
      emitProgress({ phase: 'image', done: found, total: count })
    }
  }, 1500)

  let lastMessage = ''
  let fatalMessage = ''
  let timedOut = false
  try {
    for (let attempt = 1; attempt <= GENERATE_ATTEMPTS; attempt++) {
      const have = await pngs()
      // Trust the count, not the names — an agent that saved four images under
      // its own naming has still done the job.
      if (have.length >= count) break
      const missing = wanted.filter((name) => !have.includes(name)).slice(0, count - have.length)
      if (!missing.length) break

      if (attempt > 1) {
        emitProgress({ phase: 'retry', attempt, of: GENERATE_ATTEMPTS, missing: missing.length })
      }

      // Each image is its own round trip to OpenAI, so the budget has to scale
      // with how many are outstanding. A flat ceiling made one slow image sit
      // for twenty minutes before saying anything.
      const budgetMs = Math.min(25, 8 * missing.length) * 60 * 1000
      const outFile = path.join(os.tmpdir(), `printshop-codex-${crypto.randomBytes(4).toString('hex')}.txt`)

      // The real cause usually shows up mid-stream — "the workspace is
      // read-only" is reported as Codex works, while the closing message is
      // whatever the agent chose to say about it. Classifying on the final
      // message alone would miss it and retry anyway.
      let streamed = ''

      try {
        await runDetached(codexBin, [
          'exec',
          '--json',
          '--skip-git-repo-check',
          '--ephemeral',
          '--sandbox', 'workspace-write',
          '-c', `sandbox_workspace_write.writable_roots=[${tomlPath(jobDir)}]`,
          // Codex reads the reference itself and attaches it to the prompt, so
          // it never enters the sandbox and never lands in the job folder.
          // `--image` takes a list, so it has to be followed by another flag or
          // it swallows the prompt — hence the `--` before the instruction.
          ...(referencePath ? ['-i', referencePath] : []),
          '--color', 'never',
          '-C', jobDir,
          '-o', outFile,
          '--',
          generateInstruction(prompt, aspect, missing, Boolean(referencePath))
        ], budgetMs, (line) => {
          const text = describeCodexEvent(line)
          if (!text) return
          emitProgress({ phase: 'log', text })
          streamed = `${streamed}\n${text}`.slice(-4000)
        })
        lastMessage = (await fs.readFile(outFile, 'utf8').catch(() => '')).trim()
      } catch (error) {
        // A failed attempt is not a failed job while a retry remains.
        timedOut = Boolean(error.timedOut)
        lastMessage = error.message
      } finally {
        fs.unlink(outFile).catch(() => {})
      }

      // Report the moment the cause is known to be permanent, rather than
      // making the operator sit through a second attempt for the same answer.
      const saved = (await pngs()).length
      if (saved >= count) break
      const verdict = classifyFailure(`${lastMessage}\n${streamed}`, { saved, wanted: count, timedOut })
      if (verdict.fatal) {
        fatalMessage = verdict.message
        break
      }
    }
  } finally {
    clearInterval(poll)
  }

  // Trust the folder, not the filenames it claims — an agent may deviate.
  const files = (await pngs()).sort().map((name) => path.join(jobDir, name))

  if (!files.length) {
    throw new Error(fatalMessage || explainFailure(lastMessage, { saved: 0, wanted: count, timedOut }))
  }
  return { files, shortfall: count - files.length, reason: fatalMessage || lastMessage, timedOut }
}

handle('codex:detect', async () => {
  const config = await readConfig()
  return await findCodex(config.codexPath)
})

// `codex login status` reports on stderr, not stdout — read both or it always
// looks signed out.
async function codexStatus (bin) {
  try {
    const { stdout, stderr } = await runDetached(bin, ['login', 'status'], 20000)
    const text = `${stdout}\n${stderr}`.trim()
    return { loggedIn: /logged in/i.test(text) && !/not logged in/i.test(text), text }
  } catch (error) {
    return { loggedIn: false, text: error.message }
  }
}

handle('codex:status', async () => {
  const config = await readConfig()
  const found = await findCodex(config.codexPath)
  if (!found) return { installed: false, loggedIn: false, text: 'Codex CLI not found.' }
  return { installed: true, ...(await codexStatus(found.bin)) }
})

// `codex login` starts a local callback server and opens the browser. Google
// sign-in is a button on that page — this app never sees the credentials.
handle('codex:login', async () => {
  const config = await readConfig()
  const found = await findCodex(config.codexPath)
  if (!found) throw new Error('Codex CLI not found. Install it, or set its path above.')

  try {
    await runDetached(found.bin, ['login'], 10 * 60 * 1000)
  } catch (error) {
    const status = await codexStatus(found.bin)
    if (!status.loggedIn) throw new Error(error.message)
  }
  return await codexStatus(found.bin)
})

handle('codex:logout', async () => {
  const config = await readConfig()
  const found = await findCodex(config.codexPath)
  if (!found) throw new Error('Codex CLI not found.')
  await runDetached(found.bin, ['logout'], 30000)
  return await codexStatus(found.bin)
})

handle('codex:enhance', async ({ brief, size }) => {
  if (!brief || !brief.trim()) throw new Error('Write a brief first — Codex needs something to work from.')
  const config = await readConfig()
  const found = await findCodex(config.codexPath)
  if (!found) throw new Error('Codex CLI not found. Install it, or set its full path in Settings.')

  const outFile = path.join(os.tmpdir(), `printshop-codex-${crypto.randomBytes(4).toString('hex')}.txt`)
  try {
    await runDetached(found.bin, [
      'exec',
      '--skip-git-repo-check',
      '--ephemeral',
      '--sandbox', 'read-only',
      '--color', 'never',
      '-o', outFile,
      enhanceInstruction(brief.trim(), size)
    ], 180000)

    const text = (await fs.readFile(outFile, 'utf8')).trim()
    if (!text) throw new Error('Codex returned nothing. Check that `codex login` is still valid.')
    return { prompt: text, version: found.version }
  } finally {
    fs.unlink(outFile).catch(() => {})
  }
})

handle('catalog:get', async () => ({
  presets: SIZE_PRESETS,
  units: UNITS,
  ptPerUnit: PT_PER_UNIT,
  formats: EXPORT_FORMATS,
  colourSpaces: COLOUR_SPACES,
  cmykCapable: CMYK_CAPABLE
}))

handle('settings:get', async () => {
  const config = await readConfig()
  return {
    outputDir: config.outputDir || defaultOutputDir(),
    codexPath: config.codexPath || '',
    iccPath: config.iccPath || '',
    watermarkText: config.watermarkText || 'PROOF'
  }
})

handle('settings:save', async ({ outputDir, codexPath, iccPath, watermarkText }) => {
  const config = await readConfig()
  if (outputDir) config.outputDir = outputDir
  if (typeof codexPath === 'string') config.codexPath = codexPath.trim()
  if (typeof iccPath === 'string') config.iccPath = iccPath.trim()
  if (typeof watermarkText === 'string') config.watermarkText = watermarkText
  await writeConfig(config)
  return true
})

handle('settings:pickFolder', async () => {
  const result = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] })
  return result.canceled ? null : result.filePaths[0]
})

handle('settings:pickIcc', async () => {
  const result = await dialog.showOpenDialog({
    properties: ['openFile'],
    filters: [{ name: 'ICC colour profile', extensions: ['icc', 'icm'] }]
  })
  if (result.canceled) return null
  const chosen = result.filePaths[0]
  // Fail here rather than halfway through a press-bound export.
  try {
    await sharp({ create: { width: 8, height: 8, channels: 3, background: '#fff' } })
      .withIccProfile(chosen).toColourspace('cmyk').jpeg().toBuffer()
  } catch (error) {
    throw new Error(`That profile could not be used for a CMYK conversion: ${error.message}`)
  }
  return chosen
})

const REFERENCE_TYPES = ['png', 'jpg', 'jpeg', 'webp']

handle('image:pickReference', async () => {
  const result = await dialog.showOpenDialog({
    properties: ['openFile'],
    filters: [{ name: 'Reference image', extensions: REFERENCE_TYPES }]
  })
  if (result.canceled) return null
  const chosen = result.filePaths[0]
  const { width, height, bytes } = await assertReadable(chosen)
  return {
    path: chosen,
    url: pathToFileURL(chosen).href,
    name: path.basename(chosen),
    width,
    height,
    bytes
  }
})

// The file can go missing between picking it and pressing Generate, and Codex
// reports a bad --image as its own opaque failure minutes in. Check it here.
async function assertReadable (file) {
  const ext = path.extname(file).slice(1).toLowerCase()
  if (!REFERENCE_TYPES.includes(ext)) {
    throw new Error(`A reference has to be a ${REFERENCE_TYPES.join(', ')} image.`)
  }
  let stat
  try {
    stat = await fs.stat(file)
  } catch {
    throw new Error(`That reference image is no longer at ${file}.`)
  }
  if (!stat.isFile() || stat.size === 0) throw new Error('That reference image is empty.')
  // Codex uploads the file as-is; a huge one buys nothing and can stall the job.
  if (stat.size > 20 * 1024 * 1024) {
    throw new Error(`That reference image is ${(stat.size / 1024 / 1024).toFixed(0)} MB. Use one under 20 MB.`)
  }
  // A .png extension proves nothing — a renamed HEIC out of Photos is the usual
  // one. Decode it now rather than letting Codex fail on it minutes into a job.
  try {
    const meta = await sharp(file).metadata()
    return { width: meta.width, height: meta.height, bytes: stat.size }
  } catch (error) {
    throw new Error(`That file could not be read as an image: ${error.message}`)
  }
}

handle('image:generate', async ({ prompt, size, count, referencePath }) => {
  if (!prompt || !prompt.trim()) throw new Error('Prompt is empty.')
  if (referencePath) await assertReadable(referencePath)
  const config = await readConfig()
  const outputDir = config.outputDir || defaultOutputDir()

  const { wPt, hPt } = sizeToPoints(size)
  const renderSize = renderSizeFor(wPt, hPt)
  const n = Math.min(Math.max(Number(count) || 1, 1), 4)

  const jobDir = path.join(outputDir, today(), `${slugify(prompt)}-${crypto.randomBytes(2).toString('hex')}`)
  await fs.mkdir(jobDir, { recursive: true })

  emitProgress({ phase: 'start', total: n, renderSize, reference: referencePath ? path.basename(referencePath) : null })

  let files
  let shortfall = 0
  let reason = ''
  let timedOut = false
  try {
    const found = await findCodex(config.codexPath)
    if (!found) throw new Error('Codex CLI not found. Install it, or set its path in Settings.')
    ;({ files, shortfall, reason, timedOut } = await generateViaCodex({
      prompt: prompt.trim(), size, count: n, jobDir, codexBin: found.bin, referencePath
    }))
  } catch (error) {
    emitProgress({ phase: 'failed', text: error.message })
    // Keep whatever did land — a part-finished job is worth more than a tidy
    // folder. Only clear up when there is genuinely nothing to keep.
    const salvaged = (await fs.readdir(jobDir).catch(() => []))
      .filter((name) => name.toLowerCase().endsWith('.png'))
    if (!salvaged.length) await fs.rm(jobDir, { recursive: true, force: true }).catch(() => {})
    throw error
  }

  emitProgress({
    phase: 'done',
    done: files.length,
    total: n,
    // Say so when fewer arrived than were asked for, rather than presenting a
    // short job as a complete one.
    shortfall,
    note: shortfall > 0 ? explainFailure(reason, { saved: files.length, wanted: n, timedOut }) : ''
  })

  // Codex chooses its own dimensions, so read them rather than assume them.
  const dims = []
  for (const file of files) {
    dims.push(pngSize(await fs.readFile(file)) || { width: 0, height: 0 })
  }

  return {
    jobDir,
    files,
    urls: files.map((file) => pathToFileURL(file).href),
    dims,
    renderSize
  }
})

// Raster exports are rendered at the page size for the chosen DPI, so the DPI
// field means something: A4 at 300 lands 2480 × 3508, at 150 half that.
async function renderRaster ({ file, size, fitMode, format, colour, watermark, iccPath }) {
  const { wPt, hPt } = sizeToPoints(size)
  const { width, height } = pixelCanvas(wPt, hPt, Number(size.dpi) || 300)

  const source = pngSize(await fs.readFile(file))
  const upscale = source ? width / source.width : 1

  let pipeline = sharp(file).resize(width, height, {
    fit: fitMode === 'fit' ? 'contain' : 'cover',
    kernel: 'lanczos3',
    background: { r: 255, g: 255, b: 255, alpha: 1 }
  })

  // Large formats mean scaling a 1024–1536 px render up several times. Lanczos
  // invents no detail, but a light unsharp pass keeps flat-vector edges crisp
  // instead of letting them go to mush. Skip it when barely upscaling.
  if (upscale > 1.5) pipeline = pipeline.sharpen({ sigma: 0.7, m1: 0.6, m2: 2 })

  if (watermark && watermark.text) {
    pipeline = pipeline.composite([{
      input: Buffer.from(watermarkSvg(width, height, watermark.text, watermark.opacity ?? 0.25)),
      blend: 'over'
    }])
  }

  if (colour === 'cmyk') {
    if (format === 'png') throw new Error('PNG cannot hold CMYK — the format has no such colour space. Choose JPEG, TIFF or PDF.')
    if (!iccPath) throw new Error('Set your CMYK profile (.icc) in Settings first — converting without one produces the wrong colours on press.')
    pipeline = pipeline.withIccProfile(iccPath).toColourspace('cmyk')
  }

  if (format === 'png') return pipeline.png().toBuffer()
  if (format === 'tiff') return pipeline.tiff({ compression: 'lzw' }).toBuffer()
  return pipeline.jpeg({ quality: 92, chromaSubsampling: '4:4:4' }).toBuffer()
}

handle('export:save', async ({ file, size, fitMode, format, colour, watermark }) => {
  if (!EXPORT_FORMATS.includes(format)) throw new Error(`Unknown format: ${format}`)
  if (colour === 'cmyk' && !CMYK_CAPABLE.includes(format)) {
    throw new Error(`${format.toUpperCase()} cannot hold CMYK. Choose ${CMYK_CAPABLE.join(', ').toUpperCase()}.`)
  }

  const config = await readConfig()
  const iccPath = config.iccPath || ''
  const jobDir = path.dirname(file)

  // The name has to carry colour space and watermark, or a proof and a
  // press-ready file collide and one silently replaces the other.
  const parts = [path.basename(jobDir), (size.label || 'custom').replace(/[^a-zA-Z0-9]+/g, '')]
  if (colour === 'cmyk') parts.push('CMYK')
  if (watermark && watermark.text) {
    parts.push(watermark.text.replace(/[^a-zA-Z0-9]+/g, '').slice(0, 12).toUpperCase() || 'WM')
  }
  const ext = format === 'jpeg' ? 'jpg' : format

  let outPath = path.join(jobDir, `${parts.join('-')}.${ext}`)
  for (let n = 2; await fs.access(outPath).then(() => true, () => false); n++) {
    outPath = path.join(jobDir, `${parts.join('-')}-${n}.${ext}`)
  }

  if (format === 'pdf') {
    // A CMYK PDF needs CMYK pixels inside it, so the image goes through sharp first.
    const embedded = colour === 'cmyk'
      ? await renderRaster({ file, size, fitMode, format: 'jpeg', colour, watermark: null, iccPath })
      : await fs.readFile(file)
    // Watermark is drawn as vector text on the page, not baked into the raster.
    await fs.writeFile(outPath, await buildPdf(embedded, size, colour === 'cmyk' ? 'fill' : fitMode, watermark, colour))
  } else {
    await fs.writeFile(outPath, await renderRaster({ file, size, fitMode, format, colour, watermark, iccPath }))
  }

  const { size: bytes } = await fs.stat(outPath)
  return { outPath, bytes }
})

handle('shell:reveal', async ({ target }) => {
  const error = await shell.openPath(target)
  if (error) throw new Error(error)
  return true
})

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------

function createWindow () {
  const win = mainWindow = new BrowserWindow({
    width: 940,
    height: 820,
    minWidth: 720,
    minHeight: 600,
    backgroundColor: '#ffffff',
    title: 'Printshop',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'))
}

app.whenReady().then(() => {
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
