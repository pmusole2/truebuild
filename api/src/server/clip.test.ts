import { spawn } from 'node:child_process'

import { describe, expect, it } from 'vitest'

import { createDeadline } from './deadline'
import { normalizeClip } from './clip'

export async function syntheticClip(duration = 1): Promise<Uint8Array> {
    return new Promise((resolve, reject): void => {
        const child = spawn(
            process.env.FFMPEG_PATH ?? 'ffmpeg',
            [
                '-nostdin',
                '-v',
                'error',
                '-f',
                'lavfi',
                '-i',
                `color=c=red:s=32x24:r=4:d=${duration}`,
                '-f',
                'lavfi',
                '-i',
                `sine=frequency=440:duration=${duration}`,
                '-shortest',
                '-c:v',
                'libx264',
                '-pix_fmt',
                'yuv420p',
                '-c:a',
                'aac',
                '-metadata',
                'comment=synthetic private metadata',
                '-movflags',
                'frag_keyframe+empty_moov',
                '-f',
                'mp4',
                'pipe:1',
            ],
            { stdio: ['ignore', 'pipe', 'pipe'] },
        )
        const chunks: Buffer[] = []
        let bytes = 0
        const timer = setTimeout((): void => {
            child.kill('SIGKILL')
        }, 5_000)
        child.stdout.on('data', (chunk: Buffer): void => {
            bytes += chunk.length
            if (bytes > 1_048_576) {
                child.kill('SIGKILL')
            } else {
                chunks.push(chunk)
            }
        })
        child.stderr.resume()
        child.on('error', (): void => {
            clearTimeout(timer)
            reject(new Error('fixture_unavailable'))
        })
        child.on('close', (code): void => {
            clearTimeout(timer)
            if (code !== 0) {
                reject(new Error('fixture_unavailable'))
            } else {
                resolve(Buffer.concat(chunks))
            }
        })
    })
}

// Suppress synthetic media bytes if a negative assertion unexpectedly resolves.
async function normalizeWithoutBytes(...args: Parameters<typeof normalizeClip>): Promise<void> {
    await normalizeClip(...args)
}

describe('bounded real clip normalization', (): void => {
    it('probes, strips audio/metadata, remuxes and revalidates synthetic H264 bytes', async (): Promise<void> => {
        const bytes = await syntheticClip()
        const deadline = createDeadline(30_000)
        try {
            const clip = await normalizeClip({ bytes, mimeType: 'video/mp4' }, deadline)
            expect({ width: clip.width, height: clip.height, frameCount: clip.frameCount }).toEqual({
                width: 32,
                height: 24,
                frameCount: 4,
            })
            expect(clip.durationSeconds).toBeLessThanOrEqual(5)
            expect(Buffer.from(clip.bytes).includes(Buffer.from('synthetic private metadata'))).toBe(false)
            expect(clip.mimeType).toBe('video/mp4')
        } finally {
            deadline.dispose()
        }
    })

    it('rejects an unqualified container brand despite a compatible codec', async (): Promise<void> => {
        const bytes = await syntheticClip()
        bytes.set(new TextEncoder().encode('3gp6'), 8)
        const deadline = createDeadline(30_000)
        try {
            await expect(normalizeWithoutBytes({ bytes, mimeType: 'video/mp4' }, deadline)).rejects.toThrow(
                'unavailable',
            )
        } finally {
            deadline.dispose()
        }
    })

    it('kills and awaits its active codec subprocess on parent abort', async (): Promise<void> => {
        const bytes = await syntheticClip()
        const parent = new AbortController()
        const deadline = createDeadline(30_000, parent.signal)
        const pending = normalizeWithoutBytes({ bytes, mimeType: 'video/mp4' }, deadline)
        parent.abort()
        await expect(pending).rejects.toThrow('cancelled')
        deadline.dispose()
    })

    it('rejects long, malformed, oversized and pre-aborted clips', async (): Promise<void> => {
        const deadline = createDeadline(30_000)
        try {
            await expect(
                normalizeWithoutBytes({ bytes: await syntheticClip(6), mimeType: 'video/mp4' }, deadline),
            ).rejects.toThrow('invalid_input')
            await expect(
                normalizeWithoutBytes({ bytes: new Uint8Array([1, 2, 3]), mimeType: 'video/mp4' }, deadline),
            ).rejects.toThrow('invalid_input')
            await expect(
                normalizeWithoutBytes(
                    { bytes: new Uint8Array(20 * 1_024 * 1_024 + 1), mimeType: 'video/mp4' },
                    deadline,
                ),
            ).rejects.toThrow('invalid_input')
        } finally {
            deadline.dispose()
        }
        const parent = new AbortController()
        parent.abort()
        const stopped = createDeadline(30_000, parent.signal)
        await expect(
            normalizeWithoutBytes({ bytes: new Uint8Array([1]), mimeType: 'video/mp4' }, stopped),
        ).rejects.toThrow('cancelled')
        stopped.dispose()
    })
})
