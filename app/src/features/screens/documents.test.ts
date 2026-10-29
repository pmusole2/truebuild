import { screenDocumentSchema, type ScreenNode } from '@truebuild/contracts'
import { describe, expect, it } from 'vitest'
import { guardDocument, intentAllowed, parseDocument } from './documents'
import { hex, instruction, liveMetadata, makeDocument, randomBody, rng } from './test-support/documents'

const banner = (verdict: 'pass' | 'refuse' | 'cannot_verify'): ScreenNode => ({
    type: 'ResultBanner',
    verdict,
    text: 'The groove faces inward.',
    citations: [],
})

describe('parseDocument', () => {
    it('accepts a valid version 1 document', () => {
        expect(parseDocument(makeDocument())).not.toBeNull()
    })

    it.each([
        ['a future version', { ...makeDocument(), version: 2 }],
        ['an extra field', { ...makeDocument(), url: 'https://example.com' }],
        ['a missing bar', { ...makeDocument(), bar: undefined }],
        ['a non-object', 'hello'],
        ['null', null],
    ])('rejects %s', (_name, value) => {
        expect(parseDocument(value)).toBeNull()
    })

    it('rejects markup, a URL, a made-up intent target and an unknown icon', () => {
        const base = makeDocument()
        const body = (node: unknown): unknown => ({ ...base, body: [node] })
        for (const candidate of [
            body({ type: 'Instruction', text: '<b>Press</b> here', emphasis: 'strong', citations: [] }),
            body({ type: 'Instruction', text: 'Open https://evil.example now', emphasis: 'strong', citations: [] }),
            {
                ...base,
                bar: {
                    ...base.bar,
                    primary: { ...base.bar.primary, intent: { intent: 'navigate', target: '/admin' } },
                },
            },
            { ...base, bar: { ...base.bar, primary: { ...base.bar.primary, icon: 'skull' } } },
            body({ type: 'Script', code: 'alert(1)' }),
        ]) {
            expect(parseDocument(candidate)).toBeNull()
        }
    })

    it('rejects an instruction longer than twenty words', () => {
        const long = Array.from({ length: 21 }, (_, index) => `w${index}`).join(' ')
        expect(parseDocument({ ...makeDocument(), body: [instruction(long)] })).toBeNull()
    })
})

describe('guardDocument', () => {
    it('never shows a shell document: the native screen is the screen', () => {
        const shell = makeDocument({
            metadata: { ...liveMetadata(), source: 'shell', evidence: 'live', model: null, fallbackReason: 'disabled' },
            body: [],
        })
        expect(guardDocument(shell, {})).toBeNull()
    })

    it('keeps the server-owned origin of each kept component by its original path', () => {
        const document = makeDocument({
            metadata: liveMetadata(),
            body: [instruction('One'), banner('pass'), instruction('Three')],
        })
        const guarded = guardDocument(document, { decision: 'refuse' })!
        // The pass banner contradicts a held refusal: it goes, and the others keep their own paths.
        expect(guarded.body).toHaveLength(2)
        expect(guarded.paths).toEqual(['body.0', 'body.2'])
        expect(guarded.dropped).toBe(1)
    })

    it('rejects a whole result screen whose banner names another verdict', () => {
        const document = makeDocument({ kind: 'result', captureId: 'capture-1', body: [banner('pass')] })
        expect(guardDocument(document, { decision: 'refuse' })).toBeNull()
        expect(guardDocument(document, { decision: 'pass' })).not.toBeNull()
        expect(guardDocument(document, {})).toBeNull()
    })

    it('drops a verdict banner on a screen that holds no verdict at all', () => {
        const document = makeDocument({ body: [banner('pass'), instruction('Keep going')] })
        const guarded = guardDocument(document, {})!
        expect(guarded.body.map((node) => node.type)).toEqual(['Instruction'])
    })

    it('drops a tip whose target is not on this screen', () => {
        const document = makeDocument({
            body: [
                { type: 'Tip', targetId: 'guide-primary', heading: 'Big button', text: 'Tap here.' },
                { type: 'Tip', targetId: 'home-add', heading: 'Add', text: 'Tap here.' },
            ],
        })
        const guarded = guardDocument(document, { tipTargets: ['guide-primary'] })!
        expect(guarded.body).toHaveLength(1)
        expect(guarded.dropped).toBe(1)
    })

    it('drops a group whose child contradicts the held verdict, so child origins stay aligned', () => {
        const document = makeDocument({
            body: [{ type: 'Group', layout: 'stack', children: [banner('pass'), instruction('x')] as never }],
        })
        expect(guardDocument(document, { decision: 'refuse' })!.body).toEqual([])
    })

    it('rejects a document whose bar intent is outside the finite allowlist', () => {
        expect(intentAllowed({ intent: 'navigate', target: 'guide' })).toBe(true)
        expect(intentAllowed({ intent: 'navigate', target: 'camera' } as never)).toBe(false)
        expect(intentAllowed({ intent: 'delete', target: 'everything' } as never)).toBe(false)
    })

    it('treats randomly composed valid catalogs as documents and keeps every kept node on a real path', () => {
        for (let seed = 1; seed <= 60; seed++) {
            const random = rng(seed)
            const body = randomBody(random, 'capture-1')
            const document = makeDocument({ body, metadata: liveMetadata() })
            expect(screenDocumentSchema.safeParse(document).success).toBe(true)
            const guarded = guardDocument(document, { decision: 'pass' })!
            expect(guarded).not.toBeNull()
            expect(guarded.paths.length).toBe(guarded.body.length)
            for (const [index, path] of guarded.paths.entries()) {
                expect(document.metadata.origins?.[path]).toBeDefined()
                expect(guarded.body[index]).toBe(document.body[Number(path.split('.')[1])])
            }
        }
    })

    it('has a fixture document that is honestly synthetic and never claims a model', () => {
        const fixture = makeDocument()
        expect(fixture.metadata).toMatchObject({ source: 'fallback', evidence: 'synthetic-fixture', model: null })
        expect(hex('c')).toHaveLength(64)
    })
})
