import { expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import {
    dropDegenerateStepMotionShapes,
    stepMotionHardQualityIssues,
    stepMotionQualityIssues,
    stepMotionResultSchema,
    type StepMotionScene,
} from '@truebuild/contracts'

const loadScene = (name: string): StepMotionScene =>
    stepMotionResultSchema.parse(
        dropDegenerateStepMotionShapes(
            JSON.parse(readFileSync(new URL(`../test-support/motion-scenes/${name}.json`, import.meta.url), 'utf8')),
        ),
    ).scene!

it.each([
    'drone-install-first',
    'drone-install-repair',
    'phase5-noble-s1-a2-first',
    'phase5-noble-s1-a2-repair',
    'phase5-treadmill-s2-a1-first',
    'phase5-treadmill-s2-a1-repair',
    'phase5-treadmill-s2-a2-first',
    'phase5-treadmill-s2-a2-repair',
    'phase5-treadmill-s2-a3-first',
    'phase5-treadmill-s2-a3-repair',
    'phase5-treadmill-s2-a4-first',
    'phase5-treadmill-s3-a1-first',
    'phase5-treadmill-s3-a2-first',
    'rogue-step-1',
    'treadmill-step-2-try2-first',
    'treadmill-step-2-try2-repair',
])('passes the captured readable scene %s', (name) => {
    expect(stepMotionQualityIssues(loadScene(name))).toEqual([])
})

it.each([
    // Vertical unrotated table top and a screw floating away from it.
    { name: 'ikea-step-1', issues: ['quality_detached:movers.0', 'suspect_on_edge:still.0'] },
    // Upturned seat modelled standing on edge.
    { name: 'noble-step-1', issues: ['suspect_on_edge:still.0'] },
    // Degenerate one-unit plates and a mover nowhere near them.
    { name: 'noble-step-2', issues: ['quality_detached:movers.0', 'quality_speck:movers.0'] },
    // Phone support drawn as three tiny rings over grey specks: the confusing step-3 scene.
    { name: 'treadmill-step-3-first', issues: ['quality_speck:movers.0'] },
    { name: 'treadmill-step-3-repair', issues: ['quality_speck:movers.0'] },
])('flags the captured confusing scene $name', ({ name, issues }) => {
    expect(stepMotionQualityIssues(loadScene(name))).toEqual(issues)
})

it('flags an upright scene whose receiving body is missing, as in the broken step-2 screenshot', () => {
    const good = loadScene('phase5-treadmill-s2-a1-first')
    const speck = (x: number): StepMotionScene['still'][number] => ({
        type: 'box',
        dimensions: { width: 1, height: 1, depth: 1 },
        position: [x, 0.5, 35],
        rotation: [0, 0, 0],
    })
    const broken = { ...good, still: [speck(-40), speck(40)] }
    expect(stepMotionHardQualityIssues(broken)).toContain('quality_no_anchor')
})

it('flags a deck standing on its edge, as in the broken step-3 screenshot, without condemning it outright', () => {
    const good = loadScene('phase5-treadmill-s3-a2-first')
    const deck = good.still[0]!
    if (deck.type !== 'box') throw new Error('fixture deck is a box')
    const standing = {
        ...good,
        still: [
            {
                ...deck,
                dimensions: { width: 42, height: 95, depth: 4 },
                position: [0, 47.5, 5] as [number, number, number],
            },
            ...good.still.slice(1),
        ],
    }
    expect(stepMotionQualityIssues(standing)).toContain('suspect_on_edge:still.0')
    // On-edge is a repair hint only: a genuinely upright panel is never refused for it.
    expect(stepMotionHardQualityIssues(standing)).toEqual([])
})

it('keeps a seated fastener that is small but touching, and flags the same fastener once it floats away', () => {
    const good = loadScene('phase5-treadmill-s3-a2-first')
    expect(stepMotionQualityIssues(good)).toEqual([])
    const floating = structuredClone(good)
    for (const shape of floating.movers[1]!.shapes) shape.position[0] -= 200
    expect(stepMotionHardQualityIssues(floating)).toEqual(['quality_detached:movers.1'])
})
