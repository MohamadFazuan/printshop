'use strict'

const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron')
const path = require('node:path')
const fs = require('node:fs/promises')
const os = require('node:os')
const crypto = require('node:crypto')
const { pathToFileURL } = require('node:url')
const { execFile, spawn } = require('node:child_process')
const { promisify } = require('node:util')
const QRCode = require('qrcode')

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
  watermarkSvg, pixelCanvas, clip, classifyFailure, generateInstruction, upscalePlan,
  stickerImageRect, stickerLayout, buildHeaderProof, HEADER_LAYOUTS
} = require('./core')
const {
  CUT_KINDS, CUT_LABELS, BLEED_PT, MM, CONTOUR_OFFSETS_MM, DEFAULT_OFFSET_MM, SHEETS,
  subjectMask, contourCutPath, fitContourRect, shapeCutPath, pathToSvg,
  clampInset, MARK_INSET_PT, MARK_INSET_MIN_MM, MARK_INSET_MAX_MM, clampHeaderHeight, SHEETS: SHEET_SIZES
} = require('./cutline')

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
// nvm installs codex under a per-Node-version prefix that no fixed candidate
// covers. Its bin/codex is a `#!/usr/bin/env node` script, which fails without
// the shell PATH, so point at the native binary bundled inside the package.
const POSIX_TRIPLE = {
  'darwin-arm64': 'aarch64-apple-darwin',
  'darwin-x64': 'x86_64-apple-darwin',
  'linux-arm64': 'aarch64-unknown-linux-musl',
  'linux-x64': 'x86_64-unknown-linux-musl'
}[`${process.platform}-${process.arch}`]

const versionKey = (v) => v.replace(/^v/, '').split('.').map(Number)
const newestFirst = (a, b) => {
  const [x, y] = [versionKey(a), versionKey(b)]
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return (y[i] || 0) - (x[i] || 0)
  return 0
}

async function nvmCandidates () {
  if (process.platform === 'win32' || !POSIX_TRIPLE) return []
  const root = path.join(process.env.NVM_DIR || path.join(os.homedir(), '.nvm'), 'versions', 'node')
  let versions
  try { versions = await fs.readdir(root) } catch { return [] }
  return versions.sort(newestFirst).map((v) => path.join(
    root, v, 'lib', 'node_modules', '@openai', 'codex',
    'node_modules', '@openai', `codex-${process.platform}-${process.arch}`,
    'vendor', POSIX_TRIPLE, 'bin', 'codex'
  ))
}

async function codexOnPath () {
  if (process.platform !== 'win32') return []
  try {
    const { stdout } = await execFileAsync('where.exe', ['codex'], { timeout: 5000 })
    return stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  } catch { return [] }
}

async function findCodex (override) {
  const tried = new Set()
  for (const raw of [override, ...(await codexOnPath()), ...CODEX_CANDIDATES, ...(await nvmCandidates())]) {
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

// The operator's own ~/.codex/config.toml — plugins, notify hooks, a model
// picked for coding — otherwise rides along on every job. Measured: a personal
// plugin added ~230 events of file reads before the image was even attempted,
// and a different config on another machine would give a different result.
// Login lives outside config.toml, so auth is unaffected.
const ISOLATE_CODEX = ['--ignore-user-config']

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
async function generateViaCodex ({ prompt, size, count, jobDir, codexBin, referencePaths = [], cut = 'none' }) {
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
          ...ISOLATE_CODEX,
          '--sandbox', 'workspace-write',
          '-c', `sandbox_workspace_write.writable_roots=[${tomlPath(jobDir)}]`,
          // Codex reads the references itself and attaches them to the prompt,
          // so they never enter the sandbox and never land in the job folder.
          // `--image` takes a list, so it has to be followed by another flag or
          // it swallows the prompt — hence the `--` before the instruction.
          ...(referencePaths.length ? ['-i', ...referencePaths] : []),
          '--color', 'never',
          '-C', jobDir,
          '-o', outFile,
          '--',
          generateInstruction(prompt, aspect, missing, referencePaths.length, cut)
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
      ...ISOLATE_CODEX,
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
  cmykCapable: CMYK_CAPABLE,
  cutKinds: CUT_KINDS.map((id) => ({ id, label: CUT_LABELS[id] })),
  contourOffsetsMm: CONTOUR_OFFSETS_MM,
  defaultOffsetMm: DEFAULT_OFFSET_MM,
  sheets: Object.entries(SHEETS).map(([id, sheet]) => ({ id, label: sheet.label })),
  markInset: { defaultMm: MARK_INSET_PT / MM, minMm: MARK_INSET_MIN_MM, maxMm: MARK_INSET_MAX_MM }
}))

