'use strict'

// Licence keys. A key is `PS1.<payload>.<signature>`, both base64url: the
// payload is JSON, the signature is Ed25519 over `PS1.<payload>`. The app holds
// only the public key, so keys are checked offline and the app keeps working
// without internet. Keys are signed by scripts/licence.js, which is not shipped.
//
// One-time licences: there is no expiry. An `updatesUntil` field can be added
// later without breaking existing keys.

const crypto = require('node:crypto')

const PREFIX = 'PS1'

// Raw 32-byte Ed25519 public key, base64url. Its private half lives outside the
// repo, on the machine that issues keys.
const PUBLIC_KEY = 'e7B7EoiwFJ5AX9lwjmd8wUZS_2nlThtXQQL5R5JDsrw'

const PRO_FEATURES = ['cut', 'sheets', 'upscale', 'cmyk']
const TIERS = {
  basic: { label: 'Basic', features: [] },
  pro: { label: 'Pro', features: PRO_FEATURES },
  custom: { label: 'Custom', features: PRO_FEATURES }
}

const FEATURE_LABELS = {
  cut: 'Cut lines',
  sheets: 'Sticker sheets',
  upscale: 'AI upscale',
  cmyk: 'CMYK and TIFF export'
}

const WHATSAPP = 'https://wa.me/60137129937'

function publicKeyObject (raw = PUBLIC_KEY) {
  return crypto.createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: raw }, format: 'jwk' })
}

const NOT_A_KEY = 'That is not a Printshop licence key. Copy the whole key, starting with PS1.'
const BAD_KEY = 'This licence key is not valid. Check it was copied in full, or ask for a new one on WhatsApp.'

// Returns the licence, or throws a message fit to show the shop owner.
function verifyLicence (text, publicKey = PUBLIC_KEY) {
  // Keys pasted from WhatsApp or email can arrive wrapped or with spaces.
  const key = String(text || '').replace(/\s+/g, '')
  const parts = key.split('.')
  if (parts.length !== 3 || parts[0] !== PREFIX || !parts[1] || !parts[2]) throw new Error(NOT_A_KEY)

  let valid = false
  try {
    valid = crypto.verify(null, Buffer.from(`${PREFIX}.${parts[1]}`), publicKeyObject(publicKey), Buffer.from(parts[2], 'base64url'))
  } catch {
    valid = false
  }
  if (!valid) throw new Error(BAD_KEY)

  let data
  try {
    data = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
  } catch {
    throw new Error(BAD_KEY)
  }
  // A signed key with fields this version does not understand came from a
  // newer issuer; say so rather than guessing what it allows.
  if (data.v !== 1 || !TIERS[data.tier]) throw new Error('This licence key is for a newer Printshop. Update the app, then enter the key again.')

  return {
    key,
    id: String(data.id || ''),
    email: String(data.email || ''),
    name: String(data.name || ''),
    tier: data.tier,
    tierLabel: TIERS[data.tier].label,
    machines: Number.isInteger(data.machines) && data.machines > 0 ? data.machines : 1,
    issued: String(data.issued || ''),
    features: [...TIERS[data.tier].features]
  }
}

// Used by scripts/licence.js and the tests; the app never signs.
function signLicence ({ email, tier, machines = 1, name = '', issued, id }, privateKey) {
  if (!TIERS[tier]) throw new Error(`Unknown tier: ${tier}. Use ${Object.keys(TIERS).join(', ')}.`)
  if (!email || !/^[^@\s]+@[^@\s]+$/.test(email)) throw new Error('A licence needs the buyer\'s email.')
  const payload = {
    v: 1,
    id: id || crypto.randomBytes(4).toString('hex'),
    email,
    tier,
    machines: Math.max(1, Math.floor(Number(machines) || 1)),
    issued: issued || new Date().toISOString().slice(0, 10)
  }
  if (name) payload.name = name
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  const sig = crypto.sign(null, Buffer.from(`${PREFIX}.${body}`), privateKey)
  return `${PREFIX}.${body}.${sig.toString('base64url')}`
}

// Which Pro features an export or preview request uses.
function featuresForCut (cut) {
  if (!cut || !cut.kind || cut.kind === 'none') return []
  return cut.sheet && cut.sheet !== 'single' ? ['cut', 'sheets'] : ['cut']
}

function featuresForExport ({ cut, upscale, colour, format } = {}) {
  const needed = featuresForCut(cut)
  if (upscale) needed.push('upscale')
  if (colour === 'cmyk' || format === 'tiff') needed.push('cmyk')
  return needed
}

// Throws unless the licence exists and covers every feature asked for.
function assertAllowed (licence, features = []) {
  if (!licence) throw new Error('Printshop is not activated. Enter your licence key to continue.')
  const missing = features.filter((f) => !licence.features.includes(f))
  if (missing.length) {
    throw new Error(`${FEATURE_LABELS[missing[0]] || missing[0]} is a Pro feature. Upgrade for RM 30 on WhatsApp.`)
  }
}

module.exports = {
  PREFIX,
  PUBLIC_KEY,
  TIERS,
  PRO_FEATURES,
  FEATURE_LABELS,
  WHATSAPP,
  verifyLicence,
  signLicence,
  featuresForCut,
  featuresForExport,
  assertAllowed
}
