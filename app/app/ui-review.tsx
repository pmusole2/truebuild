import type { ReactElement } from 'react'
import { Stack, useLocalSearchParams } from 'expo-router'
import { workflowPreviewCase, WorkflowPreview } from '../src/ui/preview/workflow-preview'

/** Development-only local evidence gallery. No preview UI is mounted in a production build. */
export default function WorkflowReviewRoute(): ReactElement | null {
    const params = useLocalSearchParams<{ fixture?: string; scheme?: string; controls?: string }>()
    if (!__DEV__) {
        return null
    }
    return (
        <>
            <Stack.Screen options={{ title: 'Synthetic workflow review' }} />
            <WorkflowPreview
                key={`${params.fixture ?? 'home-empty'}:${params.scheme ?? 'light'}`}
                initialCase={workflowPreviewCase(params.fixture)}
                initialScheme={params.scheme === 'dark' ? 'dark' : 'light'}
                showControls={params.controls !== 'hidden'}
            />
        </>
    )
}
