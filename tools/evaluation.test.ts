import { execFile } from 'node:child_process'
import { chmod, mkdtemp, mkdir, readFile, rm, stat, writeFile, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'

import { evaluateDataset, EvaluationError, type EvaluationSample } from './evaluation'

const exec = promisify(execFile)
const fixtures: string[] = []

function sample(index: number, overrides: Partial<EvaluationSample> = {}): EvaluationSample {
    return {
        requestId: `request-${index}`,
        binding: {
            kind: 'capture',
            manualId: 'manual-1',
            revision: 1,
            stepId: 'step-1',
            captureId: `capture-${index}`,
        },
        captureHash: index.toString(16).padStart(64, '0'),
        sessionId: `session-${index % 2}`,
        mode: 'model',
        source: 'real-capture',
        expected: 'correct',
        decision: 'pass',
        latencyMs: 1000,
        model: 'muse-spark-1.3',
        promptVersion: 'prompt-v1',
        split: 'heldout',
        ...overrides,
    }
}

function completeDataset(): EvaluationSample[] {
    return Array.from({ length: 90 }, (_, index): EvaluationSample => {
        const expected = index < 30 ? 'correct' : index < 60 ? 'wrong' : 'unclear'

        return sample(index + 1, {
            expected,
            decision: expected === 'correct' ? 'pass' : expected === 'wrong' ? 'refuse' : 'cannot_verify',
        })
    })
}

afterEach(async (): Promise<void> => {
    for (const fixture of fixtures.splice(0)) {
        await rm(fixture, { recursive: true, force: true })
    }
})

describe('metadata evaluation aggregation', (): void => {
    it('passes only the complete balanced metadata gate and emits aggregate counts', (): void => {
        const summary = evaluateDataset({ version: 1, samples: completeDataset() })

        expect(summary.gate.status).toBe('pass')
        expect(summary.qualification).toContain('metadata gate only')
        expect(summary.counts).toMatchObject({ total: 90, scored: 90, excluded: 0 })
        expect(summary.confusionMatrix).toEqual({
            correct: { pass: 30, refuse: 0, cannot_verify: 0, technical_error: 0 },
            wrong: { pass: 0, refuse: 30, cannot_verify: 0, technical_error: 0 },
            unclear: { pass: 0, refuse: 0, cannot_verify: 30, technical_error: 0 },
        })
        expect(summary.sessions.scoredUnique).toBe(2)
        const serialized = JSON.stringify(summary)

        expect(serialized).not.toContain('request-1')
        expect(serialized).not.toContain('capture-1')
        expect(serialized).not.toContain('session-0')
        expect(serialized).not.toContain('manual-1')
    })

    it('counts exclusions and their overlapping reasons without scoring fixture/tuning/synthetic rows', (): void => {
        const summary = evaluateDataset({
            version: 1,
            samples: [
                sample(1, { mode: 'fixture', source: 'synthetic', split: 'tuning', decision: 'technical_error' }),
                sample(2, { source: 'manual-only', decision: 'technical_error' }),
                sample(3, { split: 'tuning' }),
                sample(4, { expected: 'wrong', decision: 'pass' }),
            ],
        })

        expect(summary.counts).toMatchObject({ total: 4, scored: 1, excluded: 3 })
        expect(summary.counts.exclusionReasons).toEqual({
            fixtureMode: 1,
            nonRealCapture: 2,
            tuningSplit: 2,
            unsupportedModel: 0,
        })
        expect(summary.counts.byMode.fixture).toBe(1)
        expect(summary.counts.bySplit.tuning).toBe(2)
        expect(summary.technicalErrors).toEqual({ total: 2, scored: 0, excluded: 2 })
        expect(summary.excludedConfusionMatrix.correct.technical_error).toBe(2)
        expect(summary.falsePasses.total).toBe(1)
        expect(summary.falsePasses.classConditional.wrong.oneSided95UpperBound).toBeNull()
        expect(summary.falsePasses.classConditional.unclear.oneSided95UpperBound).toBeNull()
        expect(summary.gate.status).toBe('pending')
    })

    it('keeps technical errors in accuracy denominators and tap-to-display latency', (): void => {
        const samples = completeDataset()

        for (let index = 0; index < 4; index += 1) {
            const row = samples[index]

            if (row) {
                row.decision = 'technical_error'
                row.latencyMs = 9000
            }
        }

        const summary = evaluateDataset({ version: 1, samples })

        expect(summary.perClass.correct).toMatchObject({ denominator: 30, usefulCount: 26, usefulRate: 26 / 30 })
        expect(summary.technicalErrors.scored).toBe(4)
        expect(summary.latency.count).toBe(90)
        expect(summary.gate.status).toBe('fail')
    })

    it('uses nearest-rank p50/p95, includes errors, and keeps inclusive latency limits', (): void => {
        const rows = Array.from({ length: 20 }, (_, index): EvaluationSample =>
            sample(index + 1, {
                latencyMs: index + 1,
                decision: index === 18 ? 'technical_error' : 'pass',
            }),
        )
        const summary = evaluateDataset({ version: 1, samples: rows.reverse() })

        expect(summary.latency).toMatchObject({ count: 20, p50Ms: 10, p95Ms: 19 })
        const boundary = completeDataset().map((row, index): EvaluationSample => ({
            ...row,
            latencyMs: index < 45 ? 3000 : 5000,
        }))

        expect(evaluateDataset({ version: 1, samples: boundary }).gate.status).toBe('pass')
        const first = boundary[0]
        if (first) {
            first.latencyMs = 5000
        }
        expect(evaluateDataset({ version: 1, samples: boundary }).gate.status).toBe('fail')
    })

    it('computes separate class-conditional zero-false-pass bounds and reports positive failures', (): void => {
        const summary = evaluateDataset({ version: 1, samples: completeDataset() })

        expect(summary.falsePasses.classConditional.wrong.successfulDecisions).toBe(30)
        expect(summary.falsePasses.classConditional.wrong.oneSided95UpperBound).toBeCloseTo(1 - 0.05 ** (1 / 30), 12)
        expect(summary.falsePasses.classConditional.unclear.oneSided95UpperBound).toBeCloseTo(1 - 0.05 ** (1 / 30), 12)
        const rows = completeDataset()
        const wrong = rows[30]
        if (wrong) {
            wrong.decision = 'pass'
        }
        const failed = evaluateDataset({ version: 1, samples: rows })

        expect(failed.falsePasses).toMatchObject({
            wrong: 1,
            unclear: 0,
            total: 1,
            classConditional: { wrong: { oneSided95UpperBound: null } },
        })
        expect(failed.gate.status).toBe('fail')
    })

    it('keeps empty, missing or underfilled classes pending and rejects excess sampling as gate failure', (): void => {
        const empty = evaluateDataset({ version: 1, samples: [] })

        expect(empty.gate.status).toBe('pending')
        expect(empty.latency).toMatchObject({ count: 0, p50Ms: null, p95Ms: null })
        expect(empty.falsePasses.classConditional.wrong.oneSided95UpperBound).toBeNull()
        expect(empty.perClass.correct.usefulRate).toBeNull()
        expect(evaluateDataset({ version: 1, samples: completeDataset().slice(1) }).gate.status).toBe('pending')
        expect(evaluateDataset({ version: 1, samples: [...completeDataset(), sample(91)] }).gate.status).toBe('fail')
    })

    it.each(['request', 'binding', 'hash'] as const)('rejects duplicate scored %s custody', (field): void => {
        const first = sample(1)
        const duplicate = sample(2)

        if (field === 'request') {
            duplicate.requestId = first.requestId
        }
        if (field === 'binding') {
            duplicate.binding = first.binding
        }
        if (field === 'hash') {
            duplicate.captureHash = first.captureHash
        }

        expect(() => evaluateDataset({ version: 1, samples: [first, duplicate] })).toThrow('duplicate_scored_sample')
        expect(evaluateDataset({ version: 1, samples: [first, { ...duplicate, mode: 'fixture' }] }).counts.scored).toBe(
            1,
        )
    })

    it('requires two supplied scored sessions and accepts exactly 27 useful outcomes per class', (): void => {
        const rows = completeDataset()

        for (const index of [0, 1, 2, 30, 31, 32, 60, 61, 62]) {
            const row = rows[index]
            if (row) {
                row.decision = 'technical_error'
            }
        }

        expect(evaluateDataset({ version: 1, samples: rows }).gate.status).toBe('pass')
        const withErrors = evaluateDataset({ version: 1, samples: rows })
        expect(withErrors.falsePasses.classConditional.wrong).toMatchObject({
            attempts: 30,
            successfulDecisions: 27,
            technicalErrors: 3,
        })
        expect(withErrors.falsePasses.classConditional.wrong.oneSided95UpperBound).toBeCloseTo(1 - 0.05 ** (1 / 27), 12)
        for (const row of rows) {
            row.sessionId = 'one-session'
        }
        expect(evaluateDataset({ version: 1, samples: rows }).gate.status).toBe('pending')
    })

    it('excludes unsupported-model metadata with a protocol failure instead of silently qualifying', (): void => {
        const rows = [...completeDataset(), sample(100, { model: 'other-model' })]
        const summary = evaluateDataset({ version: 1, samples: rows })

        expect(summary.counts).toMatchObject({ total: 91, scored: 90, excluded: 1, protocolFailures: 1 })
        expect(summary.counts.exclusionReasons.unsupportedModel).toBe(1)
        expect(summary.gate.criteria.protocol).toBe('fail')
        expect(summary.gate.status).toBe('fail')
    })

    it('does not treat a class consisting of technical errors as zero-false-pass evidence', (): void => {
        const rows = completeDataset().map((row): EvaluationSample => ({
            ...row,
            decision: row.expected === 'wrong' ? 'technical_error' : row.decision,
        }))
        const summary = evaluateDataset({ version: 1, samples: rows })

        expect(summary.falsePasses.classConditional.wrong).toMatchObject({
            attempts: 30,
            successfulDecisions: 0,
            technicalErrors: 30,
            observedFalsePasses: 0,
            observedRateAmongSuccessful: null,
            oneSided95UpperBound: null,
        })
        expect(summary.latency.count).toBe(90)
        expect(summary.gate.status).toBe('fail')
    })

    it('compares the complete binding instead of collapsing distinct revision/step/manual identities', (): void => {
        const original = sample(1)
        const rows = [
            original,
            sample(2, { binding: { ...original.binding, revision: 2 } }),
            sample(3, { binding: { ...original.binding, stepId: 'step-2' } }),
            sample(4, { binding: { ...original.binding, manualId: 'manual-2' } }),
        ]

        expect(evaluateDataset({ version: 1, samples: rows }).counts.scored).toBe(4)
    })

    it.each([
        { version: 2, samples: [] },
        { version: 1, samples: [sample(1, { latencyMs: 0 })] },
        { version: 1, samples: [sample(1, { latencyMs: Number.POSITIVE_INFINITY })] },
        { version: 1, samples: [{ ...sample(1), photo: 'private text' }] },
        { version: 1, samples: [sample(1, { model: 'https://private.example/model' })] },
    ])('sanitizes invalid metadata without exposing a sample: %#', (input): void => {
        expect(() => evaluateDataset(input)).toThrow(EvaluationError)
        expect(() => evaluateDataset(input)).toThrow('invalid_input')
    })
})

describe('private evaluation CLI', (): void => {
    async function fixture(): Promise<{ root: string; input: string; output: string }> {
        const root = await mkdtemp(join(tmpdir(), 'truebuild-evaluation-'))
        fixtures.push(root)
        await mkdir(join(root, '.local'), { mode: 0o700 })
        const input = join(root, '.local', 'input.json')
        await writeFile(input, JSON.stringify({ version: 1, samples: completeDataset() }), { mode: 0o600 })

        return { root, input, output: join(root, '.local', 'summary.json') }
    }

    async function invoke(root: string, args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
        try {
            const result = await exec(
                process.execPath,
                [
                    '--import',
                    fileURLToPath(new URL('../node_modules/tsx/dist/loader.mjs', import.meta.url)),
                    fileURLToPath(new URL('./evaluate.ts', import.meta.url)),
                    ...args,
                ],
                { cwd: root },
            )

            return { ...result, code: 0 }
        } catch (error: unknown) {
            if (
                error instanceof Error &&
                'stdout' in error &&
                typeof error.stdout === 'string' &&
                'stderr' in error &&
                typeof error.stderr === 'string'
            ) {
                return { stdout: error.stdout, stderr: error.stderr, code: 1 }
            }

            throw new Error('CLI fixture execution failed', { cause: error })
        }
    }

    it('writes aggregate JSON0600, preserves input and requires explicit overwrite', async (): Promise<void> => {
        const { root, input, output } = await fixture()
        const original = await readFile(input)
        const args = ['--input', input, '--output', output]
        const written = await invoke(root, args)

        expect(written).toEqual({ code: 0, stdout: 'Evaluation summary written.\n', stderr: '' })
        expect((await stat(output)).mode & 0o777).toBe(0o600)
        expect(JSON.parse(await readFile(output, 'utf8'))).toMatchObject({ gate: { status: 'pass' } })
        expect((await invoke(root, args)).code).toBe(1)
        expect((await invoke(root, [...args, '--overwrite'])).code).toBe(0)
        expect(await readFile(input)).toEqual(original)
    })

    it('creates private summary subdirectories without touching the input', async (): Promise<void> => {
        const { root, input } = await fixture()
        const output = join(root, '.local', 'results', 'summary.json')
        const outcome = await invoke(root, ['--input', input, '--output', output])

        expect(outcome.code).toBe(0)
        expect((await stat(join(root, '.local', 'results'))).mode & 0o777).toBe(0o700)
        expect((await stat(output)).mode & 0o777).toBe(0o600)
    })

    it('rejects outside paths, symlinks, input overwrite and unknown flags without raw path output', async (): Promise<void> => {
        const { root, input, output } = await fixture()
        const linked = join(root, '.local', 'linked.json')
        await symlink(input, linked)

        for (const args of [
            ['--input', input, '--output', join(root, 'outside.json')],
            ['--input', linked, '--output', output],
            ['--input', input, '--output', linked, '--overwrite'],
            ['--input', input, '--output', input, '--overwrite'],
            ['--input', input, '--output', output, '--unknown'],
        ]) {
            const outcome = await invoke(root, args)

            expect(outcome.code).toBe(1)
            expect(outcome.stdout).toBe('')
            expect(outcome.stderr).toMatch(/^Evaluation failed: [a-z_]+\n$/)
            expect(outcome.stderr).not.toContain(root)
        }
    })

    it('refuses insecure input permissions without changing the source or writing a report', async (): Promise<void> => {
        const { root, input, output } = await fixture()
        const original = await readFile(input)
        await chmod(input, 0o644)
        const outcome = await invoke(root, ['--input', input, '--output', output])

        expect(outcome.stderr).toBe('Evaluation failed: unsafe_permissions\n')
        expect(outcome.code).toBe(1)
        expect(await readFile(input)).toEqual(original)
        await expect(stat(output)).rejects.toMatchObject({ code: 'ENOENT' })
    })
})
