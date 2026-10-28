import type { ReactElement } from 'react'
import type { SharedValue } from 'react-native-reanimated'
import type { WorkflowState } from '../../features/capture/controller'
import type { LibraryEntry } from '../../features/capture/library'
import {
    ADD_TITLE,
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
    // "Question 2 of 5", from the same count the Quick check route keeps.
    readonly progressLabel: string | undefined
}): ScreenOptions {
    const { id, state, entry, colors, more, scrollY, progressLabel } = args
    const style = { ...headerStyleFor(colors), headerBackButtonDisplayMode: 'minimal' as const }
    const trailing = (): ReactElement => <HeaderButtons more={more} />
    // The camera and the unavailable screen own their whole viewport in production, with no Stack header.
    if (state.route === 'camera' || id === 'home-unavailable') {
        return { ...style, headerShown: false }
    }
    if (id === 'settings') {
        return { ...style, title: 'Settings' }
    }
    if (state.route === 'library') {
        return { ...style, ...homeHeaderOptions({ colors, scrollY, more }) }
    }
    if (id === 'done-finished') {
        return { ...style, title: DONE_TITLE, headerBackVisible: false, headerRight: trailing }
    }
    if (state.route === 'pages') {
        return state.pending !== null && state.pending.startsWith('Reading')
            ? { ...style, title: READING_TITLE }
            : { ...style, title: ADD_TITLE, headerRight: trailing }
    }
    if (state.route === 'overview') {
        return { ...style, title: checkTitle(progressLabel), headerRight: trailing }
    }
    return { ...style, title: guideTitle(entry), headerRight: trailing }
}
