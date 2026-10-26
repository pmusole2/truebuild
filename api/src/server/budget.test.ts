import { chmod, lstat, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { RunLedger } from './budget'

const directories: string[] = []

async function directory(): Promise<string> {
    const path = await mkdtemp(join(tmpdir(), 'truebuild-ledger-test-'))
    directories.push(path)
    await chmod(path, 0o700)
    return path
}

afterEach(async (): Promise<void> => {
    await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('durable run ledger', (): void => {
    it('serializes concurrent duplicate requests and persists before successful reservation', async (): Promise<void> => {
        const path = await directory()
        const ledger = new RunLedger({ privateDirectory: path, maxRequests: 2, budgetMicros: 100 })
        await ledger.load()
        const { runId } = await ledger.startRun()
        const results = await Promise.allSettled([
            ledger.reserve({ runId, requestId: 'same', allowanceMicros: 50 }),
            ledger.reserve({ runId, requestId: 'same', allowanceMicros: 50 }),
        ])
        expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
        expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1)
        expect((await lstat(join(path, 'run-ledger.json'))).mode & 0o777).toBe(0o600)
        const restarted = new RunLedger({ privateDirectory: path })
        await restarted.load()
        expect(restarted.getCurrentRunId()).toBe(runId)
        await expect(restarted.reserve({ runId, requestId: 'same', allowanceMicros: 1 })).rejects.toThrow(
            'duplicate_request',
        )
        await restarted.reserve({ runId, requestId: 'second', allowanceMicros: 50 })
        await expect(ledger.reserve({ runId, requestId: 'third', allowanceMicros: 1 })).rejects.toThrow(
            'budget_exhausted',
        )
    })

    it.each(['failed', 'unknown'] as const)(
        'retains %s allowance and history across new explicit runs',
        async (outcome): Promise<void> => {
            const path = await directory()
            const ledger = new RunLedger({ privateDirectory: path, budgetMicros: 100 })
            const { runId } = await ledger.startRun()
            await ledger.reserve({ runId, requestId: 'request', allowanceMicros: 100 })
            await ledger.finalize({ runId, requestId: 'request', outcome, actualMicros: 0 })
            await expect(ledger.reserve({ runId, requestId: 'another', allowanceMicros: 1 })).rejects.toThrow(
                'budget_exhausted',
            )
            const next = await ledger.startRun()
            expect(next.runId).not.toBe(runId)
            const text = await readFile(join(path, 'run-ledger.json'), 'utf8')
            expect(text).toContain(runId)
            expect(text).toContain(outcome)
        },
    )

    it('allows completed validated cost reduction but never refunds the request count', async (): Promise<void> => {
        const ledger = new RunLedger({ privateDirectory: await directory(), maxRequests: 2, budgetMicros: 100 })
        const { runId } = await ledger.startRun()
        await ledger.reserve({ runId, requestId: 'one', allowanceMicros: 100 })
        await expect(
            ledger.finalize({ runId, requestId: 'one', outcome: 'completed', actualMicros: 101 }),
        ).rejects.toThrow('invalid_usage')
        await ledger.finalize({ runId, requestId: 'one', outcome: 'completed', actualMicros: 0 })
        await ledger.reserve({ runId, requestId: 'two', allowanceMicros: 100 })
        await ledger.finalize({ runId, requestId: 'two', outcome: 'completed', actualMicros: 0 })
        await expect(ledger.reserve({ runId, requestId: 'three', allowanceMicros: 1 })).rejects.toThrow(
            'budget_exhausted',
        )
        await expect(
            ledger.finalize({ runId, requestId: 'one', outcome: 'completed', actualMicros: 0 }),
        ).rejects.toThrow('already_finalized')
    })

    it('refuses corrupt or symlink state and unsafe directories without resetting them', async (): Promise<void> => {
        const path = await directory()
        const file = join(path, 'run-ledger.json')
        await writeFile(file, 'corrupt', { mode: 0o600 })
        const ledger = new RunLedger({ privateDirectory: path })
        await expect(ledger.load()).rejects.toThrow('ledger_unavailable')
        await expect(ledger.startRun()).rejects.toThrow('ledger_unavailable')
        expect(await readFile(file, 'utf8')).toBe('corrupt')
        const other = await directory()
        await symlink(file, join(other, 'run-ledger.json'))
        await expect(new RunLedger({ privateDirectory: other }).load()).rejects.toThrow('ledger_unavailable')
        await chmod(other, 0o755)
        await expect(new RunLedger({ privateDirectory: other }).startRun()).rejects.toThrow('ledger_unavailable')
    })

    it('shares one request ceiling across independent in-process ledger instances', async (): Promise<void> => {
        const path = await directory()
        const spark = new RunLedger({ privateDirectory: path, maxRequests: 1 })
        const sam = new RunLedger({ privateDirectory: path })
        const { runId } = await spark.startRun()
        const results = await Promise.allSettled([
            spark.reserve({ runId, requestId: 'spark', allowanceMicros: 10 }),
            sam.reserve({ runId, requestId: 'sam', allowanceMicros: 10 }),
        ])
        expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
        expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1)
    })

    it('reserves the submitted identity and allowance even if the caller mutates its input while queued', async (): Promise<void> => {
        const ledger = new RunLedger({ privateDirectory: await directory(), budgetMicros: 100 })
        const { runId } = await ledger.startRun()
        const input = { runId, requestId: 'original', allowanceMicros: 30 }
        const pending = ledger.reserve(input)
        input.requestId = 'changed'
        input.allowanceMicros = -100
        await pending
        await expect(ledger.reserve({ runId, requestId: 'original', allowanceMicros: 1 })).rejects.toThrow(
            'duplicate_request',
        )
        await expect(ledger.reserve({ runId, requestId: 'second', allowanceMicros: 71 })).rejects.toThrow(
            'budget_exhausted',
        )
    })

    it('rejects a structurally corrupted outcome instead of coercing it into a valid string', async (): Promise<void> => {
        const path = await directory()
        const ledger = new RunLedger({ privateDirectory: path })
        const { runId } = await ledger.startRun()
        await ledger.reserve({ runId, requestId: 'request', allowanceMicros: 10 })
        const file = join(path, 'run-ledger.json')
        const bytes = await readFile(file, 'utf8')
        await writeFile(file, bytes.replace('"outcome":"reserved"', '"outcome":["reserved"]'))
        await expect(new RunLedger({ privateDirectory: path }).load()).rejects.toThrow('ledger_unavailable')
    })

    it('fails closed when persistence becomes unavailable and keeps committed bytes intact', async (): Promise<void> => {
        const path = await directory()
        const ledger = new RunLedger({ privateDirectory: path })
        const { runId } = await ledger.startRun()
        const committed = await readFile(join(path, 'run-ledger.json'))
        const moved = `${path}-moved`
        await rename(path, moved)
        directories.push(moved)
        await expect(ledger.reserve({ runId, requestId: 'one', allowanceMicros: 1 })).rejects.toThrow(
            'ledger_unavailable',
        )
        expect(await readFile(join(moved, 'run-ledger.json'))).toEqual(committed)
        await expect(ledger.reserve({ runId, requestId: 'two', allowanceMicros: 1 })).rejects.toThrow(
            'ledger_unavailable',
        )
    })
})
