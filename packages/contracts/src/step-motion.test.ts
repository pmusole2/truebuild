import { describe, expect, it } from 'vitest'
import {
    clampStepMotionBevels,
    dropDegenerateStepMotionShapes,
    paddedStepFigureBox,
    STEP_MOTION_PROMPT_VERSION,
    stepMotionCacheIdentity,
    stepMotionRequestSchema,
    stepMotionResultSchema,
    stepMotionSceneSchema,
    type StepMotionRequest,
} from './step-motion'
import { createDemoManual, manualStepSchema } from './index'

const shape = {
    type: 'box',
    dimensions: { width: 2, height: 1, depth: 1 },
    position: [0, 0, 0],
    rotation: [0, 0, 0],
}
const motions = [
    { kind: 'rotate', pivot: [0, 0, 0], axis: [0, 0, 1], fromDeg: -90, toDeg: 0 },
    { kind: 'translate', from: [0, 2, 0], to: [0, 0, 0] },
    { kind: 'screw', axis: [0, 1, 0], travel: 0.5, turns: 2 },
]
const request: StepMotionRequest = {
    requestId: 'request-1',
    manualHash: 'a'.repeat(64),
    stepId: 'step-1',
    readingLanguage: 'en',
    instructionText: 'Turn the part.',
    sourceRefs: [{ pageId: 'page-1', region: null }],
    parts: [],
    actions: [],
    orientation: null,
    connection: null,
    page: { pageId: 'page-1', width: 1024, height: 768, mimeType: 'image/png', contentHash: 'b'.repeat(64) },
    figureBox: null,
}
const scene = (motion: unknown): object => ({
    version: 1,
    stepId: 'step-1',
    still: [shape],
    movers: [{ label: 'Part', shapes: [shape], motion, actionIndex: null }],
    caption: 'Place the part as shown.',
})

describe('step motion contract', () => {
    it('keeps optional verbatim source text compatible with saved and wordless steps', () => {
        const legacy = createDemoManual().rawExtraction!.steps[0]!
        const sourceText = '  Tournez la pièce.\nSerrez-la.  '
        expect(manualStepSchema.parse(legacy)).toEqual(legacy)
        expect(manualStepSchema.parse({ ...legacy, sourceText }).sourceText).toBe(sourceText)
        expect(manualStepSchema.parse({ ...legacy, sourceText: null }).sourceText).toBeNull()
        expect(manualStepSchema.safeParse({ ...legacy, sourceText: 'x'.repeat(601) }).success).toBe(false)
    })

    it('accepts rounded unit axes without rewriting them and pads figure regions within the page', () => {
        const rounded = scene({ ...motions[0], axis: [0.707, 0, 0.707] })
        expect(stepMotionSceneSchema.parse(rounded)).toEqual(rounded)
        const padded = paddedStepFigureBox([0.25, 0.25, 0.5, 0.5])
        for (const [index, value] of [0.2, 0.2, 0.6, 0.6].entries()) expect(padded[index]).toBeCloseTo(value, 9)
        const clipped = paddedStepFigureBox([0, 0.9, 0.2, 0.1])
        expect(clipped[0]).toBe(0)
        expect(clipped[1] + clipped[3]).toBe(1)
    })
    it.each(motions)('accepts a bounded $kind scene and its finished geometry', (motion) => {
        expect(stepMotionSceneSchema.parse(scene(motion))).toEqual(scene(motion))
    })

    it('accepts a three-mover sequence and a null scene', () => {
        const sequence = {
            ...scene(motions[0]),
            movers: motions.map((motion, actionIndex) => ({ label: 'Part', shapes: [shape], motion, actionIndex })),
        }
        expect(stepMotionSceneSchema.parse(sequence)).toEqual(sequence)
        expect(stepMotionSceneSchema.parse(null)).toBeNull()
    })

    it('rejects out-of-range, non-finite, non-unit, extra and excessive data without repairing it', () => {
        for (const motion of [
            { ...motions[0], fromDeg: 181 },
            { ...motions[0], pivot: [Number.NaN, 0, 0] },
            { ...motions[0], axis: [0, 0, 2] },
            { ...motions[1], from: [Infinity, 0, 0] },
            { ...motions[2], turns: 5 },
            { ...motions[2], travel: 101 },
        ])
            expect(stepMotionSceneSchema.safeParse(scene(motion)).success).toBe(false)
        expect(stepMotionSceneSchema.safeParse({ ...scene(motions[0]), extra: true }).success).toBe(false)
        expect(stepMotionSceneSchema.safeParse({ ...scene(motions[0]), still: Array(25).fill(shape) }).success).toBe(
            false,
        )
        const invalidShape = { ...shape, position: [0, 1001, 0] }
        expect(stepMotionSceneSchema.safeParse({ ...scene(motions[0]), still: [invalidShape] }).success).toBe(false)
    })

    it('requires the verified raw page hash and keeps cache identity free of transport ids', () => {
        expect(stepMotionRequestSchema.parse(request)).toEqual(request)
        const { contentHash: _contentHash, ...unhashed } = request.page
        for (const page of [
            unhashed,
            { ...request.page, contentHash: 'B'.repeat(64) },
            { ...request.page, contentHash: 'b' },
        ])
            expect(stepMotionRequestSchema.safeParse({ ...request, page }).success).toBe(false)
        const identity = stepMotionCacheIdentity(request)
        expect(stepMotionCacheIdentity({ ...request, requestId: 'other', cacheOnly: true })).toBe(identity)
        expect(
            stepMotionCacheIdentity({ ...request, page: { ...request.page, contentHash: 'c'.repeat(64) } }),
        ).not.toBe(identity)
        expect(stepMotionCacheIdentity(request, STEP_MOTION_PROMPT_VERSION + 1)).not.toBe(identity)
    })

    it('clamps an out-of-range extrude bevel to its limit, and only that field', () => {
        const extrude = {
            type: 'extrude',
            outline: [
                [0, 0],
                [1, 0],
                [1, 1],
                [0, 1],
            ],
            depth: 0.2,
            bevel: 0.5,
            position: [0, 0, 0],
            rotation: [0, 0, 0],
        }
        const value = { scene: { ...scene(motions[0]), still: [extrude] } }
        expect(stepMotionResultSchema.safeParse(value).success).toBe(false)
        const clamped = stepMotionResultSchema.safeParse(clampStepMotionBevels(value))
        expect(clamped.success).toBe(true)
        expect(clamped.success && clamped.data.scene?.still[0]).toMatchObject({ bevel: 0.2 * 0.25 })
        expect(clampStepMotionBevels({ scene: null })).toEqual({ scene: null })
        const inRange = { scene: { ...scene(motions[0]), still: [{ ...extrude, bevel: 0.01 }] } }
        expect(clampStepMotionBevels(inRange)).toEqual(inRange)
    })
})

