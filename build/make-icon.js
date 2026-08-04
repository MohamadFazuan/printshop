// Emits build/icon.png (1024×1024) — the source electron-builder derives .icns/.ico from.
// Written by hand so the repo carries no image dependency. Run: node build/make-icon.js

'use strict'

const zlib = require('node:zlib')
const fs = require('node:fs')
const path = require('node:path')

const SIZE = 1024
const INK = [17, 17, 17]
const PAPER = [255, 255, 255]

const pixels = Buffer.alloc(SIZE * SIZE * 3)

// Rounded sheet, 3:4, centred — a page, which is what this app makes.
const sheetW = 460
const sheetH = 614
const left = (SIZE - sheetW) / 2
const top = (SIZE - sheetH) / 2
const radius = 40

function inSheet (x, y) {
  if (x < left || x >= left + sheetW || y < top || y >= top + sheetH) return false
  const dx = Math.min(x - left, left + sheetW - 1 - x)
  const dy = Math.min(y - top, top + sheetH - 1 - y)
  if (dx >= radius || dy >= radius) return true
  return (radius - dx) ** 2 + (radius - dy) ** 2 <= radius ** 2
}

// Two ink bars on the sheet — the printed artwork.
const bars = [
  { x: left + 70, y: top + 90, w: sheetW - 140, h: 210 },
  { x: left + 70, y: top + 350, w: sheetW - 240, h: 40 }
]

function inBar (x, y) {
  return bars.some((b) => x >= b.x && x < b.x + b.w && y >= b.y && y < b.y + b.h)
}

for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    const colour = inSheet(x, y) ? (inBar(x, y) ? INK : PAPER) : INK
    const at = (y * SIZE + x) * 3
    pixels[at] = colour[0]
    pixels[at + 1] = colour[1]
    pixels[at + 2] = colour[2]
  }
}

// Raw scanlines, filter byte 0 per row.
const raw = Buffer.alloc(SIZE * (SIZE * 3 + 1))
for (let y = 0; y < SIZE; y++) {
  raw[y * (SIZE * 3 + 1)] = 0
  pixels.copy(raw, y * (SIZE * 3 + 1) + 1, y * SIZE * 3, (y + 1) * SIZE * 3)
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})

function crc32 (buf) {
  let c = 0xffffffff
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk (type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([length, body, crc])
}

const ihdr = Buffer.alloc(13)
ihdr.writeUInt32BE(SIZE, 0)
ihdr.writeUInt32BE(SIZE, 4)
ihdr[8] = 8 // bit depth
ihdr[9] = 2 // truecolour

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0))
])

const out = path.join(__dirname, 'icon.png')
fs.writeFileSync(out, png)
console.log(`wrote ${out} (${png.length} bytes)`)
