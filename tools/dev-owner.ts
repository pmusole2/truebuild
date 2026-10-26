import { spawn } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { protectedDirectory, RunLedger } from '../api/src/server/budget'

export function parseOwnerArguments(args: readonly string[]): 'new-run' | 'resume' {
    if (args.length !== 1 || !['--new-run', '--resume'].includes(args[0] ?? '')) {
        throw new Error('owner_usage_error')
    }
    return args[0] === '--new-run' ? 'new-run' : 'resume'
}

export async function prepareOwnerRun(options: {
    action: 'new-run' | 'resume'
    privateDirectory: string
    port?: number
}): Promise<{ runId: string; releasePort(): Promise<void> }> {
    // Sanitized boundary error is constructed before native filesystem failures are caught.
    const storageUnavailable = new Error('owner_storage_unavailable')
    const probe = createServer((socket): void => {
        socket.destroy()
    })
    try {
        await new Promise<void>((accept, reject): void => {
            probe.once('error', (): void => reject(new Error('owner_port_unavailable')))
            probe.listen(options.port ?? 3001, '127.0.0.1', accept)
        })
        try {
            await mkdir(options.privateDirectory, { mode: 0o700 })
        } catch (error) {
            if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) {
                throw storageUnavailable
            }
        }
        await protectedDirectory(options.privateDirectory)
        const ledger = new RunLedger({ privateDirectory: options.privateDirectory })
        await ledger.load()
        const runId = options.action === 'new-run' ? (await ledger.startRun()).runId : ledger.getCurrentRunId()
        if (!runId) {
            throw new Error('owner_run_required')
        }
        return {
            runId,
            releasePort: (): Promise<void> =>
                new Promise((accept): void => {
                    probe.close((): void => accept())
                }),
        }
    } catch (error) {
        await new Promise<void>((accept): void => {
            probe.close((): void => accept())
        })
        if (error instanceof Error && ['owner_port_unavailable', 'owner_run_required'].includes(error.message)) {
            throw error
        }
        throw storageUnavailable
    }
}

export function ownerChildEnvironment(inherited: NodeJS.ProcessEnv, privateDirectory: string): NodeJS.ProcessEnv {
    return {
        ...inherited,
        TRUEBUILD_ENABLE_MODELS: '1',
        TRUEBUILD_OWNER_ACTION: 'resume',
        TRUEBUILD_PRIVATE_DIRECTORY: privateDirectory,
    }
}

async function main(args: readonly string[]): Promise<number> {
    const action = parseOwnerArguments(args)
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
    const privateDirectory = join(root, '.local')
    const next = createRequire(import.meta.url).resolve('next/dist/bin/next')
    const prepared = await prepareOwnerRun({ action, privateDirectory })
    await prepared.releasePort()
    return new Promise((accept): void => {
        const child = spawn(process.execPath, [next, 'dev', '--hostname', '127.0.0.1', '--port', '3001'], {
            cwd: join(root, 'api'),
            env: ownerChildEnvironment(process.env, privateDirectory),
            stdio: 'ignore',
            shell: false,
        })
        process.stdout.write('Owner server starting on loopback.\nOwner token: .local/session-token\n')
        const stop = (): void => {
            child.kill('SIGTERM')
        }
        process.once('SIGINT', stop)
        process.once('SIGTERM', stop)
        let finished = false
        const finish = (code: number): void => {
            if (finished) {
                return
            }
            finished = true
            process.removeListener('SIGINT', stop)
            process.removeListener('SIGTERM', stop)
            process.stdout.write('Owner server stopped.\n')
            accept(code)
        }
        child.once('error', (): void => finish(1))
        child.once('exit', (code): void => finish(code ?? 1))
    })
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    void main(process.argv.slice(2)).then(
        (code): void => {
            process.exitCode = code
        },
        (): void => {
            process.stderr.write('Owner startup unavailable.\n')
            process.exitCode = 1
        },
    )
}
