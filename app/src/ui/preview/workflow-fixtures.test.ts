import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
    checkResultSchema,
    manualSessionSchema,
    partRegionSchema,
    questionResultSchema,
    stepEvidenceRequirements,
} from '@truebuild/contracts'
import { stepPartChoices } from '../../features/assembly/question-state'
import { partGuidance } from '../../features/capture/part-regions'
import { SYNTHETIC_STOOL_LABEL, syntheticStoolManual } from './synthetic-stool-manual'
import { WORKFLOW_PREVIEW_CASES, workflowPreviewFixture } from './workflow-fixtures'

describe('synthetic workflow preview fixtures', () => {
    it('keeps every selectable workflow state valid and all imagery inline', () => {
        expect(WORKFLOW_PREVIEW_CASES).toHaveLength(39)
        for (const preview of WORKFLOW_PREVIEW_CASES) {
            const { state, entry } = workflowPreviewFixture(preview.id)
            expect(manualSessionSchema.safeParse(entry.session).success, preview.id).toBe(true)
            for (const uri of Object.values(state.pageUris)) {
                expect(uri.startsWith('data:image/'), preview.id).toBe(true)
            }
            if (state.capture !== null) {
                expect(state.capture.observation.uri.startsWith('data:image/'), preview.id).toBe(true)
                expect(state.capture.observation.bytes.byteLength).toBeGreaterThan(0)
            }
            if (state.check !== null) {
                expect(checkResultSchema.safeParse(state.check).success, preview.id).toBe(true)
            }
            if (state.answer !== null) {
                expect(questionResultSchema.safeParse(state.answer).success, preview.id).toBe(true)
                expect(state.check).toBeNull()
            }
        }
    })

    it('creates independent synthetic snapshots and keeps unresolved facts unknown', () => {
        const unresolved = workflowPreviewFixture('review-unresolved')
        expect(unresolved.entry.session.reviewStatus).not.toBe('reviewed')
        expect(unresolved.entry.session.reviewedSteps[0]?.orientation.state).toBe('unknown')
        unresolved.entry.session.title = 'Local draft'
        expect(workflowPreviewFixture('review-ready').entry.session.title).not.toBe('Local draft')
        expect(workflowPreviewFixture('home-empty').state.entries).toEqual([])
        expect(workflowPreviewFixture('guide-empty').state.capture).toBeNull()
    })
})

