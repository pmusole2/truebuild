import type { ComponentProps, ReactElement } from 'react'
import { Platform } from 'react-native'
import type { Stack } from 'expo-router'
import type { SharedValue } from 'react-native-reanimated'
import type { Colors } from '../../theme/tokens'
import { useLargeText } from '../../ui/large-text'
import type { LibraryEntry } from './library'
import { PinnedTitle } from './library-screen'
import { HeaderButtons, type MoreControl } from './screen-header'

// Native header options only: titles, colours and the one trailing control. No controller, router or gate logic lives
// here, so the production routes and the development gallery build their headers from one definition.

// Production headers are the platform's own title string. A custom two-line Text would be drawn, uncapped, inside the
// fixed-height native bar and clip at the largest system text size; the platform title scales and truncates natively.
// The title is also the human name the back control announces, in place of the raw route path.
export const ADD_TITLE = 'Add manual'
export const READING_TITLE = 'Reading'
export const DONE_TITLE = 'Done'

/**
 * Android's native title bar truncates at the largest system text size, and its Stack takes only a plain string. So
 * there the titles lead with what matters and stay short ("1 of 3", "Add"); the full "Question 1 of 3" stays in the
 * screen's own progress bar and question. Nothing is capped and no custom header is drawn. iOS and normal sizes keep
 * the full titles, which fit.
 */
export function useCompactTitles(): boolean {
    const large = useLargeText()
    return Platform.OS === 'android' && large
}

export function addTitle(compact = false): string {
    return compact ? 'Add' : ADD_TITLE
}

/** "Question 2 of 5" while a question is on screen ("2 of 5" when compact), else "Quick check". */
export function checkTitle(progressLabel: string | undefined, compact = false): string {
    if (progressLabel === undefined) {
        return 'Quick check'
    }
    return compact ? progressLabel.replace(/^Question /u, '') : progressLabel
}

/** "Step 2 of 8": where the person is, which is what the header answers. */
export function guideTitle(entry: LibraryEntry | undefined): string {
    return entry === undefined ? 'Guide' : `Step ${entry.stepIndex + 1} of ${entry.session.reviewedSteps.length}`
}

export type HeaderStyle = {
    headerStyle: { backgroundColor: string }
    headerTintColor: string
    headerShadowVisible: false
    contentStyle: { backgroundColor: string }
}

/** The native header coloured from a palette, so light and dark both read as one surface with the canvas. */
export function headerStyleFor(colors: Colors): HeaderStyle {
    return {
        headerStyle: { backgroundColor: colors.canvas },
        headerTintColor: colors.accentInk,
        headerShadowVisible: false,
        contentStyle: { backgroundColor: colors.canvas },
    }
}

export type ScreenOptions = Exclude<
    NonNullable<ComponentProps<typeof Stack.Screen>['options']>,
    (...args: never[]) => unknown
>

/**
 * Home's native header: the platform's large title on iOS, collapsing with the list; Android and web pin the same title
 * with Reanimated. One definition serves the production route and the development gallery, so they cannot drift.
 */
export function homeHeaderOptions(args: {
    readonly colors: Colors
    readonly scrollY: SharedValue<number>
    readonly more: MoreControl | null
}): ScreenOptions {
    const native = Platform.OS === 'ios'
    return {
        title: 'TrueBuild',
        headerLargeTitleEnabled: native,
        headerLargeTitleShadowVisible: false,
        headerLargeStyle: { backgroundColor: args.colors.canvas },
        headerTitle: native ? undefined : (): ReactElement => <PinnedTitle scrollY={args.scrollY} title="TrueBuild" />,
        headerRight: args.more === null ? undefined : (): ReactElement => <HeaderButtons more={args.more!} />,
    }
}
