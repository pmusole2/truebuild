import { describe, expect, it } from '@jest/globals'
import { render, screen, fireEvent } from '@testing-library/react-native'
import type { ReactElement } from 'react'
import { Platform } from 'react-native'
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
    it('resets Camera and Home overrides when switching back to Guide on the same native route', () => {
        const merged = {
            ...optionsFor('home-empty').options,
            ...optionsFor('camera-denied').options,
            ...optionsFor('guide-pass').options,
        }
        expect(merged.headerShown).toBe(true)
        expect(merged.headerLargeTitleEnabled).toBe(false)
        expect(merged.headerBackVisible).toBe(true)
    })
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

    it('shortens the Android largest-text titles to the count and the verb, and keeps the full ones everywhere else', () => {
        const { state, entry } = workflowPreviewFixture('review-unresolved')
        const more = { open: false, mode: 'details' as const, show: jest.fn(), hide: jest.fn() }
        const args = { id: 'review-unresolved' as const, state, entry, colors: lightColors, more, scrollY }
        const full = galleryHeaderOptions({ ...args, progressLabel: 'Question 1 of 2' })
        const compact = galleryHeaderOptions({ ...args, progressLabel: 'Question 1 of 2', compactTitles: true })
        expect([full.title, compact.title]).toEqual(['Question 1 of 2', '1 of 2'])
        const add = workflowPreviewFixture('pages-empty')
        const addArgs = { ...args, id: 'pages-empty' as const, state: add.state, entry: add.entry }
        expect(galleryHeaderOptions({ ...addArgs, progressLabel: undefined, compactTitles: true }).title).toBe('Add')
        // No progress to lead with: the title stays the plain words.
        const none = galleryHeaderOptions({ ...args, progressLabel: undefined, compactTitles: true })
        expect(none.title).toBe('Quick check')
    })

    it('colours the native platform title on iOS Home only once the list heading has scrolled away', () => {
        const { state, entry } = workflowPreviewFixture('home-populated')
        const more = { open: false, mode: 'details' as const, show: jest.fn(), hide: jest.fn() }
        const args = {
            id: 'home-populated' as const,
            state,
            entry,
            colors: lightColors,
            more,
            scrollY,
            progressLabel: undefined,
        }
        const open = galleryHeaderOptions(args)
        const shut = galleryHeaderOptions({ ...args, collapsed: true })
        expect([open.title, shut.title]).toEqual(['TrueBuild', 'TrueBuild'])
        expect(open.headerTitleStyle).toEqual({ color: 'transparent' })
        expect(shut.headerTitleStyle).toEqual({ color: lightColors.ink })
        // The platform large title stays off (it painted nothing on device) and Back stays hidden.
        expect([open.headerLargeTitleEnabled, shut.headerLargeTitleEnabled]).toEqual([false, false])
        // A different fixture drops the Home bar title, so a collapsed Home cannot leak into it.
        const merged = { ...shut, ...optionsFor('guide-pass').options }
        expect(merged.title).toBe('Step 1 of 2')
        expect(merged.headerTitle).toBeUndefined()
        expect(merged.headerTitleStyle).toBeUndefined()
    })

    it('keeps the pinned Reanimated title on Android Home, whatever the collapsed state', () => {
        const platform = jest.replaceProperty(Platform, 'OS', 'android')
        try {
            const { state, entry } = workflowPreviewFixture('home-populated')
            const more = { open: false, mode: 'details' as const, show: jest.fn(), hide: jest.fn() }
            const options = galleryHeaderOptions({
                id: 'home-populated',
                state,
                entry,
                colors: lightColors,
                more,
                scrollY,
                progressLabel: undefined,
                collapsed: true,
            })
            expect(typeof options.headerTitle).toBe('function')
            expect(options.headerTitleStyle).toBeUndefined()
        } finally {
            platform.restore()
        }
    })

    it('has no Back on the Home fixtures, which are production root screens, and keeps it elsewhere', () => {
        expect(optionsFor('home-empty').options.headerBackVisible).toBe(false)
        expect(optionsFor('home-populated').options.headerBackVisible).toBe(false)
        expect(optionsFor('guide-pass').options.headerBackVisible).toBe(true)
        expect(optionsFor('settings').options.headerBackVisible).toBe(true)
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
