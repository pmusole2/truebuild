import { chmod, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { RunLedger } from './budget'
import { createModelRuntime, initializeModelRuntimeFromEnvironment, modelSessionResponse } from './model-runtime'

const directories: string[] = []
afterEach(async (): Promise<void> => {
    globalThis.__truebuildModelRuntimeV1 = undefined
    await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})
async function directory(): Promise<string> {
    const path = await mkdtemp(join(tmpdir(), 'truebuild-runtime-'))
    directories.push(path)
    await chmod(path, 0o700)
    return path
}

describe('explicit model runtime bootstrap', (): void => {
    it('does not read key material or touch storage with flags off', async (): Promise<void> => {
        let keyReads = 0
        expect(
            await initializeModelRuntimeFromEnvironment({
                TRUEBUILD_ENABLE_MODELS: '0',
                TRUEBUILD_OWNER_ACTION: 'none',
                get MODEL_API_KEY(): string {
                    keyReads += 1
                    throw new Error('unexpected_key_read')
                },
            }),
        ).toBeNull()
        expect(keyReads).toBe(0)
        expect((await modelSessionResponse(new Request('http://localhost:3001/api/session'))).status).toBe(503)
        expect(
            await createModelRuntime({ enabled: true, ownerAction: 'new-run', privateDirectory: '/not-accessed' }),
        ).toBeNull()
    })
    it('refuses startup without an explicitly prepared run', async (): Promise<void> => {
        await expect(
            createModelRuntime({ enabled: true, ownerAction: 'resume', privateDirectory: await directory() }),
        ).rejects.toThrow('model_runtime_unavailable')
    })
    it('rotates only the token on restart and keeps the same consumed budget', async (): Promise<void> => {
        const path = await directory()
        const ledger = new RunLedger({ privateDirectory: path })
        const { runId } = await ledger.startRun()
        await ledger.reserve({ runId, requestId: 'already-used', allowanceMicros: 100_000 })
        const first = await createModelRuntime({ enabled: true, ownerAction: 'resume', privateDirectory: path })
        const oldToken = await readFile(join(path, 'session-token'), 'utf8')
        const second = await createModelRuntime({ enabled: true, ownerAction: 'resume', privateDirectory: path })
        const newToken = await readFile(join(path, 'session-token'), 'utf8')
        expect(oldToken === newToken).toBe(false)
        expect(first?.ledger.getCurrentRunId()).toBe(runId)
        expect(second?.ledger.getCurrentRunId()).toBe(runId)
        await expect(second?.ledger.reserve({ runId, requestId: 'already-used', allowanceMicros: 1 })).rejects.toThrow(
            'duplicate_request',
        )
        globalThis.__truebuildModelRuntimeV1 = Promise.resolve(second)
        const denied = await modelSessionResponse(
            new Request('http://localhost:3001/api/session', { headers: { authorization: `Bearer ${oldToken}` } }),
        )
        expect(denied.status).toBe(401)
        const accepted = await modelSessionResponse(
            new Request('http://localhost:3001/api/session', { headers: { authorization: `Bearer ${newToken}` } }),
        )
        expect(await accepted.json()).toEqual({
            status: 'ok',
            runId,
            expiresAt: expect.any(Number),
            model: 'unconfigured',
        })
    })
})
