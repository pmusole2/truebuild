import type { ReactElement } from 'react'
import type { SharedValue } from 'react-native-reanimated'
import type { WorkflowState } from '../../features/capture/controller'
import type { LibraryEntry } from '../../features/capture/library'
import {
    addTitle,
    checkTitle,
    DONE_TITLE,
    guideTitle,
    headerStyleFor,
    homeHeaderOptions,
    READING_TITLE,
    type ScreenOptions,
} from '../../features/capture/header-options'
import { HeaderButtons, type MoreControl } from '../../features/capture/screen-header'
import type { Colors } from '../../theme/tokens'
import type { WorkflowPreviewCase } from './workflow-fixtures'

/**
 * The real native Stack header for one gallery fixture, built from the same titles and options as the production
 * routes. The gallery host puts these on its own Stack screen and wires More to the screen's inert More control, so a
 * hidden-controls capture shows the product viewport and not a banner or an emulated header.
 */
export function galleryHeaderOptions(args: {
    readonly id: WorkflowPreviewCase
    readonly state: Pick<WorkflowState, 'route' | 'pending'>
    readonly entry: LibraryEntry
    readonly colors: Colors
    readonly more: MoreControl
    readonly scrollY: SharedValue<number>
    // Home on iOS: its list heading has scrolled away, so the native bar shows its small title.
    readonly collapsed?: boolean
    // "Question 2 of 5", from the same count the Quick check route keeps.
    readonly progressLabel: string | undefined
    // Android at the largest text size: the same short count-first titles as production.
    readonly compactTitles?: boolean
}): ScreenOptions {
    const { id, state, entry, colors, more, scrollY, progressLabel, compactTitles = false, collapsed = false } = args
    // Expo merges options on this one gallery route. Reset Camera/Home overrides when the selected fixture changes.
    const style = {
        ...headerStyleFor(colors),
        headerShown: true,
        headerLargeTitleEnabled: false,
        headerBackVisible: true,
        headerTitle: undefined,
        headerTitleStyle: undefined,
        headerRight: undefined,
        headerBackButtonDisplayMode: 'minimal' as const,
    }
    const trailing = (): ReactElement => <HeaderButtons more={more} />
    // The camera and the unavailable screen own their whole viewport in production, with no Stack header.
    if (state.route === 'camera' || id === 'home-unavailable') {
        return {
            ...style,
            headerShown: false,
        }
    }
    if (id === 'settings') {
        return { ...style, title: 'Settings' }
    }
    if (state.route === 'library') {
        // Production root Home has no Back; the gallery host's own Back would suggest it does. Hide it for Home only.
        return { ...style, ...homeHeaderOptions({ colors, scrollY, more, collapsed }), headerBackVisible: false }
    }
    if (id === 'done-finished') {
        return { ...style, title: DONE_TITLE, headerBackVisible: false, headerRight: trailing }
    }
    if (state.route === 'pages') {
        return state.pending !== null && state.pending.startsWith('Reading')
            ? { ...style, title: READING_TITLE }
            : { ...style, title: addTitle(compactTitles), headerRight: trailing }
    }
    if (state.route === 'overview') {
        return { ...style, title: checkTitle(progressLabel, compactTitles), headerRight: trailing }
    }
    return { ...style, title: guideTitle(entry), headerRight: trailing }
}
