import { constants } from 'node:fs'
import { link, lstat, mkdir, open, realpath, rename, unlink, type FileHandle } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

import { evaluateDataset, EvaluationError, QUALIFICATION } from './evaluation'

const MAX_INPUT_BYTES = 16_777_216

class CliError extends Error {
    constructor(
        readonly code:
            | 'invalid_arguments'
            | 'unsafe_path'
            | 'unsafe_permissions'
            | 'input_too_large'
            | 'input_changed'
            | 'output_exists'
            | 'invalid_output_target'
            | 'file_error',
    ) {
        super(code)
        this.name = 'CliError'
    }
}

interface Options {
    input: string
    output: string
    overwrite: boolean
}

function options(args: readonly string[]): Options {
    let input: string | undefined
    let output: string | undefined
    let overwrite = false

    for (let index = 0; index < args.length; index += 1) {
        const flag = args[index]

        if (flag === '--overwrite' && !overwrite) {
            overwrite = true
            continue
        }

        const value = args[index + 1]

        if ((flag !== '--input' && flag !== '--output') || !value || value.startsWith('--')) {
            throw new CliError('invalid_arguments')
        }

        if (flag === '--input' && input === undefined) {
            input = value
        } else if (flag === '--output' && output === undefined) {
            output = value
        } else {
            throw new CliError('invalid_arguments')
        }

        index += 1
    }

    if (!input || !output) {
        throw new CliError('invalid_arguments')
    }

    return { input, output, overwrite }
}

function inside(root: string, target: string): boolean {
    const path = relative(root, target)

    return path.length > 0 && path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path)
}

function missing(error: unknown): boolean {
    return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

async function privateTarget(workspace: string, value: string): Promise<string> {
    const target = resolve(workspace, value)
    let ancestor = dirname(target)

    while (ancestor !== dirname(ancestor)) {
        if (basename(ancestor) === '.local') {
            // Canonicalize only the workspace prefix (e.g. macOS /var -> /private/var), never private symlinks.
            try {
                if ((await realpath(dirname(ancestor))) === workspace) {
                    const normalized = join(workspace, '.local', relative(ancestor, target))

                    if (inside(join(workspace, '.local'), normalized)) {
                        return normalized
                    }
                }
            } catch (error: unknown) {
                if (!missing(error)) {
                    throw error
                }
            }
        }

        ancestor = dirname(ancestor)
    }

    throw new CliError('unsafe_path')
}

async function privateDirectory(path: string): Promise<void> {
    const metadata = await lstat(path)

    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
        throw new CliError('unsafe_path')
    }

    if ((metadata.mode & 0o077) !== 0 || (typeof process.getuid === 'function' && metadata.uid !== process.getuid())) {
        throw new CliError('unsafe_permissions')
    }
}

async function privatePath(root: string, target: string, createParents: boolean): Promise<void> {
    if (!inside(root, target)) {
        throw new CliError('unsafe_path')
    }

    await privateDirectory(root)
    let parent = root
    const path = relative(root, dirname(target))

    if (!path) {
        return
    }

    for (const component of path.split(sep)) {
        parent = join(parent, component)

        if (createParents) {
            try {
                await mkdir(parent, { mode: 0o700 })
            } catch (error: unknown) {
                if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) {
                    throw error
                }
            }
        }

        await privateDirectory(parent)
    }
}

async function privateFile(handle: FileHandle): Promise<void> {
    const metadata = await handle.stat()

    if (!metadata.isFile() || metadata.nlink !== 1) {
        throw new CliError('unsafe_path')
    }

    if (
        (metadata.mode & 0o777) !== 0o600 ||
        (typeof process.getuid === 'function' && metadata.uid !== process.getuid())
    ) {
        throw new CliError('unsafe_permissions')
    }
}

