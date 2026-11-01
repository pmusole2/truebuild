import { buildFallbackProposalV2, DOCUMENT_V2_LIMITS } from '@truebuild/contracts'
import { describe, expect, it } from 'vitest'

import { encodeWireProposal, type WireProposal } from '../../providers/document-wire'
import { documentInputs } from '../../test-support/document-inputs'
import { aiPolicyFromEnvironment, describeAiPolicy } from '../ai-policy'
import { buildDocumentContext } from './context'
import { evaluateWire } from './ground'
import { normalizeDocumentWire } from './normalize-wire'

const home = buildDocumentContext(documentInputs('home'))
const guide = buildDocumentContext(documentInputs('guide'))
const wireFor = (context = guide): WireProposal =>
    encodeWireProposal({ ...buildFallbackProposalV2(context.material), overlays: [] })
const defaults = {
    checkTimeoutMs: 8_000,
    parseModel: 'muse-spark-1.3' as const,
    verdictModel: 'muse-spark-1.3' as const,
    secondOpinionModel: 'muse-wonder-1.0' as const,
}

describe('document wire normalization', () => {
    it('keeps the first graph occurrence without rewriting surviving content and bounds malformed graphs', () => {
        const base = wireFor()
        const root = base.nodes.find((node) => node.id === base.body)!
        const firstId = root.children![0]!
        const first = base.nodes.find((node) => node.id === firstId)!
        const value = {
            ...base,
            overlays: [],
            nodes: [
                { ...root, children: [...root.children!, firstId, 'unknown', 'empty', 'cycle'] },
                ...base.nodes.filter((node) => node.id !== root.id),
                { ...first, label: 'DO NOT KEEP DUPLICATE', id: firstId },
                { type: 'Stack', id: 'empty', children: [firstId], gap: 'md', align: 'stretch' },
                { type: 'Stack', id: 'cycle', children: ['cycle'], gap: 'md', align: 'stretch' },
                { ...first, id: 'orphan' },
            ],
        }
        const original = structuredClone(value)
        const normalized = normalizeDocumentWire(value, guide)
        const result = normalized.value as typeof value
        expect(value).toEqual(original)
        expect(result.nodes.find((node) => node.id === root.id)?.children).toEqual(root.children)
        expect(result.nodes.find((node) => node.id === firstId)).toEqual(first)
        expect(result.nodes.map((node) => node.id).sort()).toEqual(base.nodes.map((node) => node.id).sort())
        expect(result.header).toEqual(base.header)
        expect(result.bar).toEqual(base.bar)
        expect(normalized.issueCodes).toContain(`normalization.nodes.${firstId}:duplicate_id`)
        expect(normalized.issueCodes).toContain('normalization.nodes.orphan:unreachable_node')
        expect(JSON.stringify(normalized.issueCodes)).not.toContain('DO NOT KEEP')
        expect(evaluateWire(value, guide).ok).toBe(false)
        expect(evaluateWire(result, guide).ok).toBe(true)
        expect(normalizeDocumentWire(result, guide)).toEqual({ value: result, issueCodes: [] })

        for (const ungrounded of [
            { ...base, header: { ...base.header, title: { kind: 'literal', text: 'UNLISTED COPY' } } },
            { ...base, header: { ...base.header, title: { kind: 'bound', key: 'not-a-binding' } } },
            {
                ...base,
                bar: {
                    ...base.bar,
                    primary: { ...base.bar.primary, intent: { intent: 'retry', target: 'reading' } },
                },
            },
        ]) {
            const ungroundedResult = normalizeDocumentWire(ungrounded, guide).value
            expect(ungroundedResult).toEqual(ungrounded)
            expect(evaluateWire(ungroundedResult, guide).ok).toBe(false)
        }

        const circular: Record<string, unknown> = { ...base }
        circular.extra = circular
        let nested: unknown = null
        for (let i = 0; i < 50; i += 1) nested = { nested }
        for (const invalid of [
            { ...base, nodes: [{ id: 'UNTRUSTED\nLOG', type: 'Stack', children: [] }] },
            { ...base, nodes: new Array(DOCUMENT_V2_LIMITS.documentNodes + 1).fill(root) },
            { ...base, nodes: [{ ...root, children: [42] }] },
            { ...base, extra: nested },
            circular,
        ]) {
            const unchanged = normalizeDocumentWire(invalid, guide)
            expect(unchanged.value).toBe(invalid)
            expect(unchanged.issueCodes.every((code) => /^[A-Za-z0-9_.:-]+$/u.test(code))).toBe(true)
        }
        const deep = {
            ...base,
            nodes: [
                ...Array.from({ length: DOCUMENT_V2_LIMITS.depth + 3 }, (_, index) => ({
                    ...root,
                    id: `d${index}`,
                    children: index === DOCUMENT_V2_LIMITS.depth + 2 ? [firstId] : [`d${index + 1}`],
                })),
                first,
            ],
            body: 'd0',
        }
        expect(normalizeDocumentWire(deep, guide).value).toBe(deep)
    })

    it('drops only invalid overlay coach marks, preserves valid overlays and body errors, and removes only Home back', () => {
        const base = wireFor(home)
        const coach = {
            id: 'coach',
            type: 'CoachMark',
            targetId: 'home-add',
            heading: 'Add a manual',
            body: 'Start here to add the manual you are building from.',
            placement: 'auto',
        }
        const overlay = { kind: 'tooltip', anchor: 'home-add', content: 'coach' }
        const value = { ...base, nodes: [...base.nodes, coach], overlays: [overlay] }
        expect(normalizeDocumentWire(value, home).value).toEqual(value)
        for (const invalidCoach of [
            { ...coach, heading: 'Unlisted heading' },
            { ...coach, placement: 'elsewhere' },
            { ...coach, targetId: 'camera-shutter' },
            { ...coach, children: ['unknown'] },
            { id: 'coach', type: 'Spacer', size: 'md' },
        ]) {
            const invalid = { ...value, nodes: [...base.nodes, invalidCoach] }
            const normalized = normalizeDocumentWire(invalid, home).value as typeof invalid
            expect(normalized.overlays).toEqual([])
            expect(normalized.nodes).toEqual(base.nodes)
            expect(evaluateWire(normalized, home).ok).toBe(true)
        }
        const wrongAnchor = { ...value, overlays: [{ ...overlay, anchor: 'header-more' }] }
        expect((normalizeDocumentWire(wrongAnchor, home).value as typeof value).overlays).toEqual([])
        const root = base.nodes.find((node) => node.id === base.body)!
        const bodyCoach = {
            ...value,
            nodes: [
                ...base.nodes.filter((node) => node.id !== root.id),
                { ...root, children: [...root.children!, 'coach'] },
                { ...coach, heading: 'Unlisted heading' },
            ],
        }
        const bodyResult = normalizeDocumentWire(bodyCoach, home).value as typeof bodyCoach
        expect(bodyResult.nodes.find((node) => node.id === 'coach')?.heading).toBe('Unlisted heading')
        expect(evaluateWire(bodyResult, home).ok).toBe(false)
        const bodyChildren = {
            ...bodyCoach,
            nodes: bodyCoach.nodes.map((node) => (node.id === 'coach' ? { ...node, children: ['unknown'] } : node)),
        }
        const bodyChildrenResult = normalizeDocumentWire(bodyChildren, home).value as typeof bodyChildren
        expect(bodyChildrenResult.nodes.find((node) => node.id === 'coach')).toMatchObject({
            heading: 'Unlisted heading',
            children: ['unknown'],
        })
        expect(evaluateWire(bodyChildrenResult, home).ok).toBe(false)
        const back = { label: 'Back', intent: { intent: 'navigate', target: 'guide' } }
        const homeBack = { ...base, header: { ...base.header, back } }
        expect((normalizeDocumentWire(homeBack, home).value as typeof homeBack).header.back).toBeNull()
        const guideBack = { ...wireFor(), header: { ...wireFor().header, back } }
        expect((normalizeDocumentWire(guideBack, guide).value as typeof guideBack).header.back).toEqual(back)
    })

    it('defaults normalization on and accepts only the existing numeric boolean flag style', () => {
        for (const [setting, enabled] of [
            [undefined, true],
            ['', true],
            ['1', true],
            ['0', false],
        ] as const) {
            const policy = aiPolicyFromEnvironment({ AI_DOCUMENT_NORMALIZATION: setting }, defaults)
            expect(policy.documentNormalization).toBe(enabled)
            expect(describeAiPolicy(policy).documentNormalization).toBe(enabled)
        }
        for (const setting of ['true', 'false', 'yes', '2']) {
            expect(() => aiPolicyFromEnvironment({ AI_DOCUMENT_NORMALIZATION: setting }, defaults)).toThrow(
                'invalid_ai_document_normalization',
            )
        }
    })
})
