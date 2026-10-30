import { createHash } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import {
    buildFallbackDocumentV2,
    createDemoManual,
    variantsOfV2,
    verifyDocumentAgainstInputsV2,
    visitVariantNodesV2,
    type ScreenContextInputsV2,
    type ScreenNodeV2,
} from './index'

const sha256Hex = (text: string): string => createHash('sha256').update(text).digest('hex')
const make = (inputs: ScreenContextInputsV2): ReturnType<typeof buildFallbackDocumentV2> =>
    buildFallbackDocumentV2(inputs, {
        sha256Hex,
        reason: 'disabled',
        evidence: 'local-deterministic',
        now: (): Date => new Date('2026-10-30T00:00:00.000Z'),
    })
const nodesOf = (variant: ReturnType<typeof make>): ScreenNodeV2[] => {
    const nodes: ScreenNodeV2[] = []
    visitVariantNodesV2(variant, '', ({ node }) => nodes.push(node))
    return nodes
}

describe('native camera and completion craft', () => {
    it.each(['manual-page', 'build-photo'] as const)(
        '%s explains framing and clarity with the existing icons',
        (mode) => {
            const session = mode === 'build-photo' ? createDemoManual() : null
            const inputs: ScreenContextInputsV2 = {
                kind: 'camera',
                session,
                stepId: session === null ? null : 'step-1',
                captureId: null,
                result: null,
                failure: null,
                uiState: { camera: { mode, permission: 'granted', failed: false, canAskAgain: true } },
            }
            const document = make(inputs)
            for (const variant of variantsOfV2(document).filter((entry) =>
                ['ready', 'busy', 'pending'].includes(entry.name),
            )) {
                const body = variant.variant.body
                if (body.type !== 'Scroll' || body.children[0]?.type !== 'Stack')
                    throw new Error('Expected camera spine')
                const card = body.children[0].children[1]
                expect(card?.type).toBe('Card')
                if (card?.type !== 'Card') throw new Error('Expected helpful camera card')
                expect(card.children.map((child) => child.type)).toEqual(['Row', 'Row'])
                for (const [index, row] of card.children.entries()) {
                    if (row.type !== 'Row') throw new Error('Expected icon and tip together')
                    expect(row.children).toHaveLength(2)
                    expect(row.children[0]).toMatchObject({ type: 'Icon', name: index === 0 ? 'image' : 'search' })
                    expect(row.children[1]).toMatchObject({ type: 'Text', role: 'body', content: { kind: 'literal' } })
                }
            }
            expect(verifyDocumentAgainstInputsV2(document, inputs, sha256Hex)).toEqual([])
        },
    )

    it.each([false, true])('names the manual in the completion body, complete witness %s', (complete) => {
        const session = createDemoManual()
        const inputs: ScreenContextInputsV2 = {
            kind: 'completion',
            session,
            stepId: null,
            captureId: null,
            result: null,
            failure: null,
            completedStepIds: complete ? session.reviewedSteps.map((step) => step.stepId) : [],
        }
        const document = make(inputs)
        expect(document.header.title).toEqual({ kind: 'literal', text: complete ? 'All steps done' : 'Your build' })
        expect(document.header.subtitle).toBeNull()
        expect(nodesOf(document)).toContainEqual(
            expect.objectContaining({ type: 'Text', content: { kind: 'bound', key: 'manual-title' } }),
        )
        expect(nodesOf(document)).toContainEqual(
            expect.objectContaining({ type: 'Text', content: { kind: 'literal', text: 'Find your manual on Home.' } }),
        )
        expect(nodesOf(document).filter((node) => node.type === 'Progress')).toHaveLength(1)
        expect(nodesOf(document).filter((node) => node.type === 'Meter')).toHaveLength(0)
        expect(document.bar.primary.intent).toEqual({ intent: 'navigate', target: 'home' })
        expect(verifyDocumentAgainstInputsV2(document, inputs, sha256Hex)).toEqual([])
    })
})
