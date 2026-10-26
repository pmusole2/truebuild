import { describe, expect, it } from '@jest/globals'
import { extractTapCoordinates } from './frozen-photo'

// A raw DOM-shaped press as react-native-web delivers it: no locationX/Y, viewport clientX/Y, element bounds on currentTarget.
function domEvent(clientX: unknown, clientY: unknown, left: unknown = 10, top: unknown = 20): unknown {
    return {
        nativeEvent: { clientX, clientY },
        currentTarget: { getBoundingClientRect: (): unknown => ({ left, top }) },
    }
}

describe('extractTapCoordinates', () => {
    it('converts a raw DOM press with no locationX/Y into element-relative pixels (non-central, offset element)', () => {
        expect(extractTapCoordinates(domEvent(150, 60))).toEqual({ x: 140, y: 40 })
    })

    it('uses the native locationX/Y pair as-is and ignores the DOM values when both are present', () => {
        const event = {
            nativeEvent: { locationX: 33, locationY: 44, clientX: 500, clientY: 500 },
            currentTarget: { getBoundingClientRect: (): unknown => ({ left: 10, top: 20 }) },
        }

        expect(extractTapCoordinates(event)).toEqual({ x: 33, y: 44 })
    })

    it('never mixes a native axis with a DOM axis: a lone locationX falls back to the complete DOM pair', () => {
        const event = {
            nativeEvent: { locationX: 33, clientX: 150, clientY: 60 },
            currentTarget: { getBoundingClientRect: (): unknown => ({ left: 10, top: 20 }) },
        }

        expect(extractTapCoordinates(event)).toEqual({ x: 140, y: 40 })
    })

    it.each<[string, unknown]>([
        ['a non-object event', 'tap'],
        ['a missing nativeEvent', { currentTarget: null }],
        ['no coordinates at all', { nativeEvent: {}, currentTarget: null }],
        ['NaN client coordinate', domEvent(Number.NaN, 60)],
        ['Infinity client coordinate', domEvent(150, Number.POSITIVE_INFINITY)],
        ['string client coordinate', domEvent('150', 60)],
        ['bounds with a null left edge', domEvent(150, 60, null)],
        ['bounds with a non-finite top edge', domEvent(150, 60, 10, Number.NaN)],
        ['a target without getBoundingClientRect', { nativeEvent: { clientX: 150, clientY: 60 }, currentTarget: {} }],
    ])('returns null for %s instead of inventing a position', (_label: string, event: unknown): void => {
        expect(extractTapCoordinates(event)).toBeNull()
    })
})
