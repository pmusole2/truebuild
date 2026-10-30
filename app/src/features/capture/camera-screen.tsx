import { useRef, useState, type ReactElement } from 'react'
import { Linking, StyleSheet } from 'react-native'
import { CameraView, useCameraPermissions } from 'expo-camera'
import { API_BASE_URL } from '../../config'
import { ownTemporaryImage } from '../../media/owned-temporary-images'
import type { SourceImageAsset } from '../../media/normalize-image'
import { ShutterButton } from '../../ui/camera-chrome'
import { CoachTarget } from '../onboarding/coach-provider'
import type { CameraIntent } from './controller'
import { nativeProofConfig } from '../ai-effort-proof/config'
import type * as ProofCameraModule from '../ai-effort-proof/camera'
import { CameraStage, type AssemblyGuide, type CameraPresentation, type CameraWording } from './camera-stage'

export { cameraCue, cameraPill, type AssemblyGuide, type CameraWording } from './camera-stage'

export type CameraScreenProps = {
    busy: boolean
    intent: CameraIntent | null
    // Present only for check and question captures in an assembly step.
    guide?: AssemblyGuide
    // Words the step's composed guide gave the camera. Wording only: the shutter and preview never depend on it.
    wording?: CameraWording
    onCancel: () => void
    onCapture: (take: () => Promise<SourceImageAsset>) => void
}

/**
 * The synthetic camera of the native proof, or null in every ordinary run. Same guard as the proof's device IO: a
 * development bundle, the explicit fixture flag, the isolated loopback fixture API. It supplies only the picture and
 * hands the capture to the same callback; the stage, shutter, tips and controller are the real ones. The require sits
 * behind `__DEV__` so a production bundle never contains the fixture images.
 */
export function proofCamera(): typeof ProofCameraModule.ProofCamera | null {
    // Compile-time gating removes this require from ordinary production; isolated fixture releases retain it explicitly.
    if (__DEV__ || process.env.EXPO_PUBLIC_RELEASE_FIXTURE === '1') {
        if (nativeProofConfig(API_BASE_URL) !== null) {
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            return (require('../ai-effort-proof/camera') as typeof ProofCameraModule).ProofCamera
        }
    }
    return null
}

export function CameraScreen(props: CameraScreenProps): ReactElement {
    const Proof = proofCamera()
    return Proof === null ? <HardwareCamera {...props} /> : <Proof {...props} />
}

function HardwareCamera({ busy, intent, guide, wording, onCancel, onCapture }: CameraScreenProps): ReactElement {
    const camera = useRef<CameraView>(null)
    const [permission, requestPermission] = useCameraPermissions()
    const [ready, setReady] = useState(false)
    const [error, setError] = useState(false)
    const [attempt, setAttempt] = useState(0)
    const capture = (): void => {
        const view = camera.current
        if (view === null) {
            return
        }
        onCapture(async (): Promise<SourceImageAsset> => {
            const picture = await view.takePictureAsync({
                quality: 1,
                skipProcessing: false,
                exif: false,
            })
            ownTemporaryImage(picture.uri)
            return { uri: picture.uri, width: picture.width, height: picture.height }
        })
    }
    const shutterDisabled = !ready || error || busy
    const shutter = (
        // The tip's target runs this same capture, and only while the shutter itself could.
        <CoachTarget
            id="camera-shutter"
            screen="camera"
            label="Capture photo"
            onPress={shutterDisabled ? undefined : capture}
        >
            <ShutterButton
                label={busy ? 'Preparing photo…' : 'Capture photo'}
                onPress={capture}
                disabled={shutterDisabled}
                busy={busy}
            />
        </CoachTarget>
    )
    const presentation: CameraPresentation =
        permission === null
            ? { status: 'checking-access' }
            : !permission.granted
              ? { status: 'permission', canAskAgain: permission.canAskAgain !== false, error }
              : error
                ? { status: 'error' }
                : {
                      status: 'preview',
                      media: (
                          <CameraView
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
                      ),
                      shutter,
                  }
    return (
        <CameraStage
            intent={intent}
            guide={guide}
            wording={wording}
            presentation={presentation}
            onCancel={onCancel}
            shutterReady={ready && !error}
            busy={busy}
            onRequestPermission={(): void => {
                void requestPermission().catch((): void => setError(true))
            }}
            onOpenSettings={(): void => {
                void Linking.openSettings().catch((): void => setError(true))
            }}
            onRetry={(): void => {
                setError(false)
                setReady(false)
                setAttempt(attempt + 1)
            }}
        />
    )
}
