import { useRef, useState, type ReactElement } from 'react'
import { Linking, StyleSheet } from 'react-native'
import { CameraView, useCameraPermissions } from 'expo-camera'
import { ownTemporaryImage } from '../../media/owned-temporary-images'
import type { SourceImageAsset } from '../../media/normalize-image'
import { ShutterButton } from '../../ui/camera-chrome'
import type { CameraIntent } from './controller'
import { CameraStage, type AssemblyGuide, type CameraPresentation } from './camera-stage'

export { cameraCaption, PANEL_MAX_RATIO, type AssemblyGuide } from './camera-stage'

export type CameraScreenProps = {
    busy: boolean
    intent: CameraIntent | null
    // Present only for check and question captures in an assembly step.
    guide?: AssemblyGuide
    onCancel: () => void
    onCapture: (take: () => Promise<SourceImageAsset>) => void
}

export function CameraScreen({ busy, intent, guide, onCancel, onCapture }: CameraScreenProps): ReactElement {
    const camera = useRef<CameraView>(null)
    const [permission, requestPermission] = useCameraPermissions()
    const [ready, setReady] = useState(false)
    const [error, setError] = useState(false)
    const [attempt, setAttempt] = useState(0)
    const shutter = (
        <ShutterButton
            label={busy ? 'Preparing photo…' : 'Capture photo'}
            onPress={(): void => {
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
            }}
            disabled={!ready || error || busy}
        />
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
            presentation={presentation}
            onCancel={onCancel}
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
