'use strict'

// Checks on paths the renderer sends. The renderer is treated as untrusted: a
// bug that lets a page run script must not turn into opening, reading or
// running arbitrary files on the shop's computer. The file system is passed in,
// so test/verify.js can exercise every branch without Electron or real files.

const path = require('node:path')
const os = require('node:os')
const fsp = require('node:fs/promises')

// A variant the app itself generated: a .png sitting directly in a job folder
// made this session. jobDirs holds those folders, already resolved.
function isJobVariant (jobDirs, file) {
  if (typeof file !== 'string' || !file) return false
  const resolved = path.resolve(file)
  return path.extname(resolved).toLowerCase() === '.png' && jobDirs.has(path.dirname(resolved))
}

// True when target is dir itself or sits somewhere under it. A sibling such as
// `Programs-evil` next to `Programs` is outside.
function isInside (dir, target, p = path) {
  const rel = p.relative(p.resolve(dir), p.resolve(target))
  if (rel === '') return true
  return rel !== '..' && !rel.startsWith(`..${p.sep}`) && !p.isAbsolute(rel)
}

// The Codex path field takes a typed path, and whatever it names is executed.
// First gate: the name must plainly be the Codex binary or its npm shim.
const CODEX_NAME = /^codex(\.exe|\.cmd|\.bat|\.ps1)?$/i

function isCodexPath (value, p = path) {
  if (typeof value !== 'string' || !value) return false
  return p.isAbsolute(value) && CODEX_NAME.test(p.basename(value))
}

const WORLD_WRITABLE = 0o002

// Second gate: a name proves nothing, since anyone can call a file `codex`.
// Returns the path as typed, to run, or throws a reason fit for Settings.
// Not the real path: findCodex maps a Windows npm `codex.cmd` shim to the
// binary beside it by that name and folder, and messages should name what the
// shop typed.
//
// POSIX: the link as typed, the folder it sits in, the real file and the
// folder that holds it must all be owned by this user or root and not
// writable by everyone. That refuses /tmp/codex and anything another account
// could have planted or could swap later. Homebrew's codex is a symlink to a
// script in its node_modules; both ends are checked.
//
// Windows: mode bits mean nothing there, so the real file must sit under this
// user's profile or Program Files, which other standard accounts cannot write.
async function checkCodexBinary (value, {
  platform = process.platform,
  uid = typeof process.getuid === 'function' ? process.getuid() : null,
  env = process.env,
  home = os.homedir(),
  stat = fsp.stat,
  lstat = fsp.lstat,
  realpath = fsp.realpath
} = {}) {
  const p = platform === 'win32' ? path.win32 : path.posix
  if (!isCodexPath(value, p)) {
    throw new Error('The Codex path must be the full path to the codex program itself, for example /opt/homebrew/bin/codex or C:\\Users\\you\\AppData\\Roaming\\npm\\codex.cmd.')
  }

  let real
  try {
    real = await realpath(value)
  } catch {
    throw new Error(`There is no program at ${value}.`)
  }
  const info = await stat(real)
  if (!info.isFile()) throw new Error(`${value} is not a program file.`)

  if (platform === 'win32') {
    const roots = [home, env.USERPROFILE, env.LOCALAPPDATA, env.APPDATA, env.ProgramFiles, env['ProgramFiles(x86)']]
      .filter(Boolean)
    // Windows paths compare without case.
    const lower = (s) => s.toLowerCase()
    if (!roots.some((root) => isInside(lower(root), lower(real), p))) {
      throw new Error(`Codex has to be installed in your user folder or Program Files, not ${p.dirname(real)}.`)
    }
    return value
  }

  const checks = [
    [p.dirname(value), stat],
    [value, lstat],
    [p.dirname(real), stat],
    [real, stat]
  ]
  for (const [target, look] of checks) {
    const s = await look(target)
    // A link's own mode bits are meaningless (always 0777 on Linux); its owner
    // and the folder holding it are what decide who can repoint it.
    if (!s.isSymbolicLink() && (s.mode & WORLD_WRITABLE)) {
      throw new Error(`Codex cannot be run from ${target}: any account on this computer can change it.`)
    }
    if (uid !== null && s.uid !== uid && s.uid !== 0) {
      throw new Error(`Codex cannot be run from ${target}: it belongs to another account on this computer.`)
    }
  }
  return value
}

module.exports = { isJobVariant, isInside, isCodexPath, checkCodexBinary }
