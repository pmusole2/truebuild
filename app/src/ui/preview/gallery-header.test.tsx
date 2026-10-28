import { describe, expect, it } from '@jest/globals'
import { render, screen, fireEvent } from '@testing-library/react-native'
import type { ReactElement } from 'react'
import type { SharedValue } from 'react-native-reanimated'
import { darkColors, lightColors } from '../../theme/tokens'
import type { ScreenOptions } from '../../features/capture/header-options'
import { galleryHeaderOptions } from './gallery-header'
import { workflowPreviewFixture, WORKFLOW_PREVIEW_CASES, type WorkflowPreviewCase } from './workflow-fixtures'

jest.mock('react-native-reanimated', () => jest.requireActual('../test-support/reanimated-mock'))
jest.mock(
    'react-native-safe-area-context',
    () => jest.requireActual<{ default: unknown }>('react-native-safe-area-context/jest/mock').default,
)

// The header reads the shared value only inside its title worklet, which these tests do not run.
const scrollY = { value: 0 } as unknown as SharedValue<number>

type MoreStub = { open: boolean; mode: 'details'; show: jest.Mock; hide: jest.Mock }

function optionsFor(
    id: WorkflowPreviewCase,
    more: MoreStub = { open: false, mode: 'details', show: jest.fn(), hide: jest.fn() },
): { more: MoreStub; options: ScreenOptions } {
    const { state, entry } = workflowPreviewFixture(id)
    return {
        more,
        options: galleryHeaderOptions({
            id,
            state,
            entry,
            colors: lightColors,
            more,
            scrollY,
            progressLabel: 'Question 1 of 2',
        }),
    }
}

describe('gallery native header', () => {
    it.each([
        ['pages-empty', 'Add manual'],
        ['pages-reading', 'Reading'],
        ['review-unresolved', 'Question 1 of 2'],
        ['guide-pass', 'Step 1 of 2'],
        ['done-finished', 'Done'],
        ['home-populated', 'TrueBuild'],
        ['settings', 'Settings'],
    ] as const)('gives %s the production platform title %s and no custom title view', (id, title) => {
        const { options } = optionsFor(id)
        expect(options.title).toBe(title)
        if (id !== 'home-populated') {
            expect(options.headerTitle).toBeUndefined()
        }
    })

    it.each(WORKFLOW_PREVIEW_CASES.filter((preview) => preview.group === 'Camera').map((preview) => preview.id))(
        'hides the header for the full-bleed camera case %s',
        (id) => {
            expect(optionsFor(id).options.headerShown).toBe(false)
        },
    )

    it('hides it for the unavailable screen, which owns its whole viewport', () => {
        expect(optionsFor('home-unavailable').options.headerShown).toBe(false)
    })

    it('draws the header in the gallery scheme, not the system one', () => {
        const { state, entry } = workflowPreviewFixture('guide-pass')
        const more = { open: false, mode: 'details' as const, show: jest.fn(), hide: jest.fn() }
        const dark = galleryHeaderOptions({
            id: 'guide-pass',
            state,
            entry,
            colors: darkColors,
            more,
            scrollY,
            progressLabel: undefined,
        })
        expect(dark.headerStyle).toEqual({ backgroundColor: darkColors.canvas })
        expect(dark.headerTintColor).toBe(darkColors.accentInk)
    })

    it("puts More, and only More, on the trailing side, wired to the screen's own More control", async () => {
        const { options, more } = optionsFor('guide-pass')
        const trailing = options.headerRight as () => ReactElement
        await render(trailing())
        expect(screen.getAllByRole('button')).toHaveLength(1)
        await fireEvent.press(screen.getByRole('button', { name: 'More' }))
        expect(more.show).toHaveBeenCalledTimes(1)
    })

    it('has no More while reading, as in production, and no back control on Done', () => {
        expect(optionsFor('pages-reading').options.headerRight).toBeUndefined()
        expect(optionsFor('done-finished').options.headerBackVisible).toBe(false)
    })
})
