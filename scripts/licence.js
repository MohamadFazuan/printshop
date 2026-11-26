#!/usr/bin/env node
'use strict'

// Issues Printshop licence keys by hand. Not shipped in the app.
//
//   node scripts/licence.js keygen
//       Makes the signing keypair. The private key goes to
//       ~/.printshop-licensing/licence-private.pem (never into the repo); the
//       public key is printed to paste into PUBLIC_KEY in src/licence.js.
//   node scripts/licence.js issue --email buyer@example.com --tier pro [--machines 1] [--name "Shop name"]
//       Prints a key to send the buyer. --tier is basic, pro or custom.
//   node scripts/licence.js verify <key>
//       Checks a key against the public key in src/licence.js.
//   node scripts/licence.js list
//       Prints the register of issued keys.
//   node scripts/licence.js revoke <id>
//       Marks a key revoked in the register and prints the line to add to
//       REVOKED_IDS in src/licence.js. It stops working once a release with
//       that line is installed.
//
// Every issued key is appended to ~/.printshop-licensing/issued.csv (id, date,
// tier, computers, email, name, status). It holds buyers' emails, so it stays
// beside the private key and out of the repo. Back both up together.
//
// --key <path> points at a different private key file.

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const { signLicence, verifyLicence } = require('../src/licence')

const DEFAULT_KEY = path.join(os.homedir(), '.printshop-licensing', 'licence-private.pem')
const REGISTER = path.join(os.homedir(), '.printshop-licensing', 'issued.csv')
const COLUMNS = ['id', 'issued', 'tier', 'machines', 'email', 'name', 'status']

// Quoted so a shop name with a comma or quote survives a spreadsheet.
const csvCell = (value) => `"${String(value ?? '').replace(/"/g, '""')}"`

function parseCsvLine (line) {
  const cells = []
  let cell = ''
  let quoted = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') { cell += '"'; i++ } else if (ch === '"') quoted = false
      else cell += ch
    } else if (ch === '"') quoted = true
    else if (ch === ',') { cells.push(cell); cell = '' } else cell += ch
  }
  cells.push(cell)
  return cells
}

function readRegister () {
  if (!fs.existsSync(REGISTER)) return []
  return fs.readFileSync(REGISTER, 'utf8').split(/\r?\n/).slice(1).filter(Boolean)
    .map((line) => Object.fromEntries(parseCsvLine(line).map((v, i) => [COLUMNS[i], v])))
}

function writeRegister (rows) {
  fs.mkdirSync(path.dirname(REGISTER), { recursive: true, mode: 0o700 })
  const text = [COLUMNS.join(','), ...rows.map((r) => COLUMNS.map((c) => csvCell(r[c])).join(','))].join('\n') + '\n'
  fs.writeFileSync(REGISTER, text, { mode: 0o600 })
}

function record (licence) {
  const rows = readRegister()
  rows.push({ ...licence, status: 'active' })
  writeRegister(rows)
}

function args (argv) {
  const out = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) out[argv[i].slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true
    else out._.push(argv[i])
  }
  return out
}

function keygen (file) {
  if (fs.existsSync(file)) {
    console.error(`${file} already exists. Keys signed with it would stop working if it were replaced, so it is left alone.`)
    process.exit(1)
  }
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519')
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  fs.writeFileSync(file, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600, flag: 'wx' })
  console.log(`Private key: ${file}  (back it up; lose it and every key must be reissued)`)
  console.log(`PUBLIC_KEY for src/licence.js: ${publicKey.export({ format: 'jwk' }).x}`)
}

function issue (opts) {
  const file = opts.key || DEFAULT_KEY
  const privateKey = crypto.createPrivateKey(fs.readFileSync(file))
  const key = signLicence({ email: opts.email, tier: opts.tier, machines: opts.machines, name: opts.name }, privateKey)
  // Prove it verifies against the key the app ships with before sending it.
  const licence = verifyLicence(key)
  record(licence)
  console.error(`${licence.tierLabel} · ${licence.email} · ${licence.machines} computer(s) · issued ${licence.issued} · id ${licence.id}`)
  console.error(`Recorded in ${REGISTER}`)
  console.log(key)
}

function list () {
  const rows = readRegister()
  if (!rows.length) return console.log(`No keys recorded yet in ${REGISTER}.`)
  for (const r of rows) console.log([r.id, r.issued, r.tier, `${r.machines} pc`, r.email, r.name, r.status].filter(Boolean).join('  ·  '))
}

function revoke (id) {
  if (!id || !/^[0-9a-f]{8}$/.test(id)) throw new Error('Give the 8-character key id to revoke, as `list` shows it.')
  const rows = readRegister()
  const row = rows.find((r) => r.id === id)
  if (!row) console.error(`${id} is not in the register; revoking it anyway.`)
  else { row.status = 'revoked'; writeRegister(rows) }
  console.log(`Add this line inside REVOKED_IDS in src/licence.js, then release:\n  '${id}',`)
}

const opts = args(process.argv.slice(2))
try {
  const command = opts._[0]
  if (command === 'keygen') keygen(opts.key || DEFAULT_KEY)
  else if (command === 'issue') issue(opts)
  else if (command === 'list') list()
  else if (command === 'revoke') revoke(opts._[1])
  else if (command === 'verify') {
    const licence = verifyLicence(opts._[1])
    console.log(`Valid: ${licence.tierLabel} · ${licence.email} · ${licence.machines} computer(s) · issued ${licence.issued} · id ${licence.id}`)
  } else {
    console.error('Usage: node scripts/licence.js keygen | issue --email <email> --tier basic|pro|custom [--machines n] [--name text] | verify <key> | list | revoke <id>')
    process.exit(1)
  }
} catch (error) {
  console.error(error.message)
  process.exit(1)
}
