'use strict'

// Downloads Real-ESRGAN (ncnn-vulkan build, BSD-3-Clause) into
// vendor/upscaler/<os>/, where electron-builder picks it up as an extra
// resource. The binaries are ~50 MB per platform, so they are fetched rather
// than committed, and pinned by SHA-256 so a swapped release cannot slip in.
//
//   node scripts/fetch-upscaler.js          this machine's platform
//   node scripts/fetch-upscaler.js --all    macOS and Windows

const fs = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const crypto = require('node:crypto')
const { execFileSync } = require('node:child_process')

const RELEASE = 'https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.5.0'

// Keys are electron-builder's ${os} macro values, so package.json can map
// vendor/upscaler/${os} straight into the app's resources.
const BUILDS = {
  mac: {
    zip: 'realesrgan-ncnn-vulkan-20220424-macos.zip',
    sha256: 'e0ad05580abfeb25f8d8fb55aaf7bedf552c375b5b4d9bd3c8d59764d2cc333a',
    // Universal (x86_64 + arm64), so one copy serves both mac installers.
    files: ['realesrgan-ncnn-vulkan']
  },
  win: {
    zip: 'realesrgan-ncnn-vulkan-20220424-windows.zip',
    sha256: 'abc02804e17982a3be33675e4d471e91ea374e65b70167abc09e31acb412802d',
    files: ['realesrgan-ncnn-vulkan.exe', 'vcomp140.dll']
  }
}

// Only the general photo model. The anime models in the zip would add ~40 MB
// to every installer for artwork this app does not make.
const MODEL_FILES = ['realesrgan-x4plus.param', 'realesrgan-x4plus.bin']

const ROOT = path.join(__dirname, '..', 'vendor', 'upscaler')

async function present (dir, build) {
  const wanted = [...build.files, ...MODEL_FILES.map((m) => path.join('models', m))]
  for (const name of wanted) {
    try { await fs.access(path.join(dir, name)) } catch { return false }
  }
  return true
}

async function fetchOne (key) {
  const build = BUILDS[key]
  const dest = path.join(ROOT, key)
  if (await present(dest, build)) {
    console.log(`upscaler/${key}: already present`)
    return
  }

  console.log(`upscaler/${key}: downloading ${build.zip}`)
  const response = await fetch(`${RELEASE}/${build.zip}`)
  if (!response.ok) throw new Error(`Download failed: HTTP ${response.status} for ${build.zip}`)
  const bytes = Buffer.from(await response.arrayBuffer())

  const digest = crypto.createHash('sha256').update(bytes).digest('hex')
  if (digest !== build.sha256) {
    throw new Error(`${build.zip} has SHA-256 ${digest}, expected ${build.sha256}. Refusing to use it.`)
  }

  // An empty folder of our own, so nothing already on disk mixes with it.
  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'printshop-esrgan-'))
  try {
    const zip = path.join(work, build.zip)
    await fs.writeFile(zip, bytes)
    const out = path.join(work, 'x')
    await fs.mkdir(out)
    // bsdtar reads zip on macOS and on Windows 10+, which are the build hosts.
    execFileSync('tar', ['-xf', zip, '-C', out])

    await fs.rm(dest, { recursive: true, force: true })
    await fs.mkdir(path.join(dest, 'models'), { recursive: true })
    for (const name of build.files) {
      await fs.copyFile(path.join(out, name), path.join(dest, name))
    }
    for (const name of MODEL_FILES) {
      await fs.copyFile(path.join(out, 'models', name), path.join(dest, 'models', name))
    }
    if (key === 'mac') await fs.chmod(path.join(dest, 'realesrgan-ncnn-vulkan'), 0o755)
  } finally {
    await fs.rm(work, { recursive: true, force: true })
  }
  console.log(`upscaler/${key}: ready in ${path.relative(process.cwd(), dest)}`)
}

async function main () {
  const here = { darwin: 'mac', win32: 'win' }[process.platform]
  const keys = process.argv.includes('--all') ? Object.keys(BUILDS) : [here]
  if (!keys[0]) {
    console.log(`No upscaler build for ${process.platform}; AI upscaling will be unavailable.`)
    return
  }
  for (const key of keys) await fetchOne(key)
}

main().catch((error) => {
  console.error(error.message)
  process.exit(1)
})
