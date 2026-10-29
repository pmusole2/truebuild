import { describe, expect, it } from 'vitest'
import { orderStages, type StageId } from './stage-order'

const at = (id: StageId, ms: number | null): { id: StageId; at: number | null } => ({ id, at: ms })
const ids = (stages: readonly { id: StageId }[]): StageId[] => stages.map((stage) => stage.id)

describe('stages in the order they arrived', () => {
    it('puts the verdict first and the rest by when they landed after it', () => {
        expect(ids(orderStages([at('mask', 900), at('verdict', 0), at('regions', 1500), at('result', 400)]))).toEqual([
            'verdict',
            'result',
            'mask',
            'regions',
        ])
        expect(ids(orderStages([at('result', 2400), at('mask', 700), at('verdict', 0), at('regions', 1200)]))).toEqual([
            'verdict',
            'mask',
            'regions',
            'result',
        ])
    })

    it('keeps the canonical order for equal times, and lists stages that never arrived after those that did', () => {
        expect(ids(orderStages([at('mask', 10), at('result', 10), at('verdict', 0), at('regions', 10)]))).toEqual([
            'verdict',
            'result',
            'mask',
            'regions',
        ])
        expect(ids(orderStages([at('regions', null), at('mask', 800), at('result', null), at('verdict', 0)]))).toEqual([
            'verdict',
            'mask',
            'result',
            'regions',
        ])
    })

    it('keeps a result that was ready before the verdict after the verdict, and never reorders the input', () => {
        const input = [at('result', -50), at('verdict', 0)]
        expect(ids(orderStages(input))).toEqual(['verdict', 'result'])
        expect(ids(input)).toEqual(['result', 'verdict'])
    })
})