async function readPrivateJson(path: string): Promise<{ value: unknown; device: number; inode: number }> {
    const metadata = await lstat(path)

    if (metadata.isSymbolicLink() || !metadata.isFile()) {
        throw new CliError('unsafe_path')
    }

    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)

    try {
        await privateFile(handle)
        const before = await handle.stat()

        if (before.size > MAX_INPUT_BYTES) {
            throw new CliError('input_too_large')
        }

        const chunks: Buffer[] = []
        let size = 0
        const buffer = Buffer.alloc(65_536)

        while (true) {
            const { bytesRead } = await handle.read(
                buffer,
                0,
                Math.min(buffer.length, MAX_INPUT_BYTES - size + 1),
                null,
            )

            if (bytesRead === 0) {
                break
            }

            size += bytesRead

            if (size > MAX_INPUT_BYTES) {
                throw new CliError('input_too_large')
            }

            chunks.push(Buffer.from(buffer.subarray(0, bytesRead)))
        }

        const after = await handle.stat()

        if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
            throw new CliError('input_changed')
        }

        let value: unknown

        try {
            value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)))
        } catch {
            throw new EvaluationError('invalid_input')
        }

        return { value, device: after.dev, inode: after.ino }
    } finally {
        await handle.close()
    }
}

function summaryTarget(value: unknown): boolean {
    return (
        typeof value === 'object' &&
        value !== null &&
        'qualification' in value &&
        value.qualification === QUALIFICATION &&
        'version' in value &&
        value.version === 1
    )
}

/** Reads only caller-selected private metadata and writes a new aggregate artifact; never opens media or contacts a provider. */
export async function runEvaluationCli(args: readonly string[], cwd: string = process.cwd()): Promise<void> {
    const parsed = options(args)
    const workspace = await realpath(cwd)
    const root = join(workspace, '.local')
    const input = await privateTarget(workspace, parsed.input)
    const output = await privateTarget(workspace, parsed.output)
    await privatePath(root, input, false)

    if (input === output) {
        throw new CliError('unsafe_path')
    }

    const source = await readPrivateJson(input)
    const summary = evaluateDataset(source.value)
    await privatePath(root, output, true)

    try {
        const target = await lstat(output)

        if (!parsed.overwrite) {
            throw new CliError('output_exists')
        }

        if (
            target.isSymbolicLink() ||
            !target.isFile() ||
            target.nlink !== 1 ||
            (target.dev === source.device && target.ino === source.inode)
        ) {
            throw new CliError('unsafe_path')
        }

        const existing = await readPrivateJson(output)

        if (!summaryTarget(existing.value)) {
            throw new CliError('invalid_output_target')
        }
    } catch (error: unknown) {
        if (!missing(error)) {
            throw error
        }
    }

    const temporary = join(dirname(output), `.evaluation-${randomUUID()}.tmp`)
    const handle = await open(
        temporary,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
    )
    let openHandle = true
    let failure: { error: unknown } | null = null

    try {
        await handle.writeFile(`${JSON.stringify(summary, null, 4)}\n`, 'utf8')
        await handle.sync()
        await handle.close()
        openHandle = false

        if (parsed.overwrite) {
            await rename(temporary, output)
        } else {
            try {
                await link(temporary, output)
            } catch (error: unknown) {
                if (error instanceof Error && 'code' in error && error.code === 'EEXIST') {
                    throw new CliError('output_exists')
                }

                throw error
            }
        }
    } catch (error: unknown) {
        failure = { error }
    }

    if (openHandle) {
        try {
            await handle.close()
        } catch (error: unknown) {
            failure ??= { error }
        }
    }

    try {
        await unlink(temporary)
    } catch (error: unknown) {
        if (!missing(error)) {
            failure ??= { error }
        }
    }

    if (failure !== null) {
        throw failure.error
    }
}

async function main(): Promise<void> {
    try {
        await runEvaluationCli(process.argv.slice(2))
        process.stdout.write('Evaluation summary written.\n')
    } catch (error: unknown) {
        const code = error instanceof CliError || error instanceof EvaluationError ? error.code : 'file_error'
        process.stderr.write(`Evaluation failed: ${code}\n`)
        process.exitCode = 1
    }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
    void main()
}
