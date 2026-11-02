import sharp from 'sharp'
import { expect, it } from 'vitest'
import { PIECE_CUTOUT_MAX_CHARS } from '@truebuild/contracts'

import type { ObservationImage } from './media'
import { refinePieceCrop } from './piece-crop'

it('keeps a part crop inside its own box even when connected ink extends beyond it', async () => {
    const bytes = await sharp(
        Buffer.from(
            '<svg width="100" height="100"><rect width="100" height="100" fill="white"/><circle cx="50" cy="50" r="20" fill="black"/></svg>',
        ),
    )
        .png()
        .toBuffer()
    const image: ObservationImage = { bytes, mimeType: 'image/png', width: 100, height: 100 }
    const box = [0.4, 0.3, 0.2, 0.4] as const
    const crop = await refinePieceCrop(image, box, { withinBox: true })
    expect(crop).not.toBeNull()
    const [x, y, w, h] = crop!.box
    expect(x).toBeGreaterThanOrEqual(box[0])
    expect(y).toBeGreaterThanOrEqual(box[1])
    expect(x + w).toBeLessThanOrEqual(box[0] + box[2])
    expect(y + h).toBeLessThanOrEqual(box[1] + box[3])
})

it('finds an offset ink drawing without table borders, preserves nearby strokes, and bounds blank or invalid crops', async (): Promise<void> => {
    const width = 360
    const height = 240
    const bytes = await sharp(
        Buffer.from(`<svg width="${width}" height="${height}">
            <rect width="100%" height="100%" fill="white" />
            <path d="M40 45 H330 V215 H40 Z M40 150 H330 M265 45 V215" stroke="black" fill="none" />
            <path d="M140 85 L180 72 L205 90 L185 118 L145 112 Z M165 115 L160 124" stroke="black" stroke-width="3" fill="none" />
            <circle cx="202" cy="119" r="3" fill="black" />
        </svg>`),
    )
        .png()
        .toBuffer()
    const image: ObservationImage = { bytes, mimeType: 'image/png', width, height }
    const crop = await refinePieceCrop(image, [0.55, 0.34, 0.17, 0.22])

    expect(crop).not.toBeNull()
    if (!crop) throw new Error('Missing offset drawing crop')
    const [x, y, w, h] = crop.box
    expect(x * width).toBeLessThanOrEqual(139)
    expect((x + w) * width).toBeGreaterThanOrEqual(206)
    expect(y * height).toBeLessThanOrEqual(71)
    expect((y + h) * height).toBeGreaterThanOrEqual(126)
    expect(crop.image.width).toBeLessThan(100)
    expect(crop.image.height).toBeLessThan(80)
    expect(crop.uri).toBe(`data:image/png;base64,${Buffer.from(crop.image.bytes).toString('base64')}`)
    expect(await sharp(crop.image.bytes).metadata()).toMatchObject({
        width: crop.image.width,
        height: crop.image.height,
    })
    const largeBytes = await sharp(bytes)
        .resize(width * 10, height * 10, { kernel: 'nearest' })
        .png()
        .toBuffer()
    const large = await refinePieceCrop(
        { ...image, bytes: largeBytes, width: width * 10, height: height * 10 },
        [0.55, 0.34, 0.17, 0.22],
    )
    expect(large).not.toBeNull()
    expect(Math.max(large!.image.width, large!.image.height)).toBeLessThanOrEqual(512)
    expect(large!.uri.length).toBeLessThanOrEqual(PIECE_CUTOUT_MAX_CHARS)
    expect(await sharp(large!.image.bytes).metadata()).toMatchObject({
        width: large!.image.width,
        height: large!.image.height,
    })

    const blankBytes = await sharp({ create: { width, height, channels: 3, background: '#eeeeee' } })
        .png()
        .toBuffer()
    const blank = { ...image, bytes: blankBytes }
    expect(await refinePieceCrop(blank, [0, 0, 0.1, 0.1])).toBeNull()
    const speckBytes = await sharp(
        Buffer.from(`<svg width="${width}" height="${height}">
        <rect width="100%" height="100%" fill="white" /><rect x="220" y="100" width="4" height="4" fill="black" />
    </svg>`),
    )
        .png()
        .toBuffer()
    expect(await refinePieceCrop({ ...image, bytes: speckBytes }, [0.55, 0.34, 0.17, 0.22])).toBeNull()
    const borderOnly = await sharp(
        Buffer.from(`<svg width="${width}" height="${height}">
        <rect width="100%" height="100%" fill="white" />
        <path d="M40 45 H330 V215 H40 Z M40 150 H330 M265 45 V215" stroke="black" fill="none" />
    </svg>`),
    )
        .png()
        .toBuffer()
    expect(await refinePieceCrop({ ...image, bytes: borderOnly }, [0.55, 0.34, 0.17, 0.22])).toBeNull()
    const edgeBytes = await sharp(
        Buffer.from(`<svg width="${width}" height="${height}">
        <rect width="100%" height="100%" fill="white" /><circle cx="8" cy="8" r="6" fill="black" />
    </svg>`),
    )
        .png()
        .toBuffer()
    const edge = await refinePieceCrop({ ...image, bytes: edgeBytes }, [0, 0, 0.05, 0.05])
    expect(edge).not.toBeNull()
    expect(edge?.box[0]).toBe(0)
    expect(edge?.box[1]).toBe(0)
    for (const box of [
        [-0.1, 0, 0.5, 0.5],
        [0, 0, 0, 1],
        [0.9, 0, 0.2, 1],
        [NaN, 0, 1, 1],
    ] as const) {
        expect(await refinePieceCrop(image, box)).toBeNull()
    }
    expect(await refinePieceCrop({ ...image, width: 30_000, height: 30_000 }, [0, 0, 1, 1])).toBeNull()
})
