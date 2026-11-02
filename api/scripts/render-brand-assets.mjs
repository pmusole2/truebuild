import assert from 'node:assert/strict'
import { info } from 'node:console'
import { readFile } from 'node:fs/promises'
import { fileURLToPath, URL } from 'node:url'

import sharp from 'sharp'

const icon = fileURLToPath(new URL('../../app/assets/icon.png', import.meta.url))
const source = await readFile(new URL('../../app/assets/icon.svg', import.meta.url))
await sharp(source).resize(1024, 1024).flatten({ background: '#0057C2' }).removeAlpha().png().toFile(icon)
const metadata = await sharp(icon).metadata()
assert.equal(metadata.width, 1024)
assert.equal(metadata.height, 1024)
assert.equal(metadata.hasAlpha, false)
info('Icon rendered: 1024 × 1024, RGB PNG, no alpha channel.')