it('drops only otherwise-valid zero-area or near-zero-depth extrudes before strict validation', () => {
    const extrude = {
        type: 'extrude',
        outline: [
            [0, 0],
            [1, 0],
            [2, 0],
        ],
        depth: 0.2,
        position: [0, 0, 0],
        rotation: [0, 0, 0],
    }
    const thin = {
        ...extrude,
        outline: [
            [0, 0],
            [1, 0],
            [1, 1],
        ],
        depth: 0.00001,
    }
    const value = { scene: { ...scene(motions[0]), still: [shape, extrude, thin] } }
    expect(stepMotionResultSchema.safeParse(value).success).toBe(false)
    expect(stepMotionResultSchema.parse(dropDegenerateStepMotionShapes(value)).scene?.still).toEqual([shape])
    expect(
        stepMotionResultSchema.parse(
            dropDegenerateStepMotionShapes({
                scene: {
                    ...scene(motions[0]),
                    movers: [{ label: 'Part', shapes: [shape, extrude], motion: motions[0], actionIndex: null }],
                },
            }),
        ).scene?.movers[0]?.shapes,
    ).toEqual([shape])
    for (const invalid of [
        null,
        { ...extrude, surprise: true },
        { ...extrude, position: [Infinity, 0, 0] },
        {
            ...extrude,
            outline: [
                [0, 0],
                [1001, 0],
                [2, 0],
            ],
        },
        { ...thin, depth: -1 },
        {
            ...extrude,
            outline: [
                [0, 0],
                [1, 1],
                [0, 1],
                [1, 0],
            ],
        },
    ]) {
        expect(
            stepMotionResultSchema.safeParse(
                dropDegenerateStepMotionShapes({
                    scene: { ...scene(motions[0]), still: [shape, invalid] },
                }),
            ).success,
        ).toBe(false)
    }
    const duplicated = {
        ...thin,
        depth: 0.2,
        outline: [
            [0, 0],
            [1, 0],
            [1, 0],
            [1, 1],
            [0, 0],
        ],
    }
    const normalized = stepMotionResultSchema.parse(
        dropDegenerateStepMotionShapes({
            scene: {
                ...scene(motions[0]),
                still: [duplicated],
            },
        }),
    ).scene
    expect(normalized?.still[0]).toMatchObject({
        outline: [
            [0, 0],
            [1, 0],
            [1, 1],
        ],
    })
    expect(
        stepMotionResultSchema.safeParse(
            dropDegenerateStepMotionShapes({
                scene: {
                    ...scene(motions[0]),
                    still: [shape, ...Array(24).fill(extrude)],
                },
            }),
        ).success,
    ).toBe(false)
    expect(
        stepMotionResultSchema.safeParse(
            dropDegenerateStepMotionShapes({
                scene: {
                    ...scene(motions[0]),
                    movers: [{ label: 'Part', shapes: [extrude], motion: motions[0], actionIndex: null }],
                },
            }),
        ).success,
    ).toBe(false)
})

it('keeps nonzero-area outlines independent of cyclic ordering, leaving tiny edges to strict validation', () => {
    for (const firstEdge of [0.00005, 0.002]) {
        const outline = [
            [0, 0],
            [firstEdge, 0],
            [100, 0],
            [100, 0.01],
            [0, 0.01],
        ]
        for (const ordered of [outline, [...outline.slice(1), outline[0]!]]) {
            const plate = { type: 'extrude', outline: ordered, depth: 1, position: [0, 0, 0], rotation: [0, 0, 0] }
            const value = { scene: { ...scene(motions[0]), still: [shape, plate] } }
            const normalized = dropDegenerateStepMotionShapes(value)
            expect(normalized).toEqual(value)
            expect(stepMotionResultSchema.safeParse(normalized).success).toBe(firstEdge > 0.001)
        }
    }
})

it.each([0, 1])('drops a collinear outline with a tiny edge in cyclic ordering %i', (offset) => {
    const outline = [
        [0, 0],
        [0.00005, 0],
        [100, 0],
        [50, 0],
    ]
    const extrude = {
        type: 'extrude',
        outline: [...outline.slice(offset), ...outline.slice(0, offset)],
        depth: 1,
        position: [0, 0, 0],
        rotation: [0, 0, 0],
    }
    const value = { scene: { ...scene(motions[0]), still: [shape, extrude] } }
    expect(stepMotionResultSchema.parse(dropDegenerateStepMotionShapes(value)).scene?.still).toEqual([shape])
})
