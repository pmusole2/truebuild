import type { NormalizedBox } from '@truebuild/contracts'
import { describe, expect, it } from 'vitest'
import { boxOnDisplay, containRect, type Rect, type Size } from './frame-geometry'
import { heroImageRect } from './hero-geometry'

function expectRect(actual: Rect, expected: Rect): void {
    for (const field of ['x', 'y', 'width', 'height'] as const) {
        expect(actual[field], field).toBeCloseTo(expected[field], 10)
    }
}

describe('hero picture crop', () => {
    it.each([
        { image: { width: 600, height: 300 }, expected: { x: -150, y: 0, width: 600, height: 300 } },
        { image: { width: 300, height: 600 }, expected: { x: 0, y: -150, width: 300, height: 600 } },
    ])(
        'fills a square hero with a centered $image.width × $image.height picture when no region is required',
        ({ image, expected }) => {
            const frame = { width: 300, height: 300 }

            expectRect(heroImageRect(frame, image), expected)
            expectRect(heroImageRect(frame, image, []), expected)
            expect(heroImageRect(frame, image)).not.toEqual(containRect(frame, image))
        },
    )

    it('moves the crop toward an off-center required region instead of cutting it with a centered crop', () => {
        const frame = { width: 300, height: 300 }
        const required = { x: 0.7, y: 0.2, width: 0.2, height: 0.4 }
        const rect = heroImageRect(frame, { width: 1000, height: 500 }, [required])

        // Cover is 600 × 300. Centering this region would expose the right image edge, so clamp there.
        expectRect(rect, { x: -300, y: 0, width: 600, height: 300 })
        expectRect(boxOnDisplay(required, rect), { x: 120, y: 60, width: 120, height: 120 })
    })

    it.each([
        { box: { x: 0, y: 0.4, width: 0.1, height: 0.2 }, expectedX: 0 },
        { box: { x: 0.9, y: 0.4, width: 0.1, height: 0.2 }, expectedX: -300 },
    ])('never exposes blank pixels when a required region reaches a source edge at x=$box.x', ({ box, expectedX }) => {
        const rect = heroImageRect({ width: 300, height: 300 }, { width: 600, height: 300 }, [box])

        expectRect(rect, { x: expectedX, y: 0, width: 600, height: 300 })
    })

    it('centers on the union of cited, observed, next and target regions and registers all four with the picture', () => {
        const cited = { x: 0.5, y: 0.1, width: 0.1, height: 0.2 }
        const observed = { x: 0.6, y: 0.4, width: 0.1, height: 0.1 }
        const next = { x: 0.7, y: 0.6, width: 0.2, height: 0.2 }
        const target = { x: 0.8, y: 0.3, width: 0.1, height: 0.1 }
        const required = [cited, observed, next, target]
        const frame = { width: 400, height: 400 }
        const image = { width: 1000, height: 500 }
        const rect = heroImageRect(frame, image, required)

        // Source union spans x=.5 through .9. Its center .7 lands at frame x=200 on the 800px-wide image.
        expectRect(rect, { x: -360, y: 0, width: 800, height: 400 })
        expectRect(heroImageRect(frame, image, [...required].reverse()), rect)
        expectRect(boxOnDisplay(cited, rect), { x: 40, y: 40, width: 80, height: 80 })
        expectRect(boxOnDisplay(observed, rect), { x: 120, y: 160, width: 80, height: 40 })
        expectRect(boxOnDisplay(next, rect), { x: 200, y: 240, width: 160, height: 80 })
        expectRect(boxOnDisplay(target, rect), { x: 280, y: 120, width: 80, height: 40 })
    })

    it('contains the whole image when individually small required regions cannot all survive one cover crop', () => {
        const frame = { width: 300, height: 300 }
        const image = { width: 600, height: 300 }
        const cited = { x: 0.05, y: 0.2, width: 0.1, height: 0.2 }
        const target = { x: 0.85, y: 0.6, width: 0.1, height: 0.2 }

        expectRect(heroImageRect(frame, image, [cited, target]), { x: 0, y: 75, width: 300, height: 150 })
        expect(heroImageRect(frame, image, [cited, target])).toEqual(containRect(frame, image))
        expect(heroImageRect(frame, image, [cited])).not.toEqual(containRect(frame, image))
        expect(heroImageRect(frame, image, [target])).not.toEqual(containRect(frame, image))
    })

    it('contains a portrait image when a required region is taller than the visible cover window', () => {
        const frame = { width: 300, height: 300 }
        const image = { width: 300, height: 900 }
        const required = { x: 0.2, y: 0.1, width: 0.2, height: 0.6 }

        expectRect(heroImageRect(frame, image, [required]), { x: 100, y: 0, width: 100, height: 300 })
    })

    it.each<NormalizedBox>([
        { x: -0.1, y: 0.2, width: 0.2, height: 0.2 },
        { x: 0.9, y: 0.2, width: 0.2, height: 0.2 },
        { x: 0.2, y: 0.9, width: 0.2, height: 0.2 },
        { x: 0.2, y: 0.2, width: 0, height: 0.2 },
        { x: 0.2, y: 0.2, width: 0.2, height: -0.1 },
        { x: Number.NaN, y: 0.2, width: 0.2, height: 0.2 },
        { x: 0.2, y: 0.2, width: 0.2, height: Number.POSITIVE_INFINITY },
    ])('fails closed to contain for an invalid protected box %j, even alongside a valid box', (invalid) => {
        const frame = { width: 300, height: 300 }
        const image = { width: 600, height: 300 }
        const valid = { x: 0.4, y: 0.4, width: 0.1, height: 0.1 }

        expect(heroImageRect(frame, image, [invalid])).toEqual(containRect(frame, image))
        expect(heroImageRect(frame, image, [valid, invalid])).toEqual(containRect(frame, image))
    })

    it.each<{ container: Size; image: Size }>([
        { container: { width: 0, height: 300 }, image: { width: 600, height: 300 } },
        { container: { width: 300, height: -1 }, image: { width: 600, height: 300 } },
        { container: { width: 300, height: 300 }, image: { width: -1, height: 300 } },
        { container: { width: 300, height: 300 }, image: { width: 600, height: 0 } },
        { container: { width: Number.NaN, height: 300 }, image: { width: 600, height: 300 } },
        { container: { width: 300, height: Number.POSITIVE_INFINITY }, image: { width: 600, height: 300 } },
        { container: { width: 300, height: 300 }, image: { width: Number.POSITIVE_INFINITY, height: 300 } },
        { container: { width: 300, height: 300 }, image: { width: 600, height: Number.NaN } },
    ])('returns an empty finite rectangle for invalid dimensions %j', ({ container, image }) => {
        expect(heroImageRect(container, image)).toEqual({ x: 0, y: 0, width: 0, height: 0 })
    })
})
