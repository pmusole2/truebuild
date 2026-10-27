import { useRef, useState, type ReactElement, type ReactNode } from 'react'
import { Linking, ScrollView, StyleSheet, useWindowDimensions, View } from 'react-native'
import { CameraView, useCameraPermissions } from 'expo-camera'
import { ownTemporaryImage } from '../../media/owned-temporary-images'
import type { SourceImageAsset } from '../../media/normalize-image'
import { AppButton, IconButton } from '../../ui/button'
import { ShutterButton, ViewfinderCorners } from '../../ui/camera-chrome'
import { Body, Caption, Heading, Label } from '../../ui/text'
import { ErrorState, LoadingState, PermissionState } from '../../ui/states'
import { Notice } from '../../ui/status'
import { Screen } from '../../ui/surface'
import { ThemeProvider, useTheme } from '../../theme/theme'
import { radius, space } from '../../theme/tokens'
import type { CameraIntent } from './controller'
import { PRIVACY_COPY } from './privacy-copy'

/** Assembly guide shown over the live preview: compact step progress and the current instructions with the diagram. */
export type AssemblyGuide = {
    readonly progress: string
    readonly title: string
    readonly instructions: ReactNode
}

export type CameraScreenProps = {
    busy: boolean
    intent: CameraIntent | null
    // Present only for check and question captures in an assembly step.
    guide?: AssemblyGuide
    onCancel: () => void
    onCapture: (take: () => Promise<SourceImageAsset>) => void
}

export const PANEL_MAX_RATIO = 0.42

/** What the capture does with the photo, stated where the photo is taken. */
export function cameraCaption(intent: CameraIntent | null): string {
    if (intent === null) {
        return 'Frame the subject clearly.'
    }
    if (intent.kind === 'page') {
        return `Frame the manual page. ${PRIVACY_COPY.stayOnDevice}`
    }
    if (intent.kind === 'check') {
        return `Frame the current assembly step. ${PRIVACY_COPY.check}`
    }
    return `Frame the part you are asking about. ${PRIVACY_COPY.ask}`
}

/**
 * Full-bleed rear camera. Manual scanning keeps a plain overlay. An assembly capture (check or question) puts the current
 * step's progress and instructions with its diagram over the live preview, so the step stays in view while framing.
 * Permission, retry, abort and capture behave as before; controls are always dark.
 */
export function CameraScreen({ busy, intent, guide, onCancel, onCapture }: CameraScreenProps): ReactElement {
    const camera = useRef<CameraView>(null)
    const [permission, requestPermission] = useCameraPermissions()
    const [ready, setReady] = useState(false)
    const [error, setError] = useState(false)
    const [attempt, setAttempt] = useState(0)
    const { height } = useWindowDimensions()
    const { colors } = useTheme()
    const assembly = guide !== undefined && intent !== null && intent.kind !== 'page'
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
                            {assembly ? (
                                <View style={styles.assembly} testID="assembly-camera">
                                    <View style={styles.assemblyTop}>
                                        <IconButton label="Close camera" icon="close" onPress={onCancel} />
                                        <View style={styles.assemblyTitle}>
                                            <Label>{guide.progress}</Label>
                                            <Heading>{guide.title}</Heading>
                                        </View>
                                    </View>
                                    <View style={styles.viewfinder} pointerEvents="none">
                                        <ViewfinderCorners />
                                    </View>
                                    <ScrollView
                                        testID="assembly-panel"
                                        style={[
                                            styles.panel,
                                            {
                                                maxHeight: height * PANEL_MAX_RATIO,
                                                backgroundColor: colors.surface,
                                                borderColor: colors.border,
                                            },
                                        ]}
                                        contentContainerStyle={styles.panelContent}
                                    >
                                        <Body tone="muted">Current step instructions and diagram</Body>
                                        {guide.instructions}
                                    </ScrollView>
                                    <View style={styles.shutterRow}>
                                        {shutter}
                                        <Caption>{cameraCaption(intent)}</Caption>
                                    </View>
                                </View>
                            ) : (
                                <>
                                    <View style={styles.topBar}>
                                        <IconButton label="Close camera" icon="close" onPress={onCancel} />
                                    </View>
                                    <View style={styles.viewfinder} pointerEvents="none">
                                        <ViewfinderCorners />
                                    </View>
                                    <View style={styles.bottomBar}>
                                        <Body>{cameraCaption(intent)}</Body>
                                        {shutter}
                                    </View>
                                </>
                            )}
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
    assembly: { ...StyleSheet.absoluteFill, justifyContent: 'space-between' },
    assemblyTop: { flexDirection: 'row', alignItems: 'center', gap: space.sm, padding: space.md },
    assemblyTitle: { flex: 1 },
    panel: {
        borderTopWidth: 1,
        borderTopLeftRadius: radius.lg,
        borderTopRightRadius: radius.lg,
    },
    panelContent: { padding: space.md, gap: space.sm },
    shutterRow: { alignItems: 'center', gap: space.sm, paddingVertical: space.sm, backgroundColor: '#000' },
})
