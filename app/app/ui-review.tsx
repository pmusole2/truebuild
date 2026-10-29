import { useMemo, type ReactElement } from 'react'
import { Stack, useLocalSearchParams } from 'expo-router'
import { StatusBar } from 'expo-status-bar'
import { statusBarStyleFor, useCompactTitles } from '../src/features/capture/header-options'
import { useHomeTitle } from '../src/features/capture/library-screen'
import { useQuickProgress } from '../src/features/capture/review-screen'
import { useMoreState } from '../src/features/capture/screen-header'
import { colorsFor } from '../src/theme/tokens'
import { galleryHeaderOptions } from '../src/ui/preview/gallery-header'
import { workflowPreviewFixture } from '../src/ui/preview/workflow-fixtures'
import { ThemeProvider } from '../src/theme/theme'
import { InertTour, tourScreenFor } from '../src/ui/preview/inert-tour'
import { workflowPreviewCase, WorkflowPreview } from '../src/ui/preview/workflow-preview'

/**
 * Development-only local evidence gallery. No preview UI is mounted in a production build.
 *
 * With the debug controls visible it keeps its banner and inline headers. With `controls=hidden` (captures) it shows
 * only the product viewport under the app's real native Stack header, whose More opens the screen's own More sheet.
 */
export default function WorkflowReviewRoute(): ReactElement | null {
    const params = useLocalSearchParams<{
        fixture?: string
        scheme?: string
        controls?: string
        tour?: string
        motion?: string
        reveal?: string
    }>()
    const id = workflowPreviewCase(params.fixture)
    const scheme = params.scheme === 'dark' ? 'dark' : 'light'
    const more = useMoreState()
    // Home's scroll and collapsed bar belong to one fixture and scheme; a different one starts from the top.
    const { scrollY, collapsed, onCollapsedChange } = useHomeTitle(`${id}:${scheme}`)
    const fixture = useMemo(() => workflowPreviewFixture(id), [id])
    const progress = useQuickProgress(fixture.entry.session)
    const compactTitles = useCompactTitles()
    // Explicit inert tour fixture (?tour=on): native visual evidence of each tip, never a real action or storage.
    const tour = params.tour === 'on'
    const motionOn = params.motion === 'on' || tour
    const reveal =
        params.reveal === 'pass' || params.reveal === 'refuse' || params.reveal === 'cannot-verify'
            ? params.reveal
            : undefined
    if (!__DEV__) {
        return null
    }
    const native = params.controls === 'hidden'
    return (
        <ThemeProvider scheme={scheme}>
            <InertTour key={`${id}:${scheme}`} enabled={tour} screen={tourScreenFor(id)} scene={id}>
                {(registry) => (
                    <>
                        <StatusBar style={statusBarStyleFor(colorsFor(scheme), fixture.state.route === 'camera')} />
                        <Stack.Screen
                            options={
                                native
                                    ? galleryHeaderOptions({
                                          id,
                                          state: fixture.state,
                                          entry: fixture.entry,
                                          colors: colorsFor(scheme),
                                          more,
                                          scrollY,
                                          collapsed,
                                          progressLabel: progress.label,
                                          compactTitles,
                                          coachRegistry: registry,
                                          coach: tour ? (tourScreenFor(id) ?? undefined) : undefined,
                                      })
                                    : { title: 'Synthetic workflow review', headerShown: false }
                            }
                        />
                        <WorkflowPreview
                            key={`${id}:${scheme}`}
                            initialCase={id}
                            initialScheme={scheme}
                            showControls={!native}
                            tour={tour}
                            externalTour
                            reduceMotion={motionOn ? null : true}
                            reveal={reveal}
                            native={native ? { more, scrollY, onCollapsedChange, progress } : undefined}
                        />
                    </>
                )}
            </InertTour>
        </ThemeProvider>
    )
}
