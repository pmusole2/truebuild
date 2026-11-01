import { useRef, useState, type ReactElement } from 'react'
import { Image, Linking, StyleSheet, View } from 'react-native'
import { CameraView, useCameraPermissions } from 'expo-camera'
import { ownTemporaryImage } from '../../media/owned-temporary-images'
import { DocumentSurface } from '../capture/document-surface'
import { useWorkflow } from '../capture/workflow-context'
import { cameraPreparationState, fixtureCameraEnabled, observedCameraAccess } from '../capture/native-routes'
import type * as ProofRuntime from '../ai-effort-proof/runtime'
import { originId, useRenderOrigin } from '../screens/render-origin'
import type { ReactNode } from 'react'

/**
 * Preview container for the CameraView document node. The element is constructed here (outside the
 * renderer's provider) but rendered as the node's child, so the origin is read from context at render
 * time: the wrapper inherits the node's actual origin; only the CameraView/Image internals are capability.
 * With no provider above it, the honest shell origin remains.
 */
function CameraPreviewShell({ children }: { children: ReactNode }): ReactElement {
    const origin = useRenderOrigin()
    return (
        <View nativeID={originId(origin ?? 'shell')} style={StyleSheet.absoluteFill}>
            {children}
        </View>
    )
}

/** Native camera IO only. The CameraView document places its preview; its bar is the one shutter. */
export function DocumentCamera({ choosePages }: { readonly choosePages?: () => void }): ReactElement {
    if (fixtureCameraEnabled()) return <FixtureCamera choosePages={choosePages} />
    return <HardwareCamera choosePages={choosePages} />
}

function FixtureCamera({ choosePages }: { readonly choosePages?: () => void }): ReactElement {
    const workflow = useWorkflow()
    if (!fixtureCameraEnabled()) throw new Error('Fixture camera disabled')
    // Loaded only inside the explicit DEV/isolated-loopback fixture boundary.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const runtime = require('../ai-effort-proof/runtime') as typeof ProofRuntime
    const { entry, state, controller } = workflow
    const steps = entry?.session.rawExtraction?.steps ?? entry?.session.reviewedSteps ?? []
    const otherParsed = state.entries.filter(
        (item) => item.session.manualId !== entry?.session.manualId && item.session.rawExtraction !== null,
    ).length
    const manualIndex = runtime.proofManualIndex(
        steps.map((step) => step.stepId),
        otherParsed,
        entry?.session.pages.flatMap((page) =>
            state.pageUris[page.pageId] === undefined ? [] : [state.pageUris[page.pageId]!],
        ),
    )
    const asset = runtime.proofCaptureAsset(state.cameraIntent, {
        manualIndex,
        pageIndex:
            state.cameraIntent?.kind === 'page'
                ? (state.cameraIntent.replaceIndex ?? entry?.session.pages.length ?? 0)
                : 0,
    })
    const ready = state.pending === null
    return (
        <DocumentSurface
            kind="camera"
            choosePages={choosePages}
            camera={{
                ...cameraPreparationState(controller)!,
                ready,
                preview: (
                    <CameraPreviewShell>
                        <Image
                            nativeID="truebuild-capability-internals:CameraView"
                            accessibilityLabel="Synthetic fixture camera image"
                            source={{ uri: asset.uri }}
                            resizeMode="contain"
                            style={StyleSheet.absoluteFill}
                        />
                    </CameraPreviewShell>
                ),
                capture: (): void => {
                    if (ready) void controller.shutter(async () => ({ ...asset }))
                },
            }}
        />
    )
}

function HardwareCamera({ choosePages }: { readonly choosePages?: () => void }): ReactElement {
    const { controller, state } = useWorkflow()
    const camera = useRef<CameraView>(null)
    const prepared = cameraPreparationState(controller)
    // The explicit intent already queried this permission; do not race another initial SDK query against its binding.
    const [permission, requestPermission] = useCameraPermissions({ get: prepared === null })
    const [ready, setReady] = useState(false)
    const [error, setError] = useState(false)
    const [attempt, setAttempt] = useState(0)
    const access = permission === null ? (prepared ?? observedCameraAccess(null)) : observedCameraAccess(permission)
    const allowed = access.permission === 'granted'
    const capture = (): void => {
        if (!allowed || !ready || error || state.pending !== null || camera.current === null) return
        void controller.shutter(async () => {
            const picture = await camera.current!.takePictureAsync({ quality: 1, skipProcessing: false, exif: false })
            ownTemporaryImage(picture.uri)
            return { uri: picture.uri, width: picture.width, height: picture.height }
        })
    }
    const preview =
        allowed && !error ? (
            <CameraPreviewShell>
                <CameraView
                    nativeID="truebuild-capability-internals:CameraView"
                    key={attempt}
                    ref={camera}
                    facing="back"
                    mode="picture"
                    style={StyleSheet.absoluteFill}
                    onCameraReady={(): void => setReady(true)}
                    onMountError={(): void => {
                        setError(true)
                        setReady(false)
                    }}
                />
            </CameraPreviewShell>
        ) : null
    return (
        <DocumentSurface
            kind="camera"
            choosePages={choosePages}
            camera={{
                ready: allowed && ready && !error && state.pending === null,
                preview,
                capture,
                permission: access.permission,
                failed: error,
                canAskAgain: access.canAskAgain,
                requestPermission: (): void => {
                    // An OS permission request rejecting does not establish that CameraView failed to mount.
                    if (access.canAskAgain !== false) void requestPermission().catch((): void => undefined)
                },
                openSettings: (): void => {
                    void Linking.openSettings().catch((): void => undefined)
                },
                retry: (): void => {
                    setError(false)
                    setReady(false)
                    setAttempt(attempt + 1)
                },
            }}
        />
    )
}
