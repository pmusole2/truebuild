import type { ReactElement } from 'react'
import { Stack, useLocalSearchParams } from 'expo-router'
import { workflowPreviewCase, WorkflowPreview } from '../src/ui/preview/workflow-preview'

/** Development-only v2 document gallery. Every product viewport owns its document header, content and bar. */
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
    const tour = params.tour === 'on'
    const motionOn = params.motion === 'on' || tour
    const reveal =
        params.reveal === 'pass' || params.reveal === 'refuse' || params.reveal === 'cannot-verify'
            ? params.reveal
            : undefined
    if (!__DEV__) return null
    return (
        <>
            <Stack.Screen options={{ headerShown: false }} />
            <WorkflowPreview
                key={`${id}:${scheme}`}
                initialCase={id}
                initialScheme={scheme}
                showControls={params.controls !== 'hidden'}
                tour={tour}
                reduceMotion={motionOn ? null : true}
                reveal={reveal}
            />
        </>
    )
}
