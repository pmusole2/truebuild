import { chmod, mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { ownerChildEnvironment, parseOwnerArguments, prepareOwnerRun } from './dev-owner'

const directories: string[] = []
afterEach(async (): Promise<void> => {
    await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})
async function directory(): Promise<string> {
    const path = await mkdtemp(join(tmpdir(), 'truebuild-owner-'))
    directories.push(path)
    await chmod(path, 0o700)
    return path
}

describe('operator run preparation without launching a real server', (): void => {
    it('requires one explicit action and always makes the child resume', (): void => {
        expect(parseOwnerArguments(['--new-run'])).toBe('new-run')
        expect(parseOwnerArguments(['--resume'])).toBe('resume')
        for (const args of [[], ['--unknown'], ['--resume', '--new-run']]) {
            expect(() => parseOwnerArguments(args)).toThrow('owner_usage_error')
        }
        const env = ownerChildEnvironment({ NODE_ENV: 'test', TRUEBUILD_OWNER_ACTION: 'new-run' }, '/synthetic-private')
        expect(env.TRUEBUILD_OWNER_ACTION).toBe('resume')
        expect(env.TRUEBUILD_ENABLE_MODELS).toBe('1')
    })
    it('persists explicit new run and resumes without creating a session token', async (): Promise<void> => {
        const path = await directory()
        const first = await prepareOwnerRun({ action: 'new-run', privateDirectory: path, port: 0 })
        await first.releasePort()
        const second = await prepareOwnerRun({ action: 'resume', privateDirectory: path, port: 0 })
        try {
            expect(second.runId).toBe(first.runId)
        } finally {
            await second.releasePort()
        }
        await expect(readFile(join(path, 'session-token'))).rejects.toMatchObject({ code: 'ENOENT' })
    })
    it('refuses occupied loopback port before making a new run and leaves the other server alone', async (): Promise<void> => {
        const server = createServer((socket): void => {
            socket.destroy()
        })
        await new Promise<void>((resolve): void => {
            server.listen(0, '127.0.0.1', resolve)
        })
        const address = server.address()
        if (!address || typeof address === 'string') {
            throw new Error('fixture_unavailable')
        }
        const path = await directory()
        try {
            await expect(
                prepareOwnerRun({ action: 'new-run', privateDirectory: path, port: address.port }),
            ).rejects.toThrow('owner_port_unavailable')
            expect(server.listening).toBe(true)
            await expect(readFile(join(path, 'run-ledger.json'))).rejects.toMatchObject({ code: 'ENOENT' })
        } finally {
            await new Promise<void>((resolve): void => {
                server.close((): void => resolve())
            })
        }
    })
    it('refuses unsafe existing private directories', async (): Promise<void> => {
        const path = await directory()
        await chmod(path, 0o755)
        await expect(prepareOwnerRun({ action: 'new-run', privateDirectory: path, port: 0 })).rejects.toThrow(
            'owner_storage_unavailable',
        )
    })
})
