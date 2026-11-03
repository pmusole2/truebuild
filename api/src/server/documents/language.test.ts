import type { ManualSession } from '@truebuild/contracts'
import { describe, expect, it, vi } from 'vitest'

import { createDocumentFixtureGenerator } from '../../providers/document-fixtures'
import { createMetaProvider } from '../../providers/meta-provider'
import { demoSession, documentInputs } from '../../test-support/document-inputs'
import { aiPolicyFromEnvironment } from '../ai-policy'
import type { BackgroundWork } from '../screens/service'
import { buildDocumentContext } from './context'
import { createDocumentService } from './service'

// The manual was parsed in French; its facts are the demo facts. Only the language code differs.
const FRENCH: ManualSession = { ...demoSession(), parsedLanguage: 'fr-CA' }

const work: BackgroundWork = {
    run: (_options, job) => job(),
    repair: (job) => job(),
    tryAcquire: () => () => {},
    acquire: async () => () => {},
}

const policy = aiPolicyFromEnvironment(
    {},
    {
        checkTimeoutMs: 8_000,
        parseModel: 'muse-spark-1.3',
        verdictModel: 'muse-spark-1.3',
        secondOpinionModel: 'muse-wonder-1.0',
    },
)

/** The text the provider is shown for one document request: every input_text part, joined. */
const sentText = (body: Record<string, unknown>): string =>
    (body.input as { content: { text?: string }[] }[])
        .flatMap((message) => message.content.map((part) => part.text ?? ''))
        .join('\n')

describe('document language', () => {
    it.each(['guide', 'result', 'answer'] as const)('%s asks the provider for the parsed language code', (kind) => {
        const context = buildDocumentContext(documentInputs(kind, FRENCH))
        expect(context.view.dynamic.document).toMatchObject({ language: 'fr-CA' })
    })

    it('keeps English exactly for a session with no parsed code, and a reading preference alone changes nothing', () => {
        const legacy = buildDocumentContext(documentInputs('guide'))
        expect(legacy.view.dynamic.document).toMatchObject({ language: 'en' })
        const explicit = buildDocumentContext(documentInputs('guide', { ...demoSession(), parsedLanguage: 'en' }))
        expect(explicit.bound.contextKey).toBe(legacy.bound.contextKey)
        const picked = buildDocumentContext(documentInputs('guide', { ...demoSession(), readingLanguage: 'fr-CA' }))
        expect(picked.bound.contextKey).toBe(legacy.bound.contextKey)
        expect(picked.view.dynamic.document).toMatchObject({ language: 'en' })
    })

    it('composes a French manual again instead of serving its English cache entry', async () => {
        const generator = createDocumentFixtureGenerator()
        const seen: string[] = []
        const service = createDocumentService({
            provider: null,
            fixtureGenerator: async (request, signal) => {
                seen.push(String((request.context.view.dynamic.document as { language?: unknown }).language))
                return generator(request, signal)
            },
            policy,
            runtimeMode: 'fixture',
            work,
        })
        await service.generate(documentInputs('guide'))
        const french = await service.generate(documentInputs('guide', FRENCH))
        expect(french.metadata.cacheHit).toBe(false)
        expect(seen).toEqual(['en', 'fr-CA'])
        const again = await service.generate(documentInputs('guide', FRENCH))
        expect(again.metadata.cacheHit).toBe(true)
        expect(seen).toEqual(['en', 'fr-CA'])
    })

    it('sends the parsed code in the provider request, and English for a session without one', async () => {
        const bodies: Record<string, unknown>[] = []
        const provider = createMetaProvider({
            apiKey: 'synthetic-test-key',
            policy,
            fetchImpl: vi.fn<typeof fetch>(async (_url, init) => {
                const body = JSON.parse(String(init?.body)) as Record<string, unknown>
                bodies.push(body)
                return Response.json({
                    status: 'completed',
                    model: body.model,
                    output: [
                        {
                            type: 'message',
                            role: 'assistant',
                            status: 'completed',
                            content: [{ type: 'output_text', text: '{}', annotations: [] }],
                        },
                    ],
                })
            }),
        })
        for (const [requestId, session] of [
            ['french', FRENCH],
            ['legacy', demoSession()],
        ] as const) {
            const context = buildDocumentContext(documentInputs('guide', session))
            await provider.generateDocument!(
                { requestId, stage: context.stage, stable: context.view.stable, dynamic: context.view.dynamic },
                new AbortController().signal,
            )
        }
        expect(sentText(bodies[0]!)).toContain('"language":"fr-CA"')
        expect(sentText(bodies[1]!)).toContain('"language":"en"')
        expect(String(bodies[0]!.instructions)).toContain('document.language')
    })
})
