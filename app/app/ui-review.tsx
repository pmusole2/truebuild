import { useMemo, type ReactElement } from 'react'
import { Stack, useLocalSearchParams } from 'expo-router'
import { useSharedValue } from 'react-native-reanimated'
import { useCompactTitles } from '../src/features/capture/header-options'
import { useQuickProgress } from '../src/features/capture/review-screen'
import { useMoreState } from '../src/features/capture/screen-header'
import { colorsFor } from '../src/theme/tokens'
import { galleryHeaderOptions } from '../src/ui/preview/gallery-header'
import { workflowPreviewFixture } from '../src/ui/preview/workflow-fixtures'
import { workflowPreviewCase, WorkflowPreview } from '../src/ui/preview/workflow-preview'

/**
 * Development-only local evidence gallery. No preview UI is mounted in a production build.
 *
 * With the debug controls visible it keeps its banner and inline headers. With `controls=hidden` (captures) it shows
 * only the product viewport under the app's real native Stack header, whose More opens the screen's own More sheet.
 */
export default function WorkflowReviewRoute(): ReactElement | null {
    const params = useLocalSearchParams<{ fixture?: string; scheme?: string; controls?: string }>()
    const id = workflowPreviewCase(params.fixture)
    const scheme = params.scheme === 'dark' ? 'dark' : 'light'
    const more = useMoreState()
    const scrollY = useSharedValue(0)
    const fixture = useMemo(() => workflowPreviewFixture(id), [id])
    const progress = useQuickProgress(fixture.entry.session)
    const compactTitles = useCompactTitles()
    if (!__DEV__) {
        return null
    }
    const native = params.controls === 'hidden'
    return (
        <>
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
                              progressLabel: progress.label,
                              compactTitles,
                          })
                        : { title: 'Synthetic workflow review', headerShown: false }
                }
            />
            <WorkflowPreview
                key={`${id}:${scheme}`}
                initialCase={id}
                initialScheme={scheme}
                showControls={!native}
                native={native ? { more, scrollY, progress } : undefined}
            />
        </>
    )
}
