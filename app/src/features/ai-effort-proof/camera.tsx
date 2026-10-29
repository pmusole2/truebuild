import type { ReactElement } from 'react'
import { Image, StyleSheet } from 'react-native'
import { API_BASE_URL } from '../../config'
import { ShutterButton } from '../../ui/camera-chrome'
import { CoachTarget } from '../onboarding/coach-provider'
import { CameraStage } from '../capture/camera-stage'
import type { CameraScreenProps } from '../capture/camera-screen'
import { useOptionalWorkflow } from '../capture/workflow-context'
import { nativeProofConfig } from './config'
import { proofCaptureAsset, proofManualIndex } from './runtime'

/** Synthetic camera IO on the ordinary CameraStage; the real controller still owns shutter, capture and navigation. */
export function ProofCamera({ busy, intent, guide, wording, onCancel, onCapture }: CameraScreenProps): ReactElement {
    const workflow = useOptionalWorkflow()
    if (nativeProofConfig(API_BASE_URL) === null) throw new Error('Native proof camera is disabled')
    const entry = workflow?.entry
    const steps = entry?.session.rawExtraction?.steps ?? entry?.session.reviewedSteps ?? []
    const others =
        workflow?.state.entries.filter(
            (candidate) =>
                candidate.session.manualId !== entry?.session.manualId && candidate.session.rawExtraction !== null,
        ).length ?? 0
    const manualIndex = proofManualIndex(
        steps.map((step) => step.stepId),
        others,
        entry?.session.pages.flatMap((page) => {
            const uri = workflow?.state.pageUris[page.pageId]
            return uri === undefined ? [] : [uri]
        }),
    )
    const pageIndex = intent?.kind === 'page' ? (intent.replaceIndex ?? entry?.session.pages.length ?? 0) : 0
    const asset = proofCaptureAsset(intent, { manualIndex, pageIndex })
    const capture = (): void => {
        if (!busy) onCapture(async () => ({ ...asset }))
    }
    const shutter = (
        <CoachTarget id="camera-shutter" screen="camera" label="Capture photo" onPress={busy ? undefined : capture}>
            <ShutterButton
                label={busy ? 'Preparing photo…' : 'Capture photo'}
                onPress={capture}
                disabled={busy}
                busy={busy}
            />
        </CoachTarget>
    )
    return (
        <CameraStage
            busy={busy}
            intent={intent}
            guide={guide}
            wording={wording}
            presentation={{
                status: 'preview',
                media: (
                    <Image
                        source={{ uri: asset.uri }}
                        accessibilityLabel="Synthetic fixture camera image"
                        resizeMode="contain"
                        style={StyleSheet.absoluteFill}
                    />
                ),
                shutter,
            }}
            onCancel={onCancel}
            shutterReady={!busy}
            onRequestPermission={(): void => undefined}
            onOpenSettings={(): void => undefined}
            onRetry={(): void => undefined}
        />
    )
}
