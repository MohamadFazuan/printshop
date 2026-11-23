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
//
// --key <path> points at a different private key file.

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const { signLicence, verifyLicence } = require('../src/licence')

const DEFAULT_KEY = path.join(os.homedir(), '.printshop-licensing', 'licence-private.pem')

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
  console.error(`${licence.tierLabel} · ${licence.email} · ${licence.machines} computer(s) · issued ${licence.issued} · id ${licence.id}`)
  console.log(key)
}

const opts = args(process.argv.slice(2))
try {
  const command = opts._[0]
  if (command === 'keygen') keygen(opts.key || DEFAULT_KEY)
  else if (command === 'issue') issue(opts)
  else if (command === 'verify') {
    const licence = verifyLicence(opts._[1])
    console.log(`Valid: ${licence.tierLabel} · ${licence.email} · ${licence.machines} computer(s) · issued ${licence.issued} · id ${licence.id}`)
  } else {
    console.error('Usage: node scripts/licence.js keygen | issue --email <email> --tier basic|pro|custom [--machines n] [--name text] | verify <key>')
    process.exit(1)
  }
} catch (error) {
  console.error(error.message)
  process.exit(1)
}
