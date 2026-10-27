import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { createServer } from 'node:net'
import { createDemoManual } from '@truebuild/contracts'
import sharp from 'sharp'
import { expect, it } from 'vitest'

it.each(['correct', 'reversed', 'uncertain'] as const)(
    'launches guarded %s scenario with isolated CORS and shuts down',
    async (scenario) => {
        const reservation = createServer()
        reservation.listen(0, '127.0.0.1')
        await once(reservation, 'listening')
        const address = reservation.address()
        if (!address || typeof address === 'string') throw new Error('missing_test_port')
        await new Promise<void>((resolve) => reservation.close(() => resolve()))
        const child = spawn(
            process.execPath,
            ['--import', 'tsx', 'api/scripts/mock-server.ts', '--test-only', `--scenario=${scenario}`],
            {
                env: { PATH: process.env.PATH, PORT: String(address.port), CORS_ORIGINS: 'http://localhost:18071' },
                stdio: ['ignore', 'pipe', 'pipe'],
            },
        )
        const closed = once(child, 'close')
        try {
            await new Promise<void>((resolve, reject) => {
                const timer = setTimeout(() => reject(new Error('mock_start_timeout')), 5000)
                child.stdout.on('data', (chunk: Buffer) => {
                    if (chunk.toString().includes('TEST MOCK ONLY')) {
                        clearTimeout(timer)
                        resolve()
                    }
                })
                child.once('error', (error) => {
                    clearTimeout(timer)
                    reject(error)
                })
                child.once('exit', () => {
                    clearTimeout(timer)
                    reject(new Error('mock_start_failed'))
                })
            })
            const origin = `http://127.0.0.1:${address.port}`
            const health = await fetch(`${origin}/health`, { headers: { origin: 'http://localhost:18071' } })
            expect(health.headers.get('access-control-allow-origin')).toBe('http://localhost:18071')
            expect(await health.json()).toMatchObject({ providerMode: 'meta', checkContext: 'full' })
            const bytes = new Uint8Array(
                await sharp({ create: { width: 20, height: 16, channels: 3, background: 'red' } })
                    .png()
                    .toBuffer(),
            )
            const session = createDemoManual()
            session.pages[0] = {
                ...session.pages[0]!,
                width: 20,
                height: 16,
                contentHash: createHash('sha256').update(bytes).digest('hex'),
            }
            const form = new FormData()
            form.set(
                'metadata',
                JSON.stringify({
                    mode: 'model',
                    requestId: 'launcher-check',
                    session,
                    sourcePageIds: ['demo-page-1'],
                    binding: {
                        kind: 'capture',
                        manualId: session.manualId,
                        revision: 1,
                        stepId: 'step-1',
                        captureId: 'launcher-capture',
                    },
                    observation: { mimeType: 'image/png', width: 20, height: 16 },
                }),
            )
            for (const name of ['source-0', 'observation'])
                form.set(name, new Blob([bytes], { type: 'image/png' }), 'image.png')
            const response = await fetch(`${origin}/api/checks`, {
                method: 'POST',
                headers: { origin: 'http://localhost:18071', 'x-truebuild-key': 'truebuild-fixture-demo' },
                body: form,
            })
            expect(response.status).toBe(200)
            expect(await response.json()).toMatchObject({
                value: {
                    decision: scenario === 'correct' ? 'pass' : scenario === 'reversed' ? 'refuse' : 'cannot_verify',
                },
            })
        } finally {
            child.kill('SIGTERM')
            await closed
        }
    },
)

it.each([
    { args: [], key: undefined },
    { args: ['--test-only', '--scenario=unsupported'], key: undefined },
    { args: ['--test-only'], key: '<synthetic>' },
])('refuses unsafe launcher configuration before opening a listener: %j', async ({ args, key }) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'api/scripts/mock-server.ts', ...args], {
        env: { PATH: process.env.PATH, ...(key ? { MODEL_API_KEY: key } : {}) },
        stdio: 'ignore',
    })
    const timer = setTimeout(() => child.kill('SIGTERM'), 5000)
    try {
        expect((await once(child, 'close'))[0]).toBe(1)
    } finally {
        clearTimeout(timer)
        child.kill('SIGTERM')
    }
})
