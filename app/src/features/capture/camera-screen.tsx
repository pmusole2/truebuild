import { useRef, useState, type ReactElement } from 'react'
import { Linking, StyleSheet, View } from 'react-native'
import { CameraView, useCameraPermissions } from 'expo-camera'
import { ownTemporaryImage } from '../../media/owned-temporary-images'
import type { SourceImageAsset } from '../../media/normalize-image'
import { AppButton, IconButton } from '../../ui/button'
import { ShutterButton, ViewfinderCorners } from '../../ui/camera-chrome'
import { Body, Caption } from '../../ui/text'
import { ErrorState, LoadingState, PermissionState } from '../../ui/states'
import { Notice } from '../../ui/status'
import { Screen } from '../../ui/surface'
import { ThemeProvider } from '../../theme/theme'
import { space } from '../../theme/tokens'

export type CameraScreenProps = {
    busy: boolean
    onCancel: () => void
    onCapture: (take: () => Promise<SourceImageAsset>) => void
}

/**
 * Full-bleed rear camera. The preview fills the screen; the top bar, viewfinder corners and shutter sit over it, and the
 * safe-area shell keeps controls clear of the status bar and home indicator. Controls are always dark.
 */
export function CameraScreen({ busy, onCancel, onCapture }: CameraScreenProps): ReactElement {
    const camera = useRef<CameraView>(null)
    const [permission, requestPermission] = useCameraPermissions()
    const [ready, setReady] = useState(false)
    const [error, setError] = useState(false)
    const [attempt, setAttempt] = useState(0)
    return (
        <ThemeProvider scheme="dark">
            <Screen header="hidden" scroll={false} testID="camera-screen">
                <View style={styles.full}>
                    {permission === null ? (
                        <View style={styles.centered}>
                            <LoadingState label="Checking camera access…" />
                        </View>
                    ) : !permission.granted ? (
                        <View style={styles.centered}>
                            <PermissionState
                                title="Camera is off"
                                body="Camera permission is needed to photograph manual pages or assembly steps."
                                primary={{
                                    label: 'Allow camera',
                                    onPress: (): void => {
                                        void requestPermission().catch((): void => setError(true))
                                    },
                                }}
                                secondary={
                                    permission.canAskAgain === false
                                        ? {
                                              label: 'Open device settings',
                                              onPress: (): void => {
                                                  void Linking.openSettings().catch((): void => setError(true))
                                              },
                                          }
                                        : undefined
                                }
                            />
                            {error ? (
                                <Notice
                                    tone="error"
                                    text="Camera access unavailable. Retry, use device settings, or choose manual pages from photos."
                                />
                            ) : null}
                            <AppButton label="Back" variant="quiet" onPress={onCancel} />
                        </View>
                    ) : error ? (
                        <View style={styles.centered}>
                            <ErrorState
                                title="Camera unavailable"
                                body="Close other camera apps and retry, or return to choose pages from photos."
                                retry={{
                                    label: 'Retry camera',
                                    onPress: (): void => {
                                        setError(false)
                                        setReady(false)
                                        setAttempt(attempt + 1)
                                    },
                                }}
                            />
                            <AppButton label="Back" variant="quiet" onPress={onCancel} />
                        </View>
                    ) : (
                        <>
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
                            <View style={styles.topBar}>
                                <IconButton label="Close camera" icon="close" onPress={onCancel} />
                            </View>
                            <View style={styles.viewfinder} pointerEvents="none">
                                <ViewfinderCorners />
                            </View>
                            <View style={styles.bottomBar}>
                                <Body>Frame the page or current assembly step clearly.</Body>
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
                                <Caption>Photos are sent only when you check a step or ask a question.</Caption>
                            </View>
                        </>
                    )}
                </View>
            </Screen>
        </ThemeProvider>
    )
}

const styles = StyleSheet.create({
    full: { flex: 1, backgroundColor: '#000' },
    centered: { flex: 1, justifyContent: 'center', padding: space.md, gap: space.md },
    topBar: { position: 'absolute', top: space.md, left: space.md },
    viewfinder: { ...StyleSheet.absoluteFill, margin: space.xl },
    bottomBar: {
        position: 'absolute',
        left: 0,
        right: 0,
        bottom: space.lg,
        alignItems: 'center',
        gap: space.sm,
        paddingHorizontal: space.md,
    },
})
