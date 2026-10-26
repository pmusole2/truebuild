import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, realpath, rename, unlink } from 'node:fs/promises'
import { join } from 'node:path'

const MAX_LEDGER_BYTES = 8 * 1_024 * 1_024
const MAX_HISTORY = 1_000
const queues = new Map<string, Promise<void>>()

type Outcome = 'reserved' | 'completed' | 'failed' | 'unknown'
type Reservation = {
    requestId: string
    reservationId: string
    allowanceMicros: number
    outcome: Outcome
    actualMicros: number | null
}
type Run = { runId: string; maxRequests: number; budgetMicros: number; reservations: Reservation[] }
type State = { version: 1; currentRunId: string | null; runs: Run[] }

export class BudgetError extends Error {
    readonly code: string

    constructor(code: string) {
        super(code)
        this.name = 'BudgetError'
        this.code = code
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
    return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key))
}

function integer(value: unknown, minimum = 0): value is number {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum
}

function id(value: unknown): value is string {
    return typeof value === 'string' && value.length > 0 && value.length <= 128 && value.trim() === value
}

function isReservation(value: unknown): value is Reservation {
    if (
        !isRecord(value) ||
        !hasKeys(value, ['requestId', 'reservationId', 'allowanceMicros', 'outcome', 'actualMicros'])
    ) {
        return false
    }
    return (
        id(value.requestId) &&
        id(value.reservationId) &&
        integer(value.allowanceMicros, 1) &&
        typeof value.outcome === 'string' &&
        ['reserved', 'completed', 'failed', 'unknown'].includes(value.outcome) &&
        (value.actualMicros === null ||
            (value.outcome === 'completed' &&
                integer(value.actualMicros) &&
                value.actualMicros <= value.allowanceMicros))
    )
}

function cost(reservation: Reservation): number {
    return reservation.actualMicros ?? reservation.allowanceMicros
}

function isRun(value: unknown): value is Run {
    if (
        !isRecord(value) ||
        !hasKeys(value, ['runId', 'maxRequests', 'budgetMicros', 'reservations']) ||
        !id(value.runId) ||
        !integer(value.maxRequests, 1) ||
        value.maxRequests > 10_000 ||
        !integer(value.budgetMicros, 1) ||
        !Array.isArray(value.reservations) ||
        value.reservations.length > value.maxRequests ||
        !value.reservations.every(isReservation)
    ) {
        return false
    }
    const requests = value.reservations.map((reservation) => reservation.requestId)
    const reservationIds = value.reservations.map((reservation) => reservation.reservationId)
    const total = value.reservations.reduce((sum, reservation) => sum + cost(reservation), 0)

    return (
        new Set(requests).size === requests.length &&
        new Set(reservationIds).size === reservationIds.length &&
        Number.isSafeInteger(total) &&
        total <= value.budgetMicros
    )
}

function isState(value: unknown): value is State {
    if (
        !isRecord(value) ||
        !hasKeys(value, ['version', 'currentRunId', 'runs']) ||
        value.version !== 1 ||
        !Array.isArray(value.runs) ||
        value.runs.length > MAX_HISTORY ||
        !value.runs.every(isRun)
    ) {
        return false
    }
    const ids = value.runs.map((run) => run.runId)

    return (
        new Set(ids).size === ids.length &&
        (value.runs.length === 0 ? value.currentRunId === null : value.currentRunId === ids.at(-1))
    )
}

