'use strict'

// Checks on paths the renderer sends. The renderer is treated as untrusted: a
// bug that lets a page run script must not turn into opening, reading or
// running arbitrary files on the shop's computer. Pure, so test/verify.js can
// exercise it without Electron.

const path = require('node:path')

// A variant the app itself generated: a .png sitting directly in a job folder
// made this session. jobDirs holds those folders, already resolved.
function isJobVariant (jobDirs, file) {
  if (typeof file !== 'string' || !file) return false
  const resolved = path.resolve(file)
  return path.extname(resolved).toLowerCase() === '.png' && jobDirs.has(path.dirname(resolved))
}

// The Codex path field takes a typed path, and whatever it names is executed.
// Only accept something that is plainly the Codex binary (or the npm shim that
// findCodex maps to it), never an arbitrary program.
const CODEX_NAME = /^codex(\.exe|\.cmd|\.bat|\.ps1)?$/i

function isCodexPath (value) {
  if (typeof value !== 'string' || !value) return false
  return path.isAbsolute(value) && CODEX_NAME.test(path.basename(value))
}

module.exports = { isJobVariant, isCodexPath }