handle('settings:get', async () => {
  const config = await readConfig()
  return {
    outputDir: config.outputDir || defaultOutputDir(),
    codexPath: config.codexPath || '',
    iccPath: config.iccPath || '',
    watermarkText: config.watermarkText || 'PROOF',
    ...Object.fromEntries(HEADER_KEYS.map((key) => [key, config[key] ?? ''])),
    headerLabel: config.headerLabel ?? 'Untuk Tempahan:',
    headerLayout: config.headerLayout || 'brand-left',
    headerHeightMm: config.headerHeightMm || 15,
    headerNameScale: config.headerNameScale || 100,
    headerContactScale: config.headerContactScale || 100,
    headerColor: config.headerColor || '#000000',
    headerFont: config.headerFont || 'helvetica'
  }
})

handle('settings:save', async (payload) => {
  const { outputDir, codexPath, iccPath, watermarkText } = payload
  const config = await readConfig()
  for (const key of HEADER_KEYS) {
    if (typeof payload[key] === 'string' || typeof payload[key] === 'number') config[key] = typeof payload[key] === 'string' ? payload[key].trim() : payload[key]
  }
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

handle('settings:pickLogo', async () => {
  const result = await dialog.showOpenDialog({
    properties: ['openFile'],
    filters: [{ name: 'Logo image', extensions: ['png', 'jpg', 'jpeg', 'webp', 'svg', 'tif', 'tiff'] }]
  })
  if (result.canceled) return null
  const chosen = result.filePaths[0]
  try {
    await sharp(chosen).metadata()
  } catch (error) {
    throw new Error(`That file could not be read as an image: ${error.message}`)
  }
  return chosen
})

handle('settings:pickFont', async () => {
  const result = await dialog.showOpenDialog({
    properties: ['openFile'],
    filters: [{ name: 'Font file', extensions: ['ttf', 'otf'] }]
  })
  if (result.canceled) return null
  const chosen = result.filePaths[0]
  try {
    require('@pdf-lib/fontkit').create(await fs.readFile(chosen))
  } catch (error) {
    throw new Error(`That file could not be read as a font: ${error.message}`)
  }
  return chosen
})

// Prints the header, as typed in Settings, on a blank sheet and opens it.
handle('header:test', async ({ values, sheet, markInsetMm }) => {
  const header = await sheetHeaderData(values)
  if (!header) throw new Error('The header is empty. Fill in at least a shop name, phone, QR link or logo.')
  const key = SHEET_SIZES[sheet] && sheet !== 'single' ? sheet : 'a4'
  const bytes = await buildHeaderProof(key, header, { marks: true, insetPt: clampInset(Number(markInsetMm || 10) * MM) })
  const config = await readConfig()
  const dir = config.outputDir || defaultOutputDir()
  await fs.mkdir(dir, { recursive: true })
  const out = path.join(dir, `header-test-${key.toUpperCase()}.pdf`)
  await fs.writeFile(out, bytes)
  await shell.openPath(out)
  return out
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
// Each one is uploaded with every generation attempt; past a handful the
// agent averages them into mud rather than taking more from each.
const MAX_REFERENCES = 4
const MAX_REFERENCE_BYTES = 20 * 1024 * 1024

async function describeReference (file) {
  const { width, height, bytes } = await assertReadable(file)
  return {
    path: file,
    url: pathToFileURL(file).href,
    name: path.basename(file),
    width,
    height,
    bytes
  }
}

handle('image:pickReference', async () => {
  const result = await dialog.showOpenDialog({
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Reference image', extensions: REFERENCE_TYPES }]
  })
  if (result.canceled) return []
  return Promise.all(result.filePaths.slice(0, MAX_REFERENCES).map(describeReference))
})

// Dropped or pasted files arrive as paths the renderer read off the File.
handle('image:describeReferences', async ({ paths }) => {
  if (!Array.isArray(paths)) throw new Error('No files were given.')
  return Promise.all(paths.filter((p) => typeof p === 'string' && p)
    .slice(0, MAX_REFERENCES).map(describeReference))
})

// A pasted screenshot has no file behind it, and Codex only takes paths. Write
// the bytes to a temp file, outside every job folder, and treat that as the
// reference. sharp decodes it in assertReadable, so a bad paste fails here.
const PASTE_TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' }

const PASTED_DIR = () => path.join(app.getPath('temp'), 'printshop-references')
const PASTED_MAX_AGE_MS = 24 * 60 * 60 * 1000

// A pasted reference is only needed while it sits in the list, and the list
// does not survive a restart. Anything a day old is orphaned; clear it at launch.
async function prunePastedReferences () {
  const dir = PASTED_DIR()
  let names
  try { names = await fs.readdir(dir) } catch { return }
  const cutoff = Date.now() - PASTED_MAX_AGE_MS
  await Promise.all(names.filter((n) => n.startsWith('pasted-')).map(async (name) => {
    const file = path.join(dir, name)
    try {
      if ((await fs.stat(file)).mtimeMs < cutoff) await fs.unlink(file)
    } catch { /* already gone, or in use — try again next launch */ }
  }))
}

handle('image:saveReferenceData', async ({ type, data }) => {
  const ext = PASTE_TYPES[type]
  if (!ext) throw new Error(`A pasted reference has to be PNG, JPEG or WebP, not ${type || 'unknown'}.`)
  const buffer = Buffer.from(data instanceof ArrayBuffer ? new Uint8Array(data) : data || [])
  if (!buffer.length) throw new Error('The pasted image is empty.')
  if (buffer.length > MAX_REFERENCE_BYTES) {
    throw new Error(`That pasted image is ${(buffer.length / 1024 / 1024).toFixed(0)} MB. Use one under 20 MB.`)
  }
  const dir = PASTED_DIR()
  await fs.mkdir(dir, { recursive: true })
  const file = path.join(dir, `pasted-${today()}-${crypto.randomBytes(3).toString('hex')}.${ext}`)
  await fs.writeFile(file, buffer)
  return describeReference(file)
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
  if (stat.size > MAX_REFERENCE_BYTES) {
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

handle('image:generate', async ({ prompt, size, count, referencePaths, referencePath, cut }) => {
  if (!prompt || !prompt.trim()) throw new Error('Prompt is empty.')
  // referencePath is the single-reference payload an older renderer sends.
  const refs = [...new Set((Array.isArray(referencePaths) ? referencePaths : [referencePath])
    .filter((p) => typeof p === 'string' && p))]
  if (refs.length > MAX_REFERENCES) throw new Error(`Attach at most ${MAX_REFERENCES} reference images.`)
  for (const ref of refs) await assertReadable(ref)
  const config = await readConfig()
  const outputDir = config.outputDir || defaultOutputDir()

  const { wPt, hPt } = sizeToPoints(size)
  const renderSize = renderSizeFor(wPt, hPt)
  const n = Math.min(Math.max(Number(count) || 1, 1), 4)

  const jobDir = path.join(outputDir, today(), `${slugify(prompt)}-${crypto.randomBytes(2).toString('hex')}`)
  await fs.mkdir(jobDir, { recursive: true })

  emitProgress({ phase: 'start', total: n, renderSize, reference: refs.length ? refs.map((p) => path.basename(p)).join(', ') : null })

  let files
  let shortfall = 0
  let reason = ''
  let timedOut = false
  try {
    const found = await findCodex(config.codexPath)
    if (!found) throw new Error('Codex CLI not found. Install it, or set its path in Settings.')
    ;({ files, shortfall, reason, timedOut } = await generateViaCodex({
      prompt: prompt.trim(), size, count: n, jobDir, codexBin: found.bin, referencePaths: refs,
      cut: CUT_KINDS.includes(cut) ? cut : 'none'
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

// ---------------------------------------------------------------------------
// AI upscaling. Codex renders top out near 1.5 MP — about 128 DPI on A4 — so a
// print-sized page needs more pixels than the model gives. Real-ESRGAN
// (ncnn-vulkan, BSD-3) adds real detail on the GPU, where a resize would only
// blur. It ships in the installer as an extra resource; in development
// `npm run fetch-upscaler` puts it in vendor/.
// ---------------------------------------------------------------------------

const UPSCALER_BIN = process.platform === 'win32' ? 'realesrgan-ncnn-vulkan.exe' : 'realesrgan-ncnn-vulkan'
const UPSCALER_MODEL = 'realesrgan-x4plus'
// Measured on an M-series Mac: ~90 s for a 1055 × 1491 render. Integrated or
// older GPUs can be several times slower, so the budget is generous.
const UPSCALE_TIMEOUT_MS = 10 * 60 * 1000

async function findUpscaler () {
  const osKey = { darwin: 'mac', win32: 'win' }[process.platform]
  if (!osKey) return null
  const dir = app.isPackaged
    ? path.join(process.resourcesPath, 'upscaler')
    : path.join(__dirname, '..', 'vendor', 'upscaler', osKey)
  const bin = path.join(dir, UPSCALER_BIN)
  const models = path.join(dir, 'models')
  try {
    await fs.access(bin)
    await fs.access(path.join(models, `${UPSCALER_MODEL}.bin`))
    return { bin, models }
  } catch { return null }
}

handle('upscale:status', async () => ({ available: Boolean(await findUpscaler()) }))

// The ncnn binary prints its progress ("41.67%") on stderr and exits 0 even
// when it failed — a GPU out of memory, an unreadable input — so success is
// judged by the file it leaves behind, never by the exit code.
function runUpscaler ({ bin, models }, input, output, onPercent) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, ['-i', input, '-o', output, '-n', UPSCALER_MODEL, '-m', models],
      { stdio: ['ignore', 'pipe', 'pipe'] })
    let tail = ''
    const timer = setTimeout(() => {
      killTree(child)
      reject(new Error(`Upscaling took longer than ${UPSCALE_TIMEOUT_MS / 60000} minutes and was stopped.`))
    }, UPSCALE_TIMEOUT_MS)
    child.stderr.on('data', (chunk) => {
      const text = String(chunk)
      tail = `${tail}${text}`.slice(-2000)
      const matches = text.match(/(\d+(?:\.\d+)?)%/g)
      if (matches) onPercent(parseFloat(matches[matches.length - 1]))
    })
    child.stdout.on('data', () => {})
    child.on('error', (error) => { clearTimeout(timer); reject(error) })
    child.on('close', () => { clearTimeout(timer); resolve(tail) })
  })
}

// Returns the file to export from: the original when it already meets the
// page's DPI, otherwise an upscaled copy sized to the page. Cached per size,
// because the same variant is often exported several ways in a row.
async function upscaledFor (file, size, fitMode) {
  const meta = await sharp(file).metadata()
  const { wPt, hPt } = sizeToPoints(size)
  const plan = upscalePlan(meta.width, meta.height, wPt, hPt, fitMode)
  if (!plan.needed) return { file, plan }

  // A subfolder, not the job folder itself: every .png there counts as a variant.
  const dir = path.join(path.dirname(file), 'upscaled')
  const base = path.basename(file, path.extname(file))
  const target = path.join(dir, `${base}-${plan.width}x${plan.height}.png`)
  if (await fs.access(target).then(() => true, () => false)) return { file: target, plan }

  const upscaler = await findUpscaler()
  if (!upscaler) throw new Error('The AI upscaler is not installed with this copy of Printshop. Export without upscaling, or reinstall.')

  await fs.mkdir(dir, { recursive: true })
  const raw = path.join(dir, `.${base}-x4-${crypto.randomBytes(3).toString('hex')}.png`)
  try {
    emitProgress({ phase: 'upscale', percent: 0 })
    const tail = await runUpscaler(upscaler, file, raw, (percent) => emitProgress({ phase: 'upscale', percent }))
    let out
    try { out = await sharp(raw).metadata() } catch { out = null }
    if (!out || out.width !== meta.width * 4 || out.height !== meta.height * 4) {
      const why = /OUT_OF_DEVICE_MEMORY|OutOfMemory|Insufficient Memory/i.test(tail)
        ? 'the graphics chip ran out of memory'
        : (tail.split('\n').map((l) => l.trim()).filter((l) => l && !/^\d+(\.\d+)?%$/.test(l)).pop() || 'no image came back')
      throw new Error(`AI upscaling failed: ${why}.`)
    }
    // 4× usually overshoots the page; bring it down to what the page needs so
    // the export is not four times the size it has to be.
    await sharp(raw).resize(plan.width, plan.height, { kernel: 'lanczos3' }).png().toFile(target)
    return { file: target, plan }
  } finally {
    fs.unlink(raw).catch(() => {})
  }
}

// ---------------------------------------------------------------------------
// Cut lines. The geometry is worked out from the variant as generated — an
// upscaled copy has the same shape, so tracing the smaller file is faster and
// lands on the same line.
// ---------------------------------------------------------------------------

// The trace runs at up to this many pixels on the long side: finer than any
// blade follows on a sticker, and quick in plain JS.
const TRACE_MAX_PX = 1000

// Every Settings key the sticker-sheet header reads.
const HEADER_KEYS = [
  'headerName', 'headerTagline', 'headerLabel', 'headerPhone', 'headerExtra', 'headerQr', 'headerLogoPath',
  'headerLayout', 'headerHeightMm', 'headerNameScale', 'headerContactScale', 'headerColor', 'headerFont', 'headerFontPath'
]

// The shop's own header for sticker sheets. Null when nothing is set.
// `values` lets the Settings test print use what is typed but not yet saved.
async function sheetHeaderData (values = null) {
  const config = values || await readConfig()
  const str = (key) => String(config[key] ?? '').trim()
  const name = str('headerName')
  const tagline = str('headerTagline')
  const phone = str('headerPhone')
  const extra = str('headerExtra')
  const qrText = str('headerQr')
  const logoPath = str('headerLogoPath')
  if (!name && !tagline && !phone && !extra && !qrText && !logoPath) return null

  let logo = null
  if (logoPath) {
    try {
      // Any format sharp reads goes in as PNG, small enough for a header strip.
      logo = await sharp(logoPath).resize({ height: 600, withoutEnlargement: true }).png().toBuffer()
    } catch (error) {
      throw new Error(`The header logo could not be read (${logoPath}): ${error.message}`)
    }
  }
  let qr = null
  if (qrText) {
    const code = QRCode.create(qrText, { errorCorrectionLevel: 'M' })
    qr = { size: code.modules.size, data: Array.from(code.modules.data) }
  }

  let fontBytes = null
  if (str('headerFont') === 'custom') {
    const fontPath = str('headerFontPath')
    if (!fontPath) throw new Error('The header font is set to a font file, but none is chosen. Pick one in Settings or choose a built-in font.')
    if (!/\.(ttf|otf)$/i.test(fontPath)) throw new Error('The header font must be a single .ttf or .otf file (font collections like .ttc are not supported).')
    try {
      fontBytes = await fs.readFile(fontPath)
    } catch (error) {
      throw new Error(`The header font could not be read (${fontPath}): ${error.message}`)
    }
    // A missing glyph prints as an empty box; catch it here, by name.
    const face = require('@pdf-lib/fontkit').create(fontBytes)
    for (const [field, text] of [['shop name', name], ['tagline', tagline], ['order label', str('headerLabel')], ['phone', phone], ['extra line', extra]]) {
      const missing = [...text].filter((ch) => ch.trim() && !face.hasGlyphForCodePoint(ch.codePointAt(0)))
      if (missing.length) throw new Error(`The font ${path.basename(fontPath)} has no ${[...new Set(missing)].join(' ')} for the header's ${field}. Choose a font that covers it.`)
    }
  }

  return {
    name,
    tagline,
    label: phone ? (config.headerLabel ?? 'Untuk Tempahan:') : str('headerLabel'),
    phone,
    extra,
    logo,
    qr,
    layout: str('headerLayout') || 'brand-left',
    heightPt: clampHeaderHeight(Number(config.headerHeightMm || 15) * MM),
    nameScale: Number(config.headerNameScale) || 100,
    contactScale: Number(config.headerContactScale) || 100,
    color: str('headerColor') || '#000000',
    font: str('headerFont') === 'custom' ? 'helvetica' : (str('headerFont') || 'helvetica'),
    fontBytes
  }
}

async function cutFor (file, size, fitMode, cut) {
  const kind = cut && cut.kind
  if (!CUT_KINDS.includes(kind) || kind === 'none') return null
  const sheet = SHEETS[cut.sheet] ? cut.sheet : 'single'
  const { wPt, hPt } = sizeToPoints(size)

  // Cutting marks and the shop header only belong on a sheet.
  const onSheet = sheet !== 'single'
  const extras = {
    pattern: onSheet && kind === 'circle' && cut.pattern === 'staggered' ? 'staggered' : 'grid',
    markInsetPt: clampInset(Number(cut.markInsetMm ?? MARK_INSET_PT / MM) * MM),
    marks: onSheet && cut.marks !== false,
    header: onSheet && cut.header ? await sheetHeaderData() : null,
    headerWanted: onSheet && Boolean(cut.header)
  }

  if (kind !== 'contour') {
    return { kind, sheet, bleedPt: BLEED_PT, path: shapeCutPath(kind, wPt, hPt), pieces: 1, ignored: 0, ...extras }
  }

  const offsetMm = CONTOUR_OFFSETS_MM.includes(Number(cut.offsetMm)) ? Number(cut.offsetMm) : DEFAULT_OFFSET_MM
  const meta = await sharp(file).metadata()
  const scale = Math.min(1, TRACE_MAX_PX / Math.max(meta.width, meta.height))
  const tw = Math.max(1, Math.round(meta.width * scale))
  const th = Math.max(1, Math.round(meta.height * scale))
  const { data } = await sharp(file).resize(tw, th, { fit: 'fill' }).ensureAlpha().raw()
    .toBuffer({ resolveWithObject: true })
  const mask = subjectMask(data, tw, th)

  let filled = 0
  for (let i = 0; i < mask.length; i++) filled += mask[i]
  if (filled / mask.length > 0.97) {
    throw new Error('A contour cut needs the artwork on plain white, but this variant fills the whole frame. ' +
      'Choose a shape cut, or set Cut line to Contour before generating so the brief asks for a white background.')
  }

  const placed = stickerImageRect(meta.width, meta.height, wPt, hPt, fitMode, BLEED_PT)
  const trim = { w: wPt, h: hPt }
  const { rect, scale: fitScale } = fitContourRect({ mask, width: tw, height: th }, placed, offsetMm * MM, trim)
  const traced = contourCutPath({ mask, width: tw, height: th }, rect, offsetMm * MM, trim)
  // The PDF must place the image exactly where it was traced.
  return { kind, sheet, bleedPt: BLEED_PT, offsetMm, imageRect: rect, shrunk: fitScale < 1 ? Math.round((1 - fitScale) * 100) : 0, ...traced, ...extras }
}

handle('cut:preview', async ({ file, size, fitMode, cut }) => {
  const geometry = await cutFor(file, size, fitMode, cut)
  if (!geometry) return null
  const meta = await sharp(file).metadata()
  const layout = stickerLayout(size, geometry)
  const b = geometry.bleedPt
  const boxW = layout.cellW
  const boxH = layout.cellH
  const rect = geometry.imageRect || stickerImageRect(meta.width, meta.height, layout.wPt, layout.hPt, fitMode, b)
  // SVG is y down; the preview draws one sticker's bleed box.
  const shifted = geometry.path.map((cmd) => cmd[0] === 'Z'
    ? cmd
    : [cmd[0], ...cmd.slice(1).map((v, i) => v + b)])
  return {
    boxW,
    boxH,
    trim: { x: b, y: b, w: layout.wPt, h: layout.hPt },
    image: { x: b + rect.x, y: boxH - (b + rect.y + rect.height), w: rect.width, h: rect.height },
    d: pathToSvg(shifted, boxH),
    pieces: geometry.pieces,
    ignored: geometry.ignored,
    shrunk: geometry.shrunk || 0,
    count: layout.count,
    cols: layout.cols,
    rows: layout.rows,
    sheet: geometry.sheet === 'single' ? null : sheetPreview(layout, geometry)
  }
})

// Whole-sheet thumbnail data: cell boxes, marks and the header strip, in SVG coordinates.
function sheetPreview (layout, geometry) {
  const H = layout.pageH
  const marks = layout.marks.map((line) => line.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)} ${(H - y).toFixed(1)}`).join('')).join('')
  return {
    pageW: layout.pageW,
    pageH: H,
    cellW: layout.cellW,
    cellH: layout.cellH,
    cells: layout.cells.map((c) => ({ x: c.x, y: H - c.y - layout.cellH })),
    marks,
    pattern: layout.pattern,
    header: layout.header ? { x: layout.header.x, y: H - layout.header.y - layout.header.h, w: layout.header.w, h: layout.header.h } : null,
    headerMissing: Boolean(geometry.headerWanted && !geometry.header)
  }
}

handle('export:save', async ({ file, size, fitMode, format, colour, watermark, upscale, cut }) => {
  if (!EXPORT_FORMATS.includes(format)) throw new Error(`Unknown format: ${format}`)
  if (colour === 'cmyk' && !CMYK_CAPABLE.includes(format)) {
    throw new Error(`${format.toUpperCase()} cannot hold CMYK. Choose ${CMYK_CAPABLE.join(', ').toUpperCase()}.`)
  }

  const config = await readConfig()
  const iccPath = config.iccPath || ''
  const jobDir = path.dirname(file)

  // Traced from the variant before any upscale, so it matches what was previewed.
  const cutGeometry = await cutFor(file, size, fitMode, cut)
  if (cutGeometry && format !== 'pdf') {
    throw new Error('A cut line needs PDF — the cutter reads it as a vector path, which PNG, JPEG and TIFF cannot carry.')
  }

  let upscaled = null
  if (upscale) {
    const result = await upscaledFor(file, size, fitMode)
    if (result.file !== file) upscaled = { dpi: result.plan.reachedDpi, from: result.plan.dpi }
    file = result.file
  }

  // The name has to carry colour space and watermark, or a proof and a
  // press-ready file collide and one silently replaces the other.
  const parts = [path.basename(jobDir), (size.label || 'custom').replace(/[^a-zA-Z0-9]+/g, '')]
  if (colour === 'cmyk') parts.push('CMYK')
  if (upscaled) parts.push('AI')
  if (cutGeometry) {
    parts.push('CUT')
    if (cutGeometry.sheet !== 'single') parts.push(`${cutGeometry.sheet.toUpperCase()}SHEET`)
    if (cutGeometry.sheet !== 'single' && cutGeometry.pattern === 'staggered') parts.push('STAGGER')
    if (cutGeometry.marks) parts.push('MARKS')
  }
  if (watermark && watermark.text) {
    parts.push(watermark.text.replace(/[^a-zA-Z0-9]+/g, '').slice(0, 12).toUpperCase() || 'WM')
  }
  const ext = format === 'jpeg' ? 'jpg' : format

  let outPath = path.join(jobDir, `${parts.join('-')}.${ext}`)
  for (let n = 2; await fs.access(outPath).then(() => true, () => false); n++) {
    outPath = path.join(jobDir, `${parts.join('-')}-${n}.${ext}`)
  }

  let sheetCount = null
  if (cutGeometry) {
    // The image is placed per sticker, so it goes in as is — CMYK or not —
    // rather than pre-rendered to one page canvas.
    let embedded
    if (colour === 'cmyk') {
      if (!iccPath) throw new Error('Set your CMYK profile (.icc) in Settings first — converting without one produces the wrong colours on press.')
      embedded = await sharp(file).flatten({ background: '#ffffff' }).withIccProfile(iccPath).toColourspace('cmyk')
        .jpeg({ quality: 92, chromaSubsampling: '4:4:4' }).toBuffer()
    } else {
      embedded = await fs.readFile(file)
    }
    await fs.writeFile(outPath, await buildPdf(embedded, size, fitMode, watermark, colour, cutGeometry))
    sheetCount = stickerLayout(size, cutGeometry).count
  } else if (format === 'pdf') {
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
  return {
    outPath,
    bytes,
    upscaled,
    cut: cutGeometry ? { kind: cutGeometry.kind, count: sheetCount, pieces: cutGeometry.pieces, marks: Boolean(cutGeometry.marks), header: Boolean(cutGeometry.header) } : null
  }
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
    width: 1200,
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
  prunePastedReferences()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
