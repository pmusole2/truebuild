import type { ReactElement } from 'react'
import { Button, Text } from 'react-native'
import type { CaptureController, WorkflowState } from './controller'
import type { LibraryEntry } from './library'
import { CameraScreen, type AssemblyGuide } from './camera-screen'
import { DoneScreen } from './done-screen'
import { ReadingScreen } from './reading-screen'
import { GuideScreen, LibraryScreen, OverviewScreen, PagesScreen, stepAssemblyGuide } from './screens'
import { WorkflowProvider, useWorkflow } from './workflow-provider'

export { imageDigest } from './controller-factory'

/** The step guide shown over the assembly camera. Manual scanning has no step guide. */
function assemblyGuide(entry: LibraryEntry | undefined, state: WorkflowState): AssemblyGuide | undefined {
    if (entry === undefined || state.cameraIntent === null || state.cameraIntent.kind === 'page') {
        return undefined
    }
    return stepAssemblyGuide(entry.session, entry.stepIndex, state.pageUris)
}

/**
 * Explicit UI-test/preview entry: callers supply a real controller with provider-boundary transport fixtures.
 * It draws the controller's current position on one surface with inline headers. The production app does not use it:
 * production screens are native Stack routes under app/app (see native-routes.tsx).
 */
export function CapturePreview({
    controller,
    choosePages = (): void => undefined,
}: {
    controller: CaptureController
    choosePages?: (replaceIndex?: number) => void
}): ReactElement {
    return (
        <WorkflowProvider controller={controller}>
            <Text>Automated preview · synthetic inputs</Text>
            <PreviewSurface choosePages={choosePages} />
            <Button title="Reset preview navigation" onPress={controller.home} />
        </WorkflowProvider>
    )
}

function PreviewSurface({ choosePages }: { choosePages: (replaceIndex?: number) => void }): ReactElement {
    const { controller, state, entry } = useWorkflow()
    if (state.route === 'camera') {
        return (
            <CameraScreen
                busy={state.pending !== null}
                intent={state.cameraIntent}
                guide={assemblyGuide(entry, state)}
                onCancel={controller.cancel}
                onCapture={(take): void => {
                    void controller.shutter(take)
                }}
            />
        )
    }
    if (state.route === 'library' || entry === undefined) {
        return <LibraryScreen state={state} controller={controller} />
    }
    if (state.route === 'pages') {
        return state.pending !== null && state.pending.startsWith('Reading') ? (
            <ReadingScreen state={state} controller={controller} entry={entry} />
        ) : (
            <PagesScreen
                key={entry.session.manualId}
                state={state}
                controller={controller}
                entry={entry}
                choosePages={choosePages}
            />
        )
    }
    if (state.route === 'overview') {
        return (
            <OverviewScreen
                key={`${entry.session.manualId}-${entry.session.revision}`}
                state={state}
                controller={controller}
                entry={entry}
            />
        )
    }
    return entry.completedStepIds.length > 0 && entry.completedStepIds.length === entry.session.reviewedSteps.length ? (
        <DoneScreen state={state} controller={controller} entry={entry} />
    ) : (
        <GuideScreen state={state} controller={controller} entry={entry} />
    )
}
