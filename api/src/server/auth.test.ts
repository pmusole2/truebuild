import { chmod, lstat, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { OwnerSessionManager, requireOwnerSession } from './auth'
import { RunLedger } from './budget'

const directories: string[] = []

afterEach(async (): Promise<void> => {
    await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function setup(): Promise<{ path: string; ledger: RunLedger }> {
    const path = await mkdtemp(join(tmpdir(), 'truebuild-auth-test-'))
    directories.push(path)
    await chmod(path, 0o700)
    return { path, ledger: new RunLedger({ privateDirectory: path }) }
}

function request(token: string, origin?: string, url = 'http://localhost:3000/api/checks'): Request {
    return new Request(url, {
        method: 'POST',
        body: 'private body',
        headers: { authorization: `Bearer ${token}`, ...(origin === undefined ? {} : { origin }) },
    })
}

describe('owner session admission', (): void => {
    it('uses protected token file, expires exactly, and invalidates previous/restarted sessions', async (): Promise<void> => {
        const { path, ledger } = await setup()
        let now = 100
        const manager = new OwnerSessionManager({ privateDirectory: path, ledger, now: (): number => now })
        await expect(manager.createSession({ newRun: false })).rejects.toThrow('run_required')
        const session = await manager.createSession({ newRun: true })
        const token = await readFile(join(path, 'session-token'), 'utf8')
        expect(/^[a-f0-9]{64}$/u.test(token)).toBe(true)
        expect((await lstat(join(path, 'session-token'))).mode & 0o777).toBe(0o600)
        expect(requireOwnerSession(request(token), manager)).toEqual(session)
        const restart = new OwnerSessionManager({ privateDirectory: path, ledger })
        expect(() => requireOwnerSession(request(token), restart)).toThrow('unauthorized')
        now = session.expiresAt
        expect(() => requireOwnerSession(request(token), manager)).toThrow('unauthorized')
        now = 101
        expect(() => requireOwnerSession(request(token), manager)).toThrow('unauthorized')
        const renewed = await manager.createSession({ newRun: false })
        expect(renewed.runId).toBe(session.runId)
        expect(() => requireOwnerSession(request(token), manager)).toThrow('unauthorized')
    })

    it('rejects bad credentials/origins/hosts before body consumption or simulated dispatch', async (): Promise<void> => {
        const { path, ledger } = await setup()
        const manager = new OwnerSessionManager({ privateDirectory: path, ledger })
        await manager.createSession({ newRun: true })
        const token = await readFile(join(path, 'session-token'), 'utf8')
        let dispatches = 0
        for (const input of [
            request('wrong'),
            new Request('http://localhost:3000'),
            request(token, 'https://foreign.example'),
            request(token, 'null'),
            request(token, undefined, 'http://192.168.1.2:3000'),
            request(token, undefined, 'https://api.example'),
        ]) {
            try {
                requireOwnerSession(input, manager)
                dispatches += 1
            } catch (error) {
                expect(error).toBeInstanceOf(Error)
                expect(error instanceof Error ? error.message : '').toBe('unauthorized')
            }
            expect(input.bodyUsed).toBe(false)
        }
        expect(dispatches).toBe(0)
        expect(requireOwnerSession(request(token, 'http://localhost:8081'), manager).runId).toBeTruthy()
        expect(
            requireOwnerSession(request(token, undefined, 'https://api.example'), manager, {
                allowNonLoopbackHttps: true,
            }).runId,
        ).toBeTruthy()
        expect(() =>
            requireOwnerSession(request(token, undefined, 'http://api.example'), manager, {
                allowNonLoopbackHttps: true,
            }),
        ).toThrow('unauthorized')
    })
})