function missing(error: unknown): boolean {
    return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

/** Shared storage boundary for the inactive ledger and owner-session modules. */
export async function protectedDirectory(path: string): Promise<string> {
    const stat = await lstat(path)
    if (
        !stat.isDirectory() ||
        stat.isSymbolicLink() ||
        (stat.mode & 0o777) !== 0o700 ||
        typeof process.getuid !== 'function' ||
        stat.uid !== process.getuid()
    ) {
        throw new Error('protected_storage_unavailable')
    }
    const canonical = await realpath(path)
    const current = await lstat(canonical)
    if (current.dev !== stat.dev || current.ino !== stat.ino) {
        throw new Error('protected_storage_unavailable')
    }

    return canonical
}

async function existingFile(path: string): Promise<boolean> {
    try {
        const stat = await lstat(path)
        if (
            !stat.isFile() ||
            stat.isSymbolicLink() ||
            stat.nlink !== 1 ||
            (stat.mode & 0o777) !== 0o600 ||
            stat.uid !== process.getuid?.()
        ) {
            throw new Error('protected_storage_unavailable')
        }
        return true
    } catch (error) {
        if (missing(error)) {
            return false
        }
        throw error
    }
}

/** Atomic replace followed by directory fsync; a rejected post-rename fsync is an unknown commit. */
export async function writeProtectedFile(
    directory: string,
    name: 'run-ledger.json' | 'session-token',
    text: string,
): Promise<void> {
    const canonical = await protectedDirectory(directory)
    const before = await lstat(canonical)
    const target = join(canonical, name)
    await existingFile(target)
    const temporary = join(canonical, `.${name}.${randomUUID()}.tmp`)
    let created = false
    try {
        const handle = await open(
            temporary,
            constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
            0o600,
        )
        created = true
        try {
            await handle.writeFile(text, 'utf8')
            await handle.sync()
        } finally {
            await handle.close()
        }
        await protectedDirectory(directory)
        const current = await lstat(canonical)
        if (current.dev !== before.dev || current.ino !== before.ino) {
            throw new Error('protected_storage_unavailable')
        }
        await existingFile(target)
        await rename(temporary, target)
        created = false
        const directoryHandle = await open(canonical, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
        try {
            await directoryHandle.sync()
        } finally {
            await directoryHandle.close()
        }
    } finally {
        if (created) {
            await unlink(temporary).catch((): void => {})
        }
    }
}

async function readState(directory: string): Promise<State> {
    const file = join(directory, 'run-ledger.json')
    if (!(await existingFile(file))) {
        return { version: 1, currentRunId: null, runs: [] }
    }
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
        const stat = await handle.stat()
        if (
            !stat.isFile() ||
            stat.nlink !== 1 ||
            (stat.mode & 0o777) !== 0o600 ||
            stat.uid !== process.getuid?.() ||
            stat.size > MAX_LEDGER_BYTES
        ) {
            throw new Error('ledger_unavailable')
        }
        const data: unknown = JSON.parse(await handle.readFile('utf8'))
        if (!isState(data)) {
            throw new Error('ledger_unavailable')
        }
        return data
    } finally {
        await handle.close()
    }
}

async function serial<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = queues.get(key) ?? Promise.resolve()
    const pending = previous.then(operation)
    const settled = pending.then(
        (): void => {},
        (): void => {},
    )
    queues.set(key, settled)
    try {
        return await pending
    } finally {
        if (queues.get(key) === settled) {
            queues.delete(key)
        }
    }
}

export class RunLedger {
    readonly #privateDirectory: string
    readonly #maxRequests: number
    readonly #budgetMicros: number
    #currentRunId: string | null = null
    #unavailable = false
    #hasObservedLedger = false

