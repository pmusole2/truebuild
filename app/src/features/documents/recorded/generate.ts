/**
 * Validate explicit test fixture trees and publish compiled documents to private local output.
 * Run from the repo root with `npx tsx app/src/features/documents/recorded/generate.ts --check`.
 * Raw proposal and input bytes are never authored, repaired or reordered by this tool.
 * Public sidecars contain only a fixture identity, schema version and description. Strict runtime
 * metadata retains integrity hashes and fixture attribution; provider model, effort and usage stay null.
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
    fixtureId: z.string().regex(/^[a-z0-9][a-z0-9._-]{2,80}$/u),
    schemaVersion: z.literal(1),
    description: z
        .string()
        .min(1)
        .regex(/^[^\r\n]+$/u),
})
const runtimeSchema = z.strictObject({
    evidence: z.literal('synthetic-fixture'),
    model: z.null(),
    effort: z.null(),
    authoring: syntheticAuthorV2Schema,
    recordedAt: z.iso.datetime(),
    promptVersion: z.literal(0),
    repaired: z.literal(false),
    rawJsonSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    proposalSha256: z.string().regex(/^[a-f0-9]{64}$/u),
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
        const rawRuntime: unknown = JSON.parse(read(`${name}.runtime.json`))
        const runtime = runtimeSchema.parse(rawRuntime)
        if (runtime.rawJsonSha256 !== sha256Hex(raw)) {
            throw new Error(`${name}: raw proposal hash mismatch`)
        }
        if (runtime.proposalSha256 !== sha256Hex(canonicalJson(proposal))) {
            throw new Error(`${name}: canonical proposal hash mismatch`)
        }
        if (
            runtime.recordedAt !== runtime.authoring.recordedAt ||
            runtime.authoring.fixtureId !== sidecar.fixtureId ||
            sidecar.fixtureId !== `${name}-sol-v1`
        ) {
            throw new Error(`${name}: fixture identity mismatch`)
        }
        const evaluated = evaluateProposal(proposal, buildDocumentContext(inputs))
        if (!evaluated.ok) throw new Error(`${name}: server gate: ${evaluated.issues.join(',')}`)
        const document = assembleDocumentV2(
            documentMaterialV2(inputs, false),
            proposal,
            syntheticDocumentFactsV2(runtime.authoring),
            { sha256Hex, now: () => new Date(runtime.authoring.recordedAt) },
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
