/**
 * Validate explicit model-authored sources and publish compiled documents to private local output. Run from the repo root:
 * `npx tsx app/src/features/documents/recorded/generate.ts` (or `--check` for read-only verification).
 *
 * This tool owns validation, hashes, assembly and an allowlisted runtime metadata projection only. The raw proposal, input sample, actual author record and prompt
 * are source files. It never authors, repairs, reorders, formats or replaces any of those inputs. Inference model,
 * effort, timing and usage stay null; `authoring` identifies the worker who composed this synthetic fixture.
 */
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
    assembleDocumentV2,
    canonicalJson,
    documentMaterialV2,
    manualSessionSchema,
    screenDocumentV2Schema,
    screenProposalV2Schema,
    screenUiStateV2Schema,
    syntheticAuthorV2Schema,
    syntheticDocumentFactsV2,
    verifyDocumentAgainstInputsV2,
} from '@truebuild/contracts'
import { format, resolveConfig } from 'prettier'
import { z } from 'zod'

// Offline publication tooling only: reuse the real server gate rather than maintain a weaker copy.
import { buildDocumentContext } from '../../../../../api/src/server/documents/context'
import { evaluateProposal } from '../../../../../api/src/server/documents/ground'

const here = dirname(fileURLToPath(import.meta.url))
const sha256Hex = (text: string): string => createHash('sha256').update(text).digest('hex')
const read = (name: string): string => readFileSync(join(here, name), 'utf8')
const checkOnly = process.argv.includes('--check')
const privateOutput = resolve(here, '../../../../../.local/ai-effort/close95/records/published')
const ARTIFACTS = readdirSync(here)
    .filter((name) => name.endsWith('.proposal.json'))
    .map((name) => name.slice(0, -'.proposal.json'.length))
    .sort()

/** These launch samples have no step, photo result or failure; future contexts need their own explicit contract. */
const launchInputsSchema = z.strictObject({
    kind: z.enum(['home', 'add', 'pages', 'reading', 'more', 'judge', 'camera']),
    session: manualSessionSchema.nullable(),
    stepId: z.null(),
    captureId: z.null(),
    result: z.null(),
    failure: z.null(),
    uiState: screenUiStateV2Schema,
})
const sidecarSchema = z.strictObject({
    evidence: z.literal('synthetic-fixture'),
    model: z.null(),
    effort: z.null(),
    authoring: syntheticAuthorV2Schema,
    recordedAt: z.iso.datetime(),
    promptVersion: z.literal(0),
    repaired: z.literal(false),
    taskReference: z.string().min(1),
    inputPrompt: z.string().min(1),
    inputPromptSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    rawJsonSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    timingMs: z.null(),
    tokens: z.null(),
    binding: z.string().min(1),
})

const runtimeSchema = sidecarSchema.pick({
    evidence: true,
    model: true,
    effort: true,
    authoring: true,
    recordedAt: true,
    promptVersion: true,
    repaired: true,
})

async function publish(): Promise<void> {
    if (ARTIFACTS.length === 0) throw new Error('No raw recordings found')
    // Validate the entire set before writing any private publication. The only authored content comes from the raw source tree.
    const publications = ARTIFACTS.map((name) => {
        const raw = read(`${name}.proposal.json`)
        const rawProposal: unknown = JSON.parse(raw)
        const proposal = screenProposalV2Schema.parse(rawProposal)
        if (canonicalJson(proposal) !== canonicalJson(rawProposal)) {
            throw new Error(`${name}: validation would change the raw proposal`)
        }
        const inputs = launchInputsSchema.parse(JSON.parse(read(`${name}.inputs.json`)))
        const sidecar = sidecarSchema.parse(JSON.parse(read(`${name}.provenance.json`)))
        // Deterministic build metadata, not newly authored content or a provider result. Full evidence stays offline.
        const runtimeMetadata = {
            evidence: sidecar.evidence,
            model: sidecar.model,
            effort: sidecar.effort,
            authoring: sidecar.authoring,
            recordedAt: sidecar.recordedAt,
            promptVersion: sidecar.promptVersion,
            repaired: sidecar.repaired,
        }
        if (sidecar.inputPromptSha256 !== sha256Hex(sidecar.inputPrompt)) {
            throw new Error(`${name}: prompt hash mismatch`)
        }
        if (sidecar.rawJsonSha256 !== sha256Hex(raw)) {
            throw new Error(`${name}: raw proposal hash mismatch`)
        }
        if (sidecar.recordedAt !== sidecar.authoring.recordedAt || sidecar.authoring.fixtureId !== `${name}-sol-v1`) {
            throw new Error(`${name}: authoring identity mismatch`)
        }
        const evaluated = evaluateProposal(proposal, buildDocumentContext(inputs))
        if (!evaluated.ok) throw new Error(`${name}: server gate: ${evaluated.issues.join(',')}`)
        const document = assembleDocumentV2(
            documentMaterialV2(inputs),
            proposal,
            syntheticDocumentFactsV2(sidecar.authoring),
            { sha256Hex, now: () => new Date(sidecar.authoring.recordedAt) },
        )
        screenDocumentV2Schema.parse(document)
        const issues = verifyDocumentAgainstInputsV2(document, inputs, sha256Hex)
        if (issues.length > 0) throw new Error(`${name}: ${issues.join(',')}`)
        const publishedTree = {
            header: document.header,
            body: document.body,
            bar: document.bar,
            overlays: document.overlays,
            states: document.states,
        }
        if (canonicalJson(publishedTree) !== canonicalJson(proposal)) {
            throw new Error(`${name}: assembly changed the raw proposal`)
        }
        const rawRuntime: unknown = JSON.parse(read(`${name}.runtime.json`))
        const runtime = runtimeSchema.parse(rawRuntime)
        if (canonicalJson(rawRuntime) !== canonicalJson(runtimeMetadata)) {
            throw new Error(`${name}: runtime metadata differs from its safe projection`)
        }
        // The shipped source graph must publish exactly the document computed from retained author evidence.
        const runtimeDocument = assembleDocumentV2(
            documentMaterialV2(inputs),
            proposal,
            syntheticDocumentFactsV2(runtime.authoring),
            { sha256Hex, now: () => new Date(runtime.recordedAt) },
        )
        if (canonicalJson(runtimeDocument) !== canonicalJson(document)) {
            throw new Error(`${name}: runtime source assembly differs from retained provenance`)
        }

        return { name, document }
    })

    const formatOptions = (await resolveConfig(here)) ?? {}
    // Formatting changes only publication bytes. Raw source files and their witnessed hashes remain untouched.
    const formatted = await Promise.all(
        publications.map(async ({ name, document }) => ({
            name,
            content: await format(JSON.stringify(document), { ...formatOptions, parser: 'json' }),
        })),
    )
    if (!checkOnly) mkdirSync(privateOutput, { recursive: true })
    for (const { name, content } of formatted) {
        if (!checkOnly) {
            writeFileSync(join(privateOutput, `${name}.json`), content)
        }
        process.stdout.write(
            `${checkOnly ? 'verified' : 'published'} ${name}: exact source assembly + safe runtime metadata; server/client issues=[]\n`,
        )
    }
}

void publish().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : 'Publication failed'}\n`)
    process.exitCode = 1
})