    constructor(options: { privateDirectory: string; maxRequests?: number; budgetMicros?: number }) {
        this.#privateDirectory = options.privateDirectory
        this.#maxRequests = options.maxRequests ?? 20
        this.#budgetMicros = options.budgetMicros ?? 2_000_000
        if (!integer(this.#maxRequests, 1) || this.#maxRequests > 10_000 || !integer(this.#budgetMicros, 1)) {
            throw new BudgetError('invalid_budget')
        }
    }

    getCurrentRunId(): string | null {
        return this.#unavailable ? null : this.#currentRunId
    }

    async #operate<T>(action: (state: State, directory: string) => Promise<T>): Promise<T> {
        if (this.#unavailable) {
            throw new BudgetError('ledger_unavailable')
        }
        try {
            const directory = await protectedDirectory(this.#privateDirectory)
            return await serial(directory, async (): Promise<T> => {
                if (this.#unavailable) {
                    throw new BudgetError('ledger_unavailable')
                }
                await protectedDirectory(this.#privateDirectory)
                const state = await readState(directory)
                if (this.#hasObservedLedger && state.runs.length === 0) {
                    throw new Error('ledger_unavailable')
                }
                this.#hasObservedLedger ||= state.runs.length > 0
                this.#currentRunId = state.currentRunId
                return await action(state, directory)
            })
        } catch (error) {
            if (error instanceof BudgetError) {
                throw error
            }
            this.#unavailable = true
            throw new BudgetError('ledger_unavailable')
        }
    }

    async #save(directory: string, state: State): Promise<void> {
        if (!isState(state)) {
            throw new Error('ledger_unavailable')
        }
        const text = JSON.stringify(state)
        if (Buffer.byteLength(text) > MAX_LEDGER_BYTES) {
            throw new BudgetError('history_full')
        }
        await writeProtectedFile(directory, 'run-ledger.json', text)
        this.#currentRunId = state.currentRunId
        this.#hasObservedLedger = true
    }

    async load(): Promise<void> {
        await this.#operate(async (): Promise<void> => {})
    }

    async startRun(): Promise<{ runId: string }> {
        return this.#operate(async (state, directory): Promise<{ runId: string }> => {
            if (state.runs.length >= MAX_HISTORY) {
                throw new BudgetError('history_full')
            }
            const runId = randomUUID()
            state.runs.push({
                runId,
                maxRequests: this.#maxRequests,
                budgetMicros: this.#budgetMicros,
                reservations: [],
            })
            state.currentRunId = runId
            await this.#save(directory, state)
            return { runId }
        })
    }

    async reserve(input: {
        runId: string
        requestId: string
        allowanceMicros: number
    }): Promise<{ reservationId: string }> {
        const { runId, requestId, allowanceMicros } = input
        if (!id(runId) || !id(requestId) || !integer(allowanceMicros, 1)) {
            throw new BudgetError('invalid_reservation')
        }
        return this.#operate(async (state, directory): Promise<{ reservationId: string }> => {
            const run = state.runs.find((candidate) => candidate.runId === runId)
            if (!run || run.runId !== state.currentRunId) {
                throw new BudgetError('run_required')
            }
            if (run.reservations.some((reservation) => reservation.requestId === requestId)) {
                throw new BudgetError('duplicate_request')
            }
            const spent = run.reservations.reduce((total, reservation) => total + cost(reservation), 0)
            if (run.reservations.length >= run.maxRequests || allowanceMicros > run.budgetMicros - spent) {
                throw new BudgetError('budget_exhausted')
            }
            const reservationId = randomUUID()
            run.reservations.push({
                requestId: requestId,
                reservationId,
                allowanceMicros: allowanceMicros,
                outcome: 'reserved',
                actualMicros: null,
            })
            await this.#save(directory, state)
            return { reservationId }
        })
    }

    async finalize(input: {
        runId: string
        requestId: string
        outcome: 'completed' | 'failed' | 'unknown'
        actualMicros?: number
    }): Promise<void> {
        const { runId, requestId, outcome, actualMicros } = input
        if (
            !id(runId) ||
            !id(requestId) ||
            !['completed', 'failed', 'unknown'].includes(outcome) ||
            (actualMicros !== undefined && !integer(actualMicros))
        ) {
            throw new BudgetError('invalid_usage')
        }
        await this.#operate(async (state, directory): Promise<void> => {
            const reservation = state.runs
                .find((run) => run.runId === runId)
                ?.reservations.find((candidate) => candidate.requestId === requestId)
            if (!reservation) {
                throw new BudgetError('reservation_required')
            }
            if (reservation.outcome !== 'reserved') {
                throw new BudgetError('already_finalized')
            }
            if (actualMicros !== undefined && actualMicros > reservation.allowanceMicros) {
                throw new BudgetError('invalid_usage')
            }
            reservation.outcome = outcome
            reservation.actualMicros = outcome === 'completed' ? (actualMicros ?? null) : null
            await this.#save(directory, state)
        })
    }
}