describe('inert region fixtures (synthetic, mocked, no API)', () => {
    const names = (id: Parameters<typeof workflowPreviewFixture>[0]): Map<string, string> => {
        const { entry } = workflowPreviewFixture(id)
        const step = entry.session.reviewedSteps[entry.stepIndex]!
        return new Map(stepPartChoices(entry.session, step).map((choice) => [choice.partId, choice.label]))
    }
    const guidanceOf = (id: Parameters<typeof workflowPreviewFixture>[0]): ReturnType<typeof partGuidance> => {
        const { state } = workflowPreviewFixture(id)
        return partGuidance(state.answer ?? state.check, names(id))
    }

    it('keeps every existing result fixture free of next-part and target regions', () => {
        for (const id of ['guide-pass', 'guide-refuse', 'guide-cannot-verify', 'guide-answer'] as const) {
            expect(guidanceOf(id), id).toEqual({ next: null, target: null, arrow: false, captions: [] })
        }
    })

    it.each([
        'guide-pass-guided',
        'guide-refuse-guided',
        'guide-answer-guided',
        'guide-stool-guided',
        'guide-portrait-guided',
    ] as const)('gives %s a valid next part and target for one real step part, which pair into an arrow', (id) => {
        const { state } = workflowPreviewFixture(id)
        const result = state.answer ?? state.check
        expect(partRegionSchema.safeParse(Reflect.get(result!, 'nextPartRegion')).success).toBe(true)
        expect(partRegionSchema.safeParse(Reflect.get(result!, 'targetRegion')).success).toBe(true)
        const guidance = guidanceOf(id)
        expect(guidance.next).not.toBeNull()
        expect(guidance.target).not.toBeNull()
        expect(guidance.arrow).toBe(true)
    })

    it('gives next-only exactly one located field, no target and no arrow', () => {
        const guidance = guidanceOf('guide-pass-next-only')
        expect(guidance.next?.partId).toBe('divider')
        expect(guidance.target).toBeNull()
        expect(guidance.arrow).toBe(false)
    })

    it('gives the unpaired second-manual fixture two different real parts and no arrow', () => {
        const guidance = guidanceOf('guide-stool-mismatched')
        expect(guidance.next?.partId).toBe('folding-leg')
        expect(guidance.target?.partId).toBe('seat-plate')
        expect(guidance.arrow).toBe(false)
    })

    it('puts the divider fixtures on the second step, where the divider is a real part', () => {
        for (const id of [
            'guide-pass-guided',
            'guide-pass-next-only',
            'guide-refuse-guided',
            'guide-answer-guided',
        ] as const) {
            const { entry, state } = workflowPreviewFixture(id)
            expect(entry.stepIndex).toBe(1)
            expect(state.capture?.binding.stepId).toBe(entry.session.reviewedSteps[1]!.stepId)
        }
    })

    it('carries a valid model layout in the layout fixture, and only for references the step owns', () => {
        const { state, entry } = workflowPreviewFixture('guide-pass-layout')
        expect(state.check?.layout?.source).toBe('model')
        const step = entry.session.reviewedSteps[0]!
        expect(step.visibleChecks.map((check) => check.checkId)).toContain('groove-inward')
        expect(stepEvidenceRequirements(step).orientation).toBe(true)
    })

    it('uses a second manual unrelated to the sample, clearly labelled as mocked', () => {
        const stool = syntheticStoolManual()
        const sample = workflowPreviewFixture('guide-pass').entry.session
        expect(manualSessionSchema.safeParse(stool).success).toBe(true)
        expect(stool.title).toBe(SYNTHETIC_STOOL_LABEL)
        expect(stool.title).toContain('MOCKED')
        const shared = stool.parts.filter((part) => sample.parts.some((other) => other.partId === part.partId))
        expect(shared).toEqual([])
        expect(stool.manualId).not.toBe(sample.manualId)
    })

    describe('per-manual media', () => {
        const decodedSvg = (uri: string): string =>
            decodeURIComponent(uri.slice('data:image/svg+xml;charset=utf-8,'.length))
        const pngSize = (bytes: Uint8Array): { width: number; height: number } => {
            const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
            return { width: view.getUint32(16), height: view.getUint32(20) }
        }

        it.each(['guide-stool-guided', 'guide-stool-mismatched'] as const)(
            "%s shows the stool manual's own mocked page and photo, never the grooved-shelf art",
            (id) => {
                const { state, entry } = workflowPreviewFixture(id)
                const pageId = entry.session.pages[0]!.pageId
                const diagram = decodedSvg(state.pageUris[pageId]!)
                expect(diagram).toContain('camp stool')
                expect(diagram).toContain('MOCKED')
                expect(diagram).not.toContain('groove faces inward')
                // Every cited page resolves to that art, so the source diagram and the page strip agree.
                const step = entry.session.reviewedSteps[entry.stepIndex]!
                for (const ref of [...step.sourceRefs, ...(state.check?.sourceRefs ?? [])]) {
                    expect(state.pageUris[ref.pageId], ref.pageId).toBe(state.pageUris[pageId])
                }
                const { observation, binding } = state.capture!
                expect(observation.mimeType).toBe('image/png')
                expect(Array.from(observation.bytes.slice(0, 8))).toEqual([137, 80, 78, 71, 13, 10, 26, 10])
                expect(pngSize(observation.bytes)).toEqual({ width: observation.width, height: observation.height })
                expect(observation.uri).toBe(
                    `data:image/png;base64,${Buffer.from(observation.bytes).toString('base64')}`,
                )
                expect(observation.width).toBe(entry.session.pages[0]!.width)
                expect(observation.height).toBe(entry.session.pages[0]!.height)
                expect(binding.manualId).toBe(entry.session.manualId)
                expect(binding.stepId).toBe(step.stepId)
            },
        )

        it('keeps the grooved-shelf cases on their own art, distinct from the stool photo', () => {
            const shelf = workflowPreviewFixture('guide-pass').state
            const stool = workflowPreviewFixture('guide-stool-guided').state
            expect(Object.values(shelf.pageUris)[0]).not.toBe(Object.values(stool.pageUris)[0])
            expect(shelf.capture!.observation.uri).not.toBe(stool.capture!.observation.uri)
            expect(decodedSvg(Object.values(shelf.pageUris)[0]!)).toContain('groove faces inward')
            expect(pngSize(shelf.capture!.observation.bytes)).toEqual({ width: 600, height: 400 })
        })
    })

    it('keeps the portrait case truthful: a real 400 x 600 PNG and a 400 x 600 page, never the landscape bytes', () => {
        const { state, entry } = workflowPreviewFixture('guide-portrait-guided')
        const { observation } = state.capture!
        const view = new DataView(observation.bytes.buffer, observation.bytes.byteOffset, observation.bytes.byteLength)
        expect(Array.from(observation.bytes.slice(0, 8))).toEqual([137, 80, 78, 71, 13, 10, 26, 10])
        expect({ width: view.getUint32(16), height: view.getUint32(20) }).toEqual({ width: 400, height: 600 })
        expect({ width: observation.width, height: observation.height }).toEqual({ width: 400, height: 600 })
        expect(observation.uri).toBe(`data:image/png;base64,${Buffer.from(observation.bytes).toString('base64')}`)
        const page = entry.session.pages[0]!
        expect({ width: page.width, height: page.height }).toEqual({ width: 400, height: 600 })
        const art = decodeURIComponent(state.pageUris[page.pageId]!.slice('data:image/svg+xml;charset=utf-8,'.length))
        expect(art).toContain('width="400" height="600"')
        expect(art).toContain('MOCKED')
        expect(entry.session.title).toContain('MOCKED')
        // The landscape cases are untouched.
        const stool = workflowPreviewFixture('guide-stool-guided')
        expect({
            width: stool.state.capture!.observation.width,
            height: stool.state.capture!.observation.height,
        }).toEqual({
            width: 600,
            height: 400,
        })
        expect(stool.entry.session.pages[0]!.width).toBe(600)
    })

    it('imports no API client, transport or network code into the fixtures', () => {
        for (const file of [
            'workflow-fixtures.ts',
            'synthetic-stool-manual.ts',
            'synthetic-stool-art.ts',
            'synthetic-stool-photo-png.ts',
            'synthetic-portrait-art.ts',
            'synthetic-portrait-photo-png.ts',
        ]) {
            const source = readFileSync(join(import.meta.dirname, file), 'utf8')
            expect(source, file).not.toMatch(/from '[^']*(api\/|client|transport|fetch)[^']*'/u)
            expect(source, file).not.toMatch(/\bfetch\(|XMLHttpRequest|process\.env/u)
        }
    })
})
