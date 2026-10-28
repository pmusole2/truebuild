import { useEffect, useState, type ReactElement, type ReactNode } from 'react'
import { ScrollView, StyleSheet, useWindowDimensions, View } from 'react-native'
import type { CameraIntent } from './controller'
import { AppButton, IconButton } from '../../ui/button'
import { ViewfinderCorners } from '../../ui/camera-chrome'
import { Caption, Heading, Label } from '../../ui/text'
import { ErrorState, LoadingState, PermissionState } from '../../ui/states'
import { Notice } from '../../ui/status'
import { Screen } from '../../ui/surface'
import { BottomSheet } from '../../ui/sheet'
import { ThemeProvider } from '../../theme/theme'
import { darkColors, radius, space } from '../../theme/tokens'
import { PRIVACY_COPY } from './privacy-copy'

/** Assembly guide shown over the live preview: compact step progress and the current instructions with the diagram. */
export type AssemblyGuide = {
    readonly progress: string
    readonly title: string
    readonly instructions: ReactNode
}

export const PANEL_MAX_RATIO = 0.32

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

export type CameraPresentation =
    | { readonly status: 'checking-access' }
    | { readonly status: 'permission'; readonly canAskAgain: boolean; readonly error: boolean }
    | { readonly status: 'error' }
    | { readonly status: 'preview'; readonly media: ReactNode; readonly shutter: ReactNode }

/** Camera presentation only. Hardware, permissions and capture ownership remain in CameraScreen. */
export function CameraStage({
    intent,
    guide,
    presentation,
    onCancel,
    onRequestPermission,
    onOpenSettings,
    onRetry,
}: {
    readonly intent: CameraIntent | null
    readonly guide?: AssemblyGuide
    readonly presentation: CameraPresentation
    readonly onCancel: () => void
    readonly onRequestPermission: () => void
    readonly onOpenSettings: () => void
    readonly onRetry: () => void
}): ReactElement {
    const { height, fontScale } = useWindowDimensions()
    const compact = height < 650 || fontScale >= 1.5
    const [instructionsOpen, setInstructionsOpen] = useState(false)
    useEffect(() => {
        if (presentation.status !== 'preview') {
            setInstructionsOpen(false)
        }
    }, [presentation.status])
    const assembly = guide !== undefined && intent !== null && intent.kind !== 'page'
    const shutter = presentation.status === 'preview' ? presentation.shutter : null
    return (
        <ThemeProvider scheme="dark">
            <Screen header="hidden" scroll={false} padded={false} testID="camera-screen">
                <View style={styles.full}>
                    {presentation.status === 'checking-access' ? (
                        <ScrollView contentContainerStyle={styles.centered}>
                            <LoadingState label="Checking camera access…" />
                        </ScrollView>
                    ) : presentation.status === 'permission' ? (
                        <ScrollView contentContainerStyle={styles.centered}>
                            <PermissionState
                                title="Camera is off"
                                body="Camera permission is needed to photograph manual pages or assembly steps."
                                primary={{
                                    label: 'Allow camera',
                                    onPress: onRequestPermission,
                                }}
                                secondary={
                                    !presentation.canAskAgain
                                        ? {
                                              label: 'Open device settings',
                                              onPress: onOpenSettings,
                                          }
                                        : undefined
                                }
                            />
                            {presentation.error ? (
                                <Notice
                                    tone="error"
                                    text="Camera access unavailable. Retry, use device settings, or choose manual pages from photos."
                                />
                            ) : null}
                            <AppButton label="Back" variant="quiet" onPress={onCancel} />
                        </ScrollView>
                    ) : presentation.status === 'error' ? (
                        <ScrollView contentContainerStyle={styles.centered}>
                            <ErrorState
                                title="Camera unavailable"
                                body="Close other camera apps and retry, or return to choose pages from photos."
                                retry={{
                                    label: 'Retry camera',
                                    onPress: onRetry,
                                }}
                            />
                            <AppButton label="Back" variant="quiet" onPress={onCancel} />
                        </ScrollView>
                    ) : (
                        <>
                            {presentation.media}
                            <View style={styles.captureLayout} testID={assembly ? 'assembly-camera' : undefined}>
                                <View style={styles.topBar}>
                                    <IconButton label="Close camera" icon="close" onPress={onCancel} />
                                    <View style={styles.title}>
                                        {assembly ? (
                                            <>
                                                <Label>{guide.progress}</Label>
                                                <Heading>{guide.title}</Heading>
                                            </>
                                        ) : (
                                            <Heading>
                                                {intent?.kind === 'page'
                                                    ? 'Manual page'
                                                    : intent?.kind === 'check'
                                                      ? 'Check this step'
                                                      : intent?.kind === 'question'
                                                        ? 'Ask about this step'
                                                        : 'Camera'}
                                            </Heading>
                                        )}
                                    </View>
                                    {assembly ? (
                                        <IconButton
                                            label="Step instructions"
                                            icon="info"
                                            onPress={(): void => setInstructionsOpen(true)}
                                        />
                                    ) : null}
                                </View>
                                <View style={styles.viewfinder} pointerEvents="none">
                                    <ViewfinderCorners />
                                </View>
                                {assembly && !compact ? (
                                    <ScrollView
                                        testID="assembly-panel"
                                        accessibilityLabel="Current step instructions and diagram"
                                        style={[styles.panel, { maxHeight: height * PANEL_MAX_RATIO }]}
                                        contentContainerStyle={styles.panelContent}
                                    >
                                        <Caption>Current step instructions and diagram</Caption>
                                        {guide.instructions}
                                    </ScrollView>
                                ) : null}
                                <View style={styles.bottomBar}>
                                    <ScrollView
                                        style={[styles.captionScroll, { maxHeight: height * 0.2 }]}
                                        contentContainerStyle={styles.caption}
                                    >
                                        <Caption>{cameraCaption(intent)}</Caption>
                                    </ScrollView>
                                    {shutter}
                                </View>
                            </View>
                        </>
                    )}
                </View>
                <BottomSheet
                    visible={instructionsOpen && assembly && presentation.status === 'preview'}
                    title={guide?.progress ?? 'Step instructions'}
                    onClose={(): void => setInstructionsOpen(false)}
                >
                    {guide?.instructions}
                </BottomSheet>
            </Screen>
        </ThemeProvider>
    )
}

const styles = StyleSheet.create({
    full: { flex: 1, backgroundColor: darkColors.canvas },
    centered: { flexGrow: 1, justifyContent: 'center', padding: space.lg, gap: space.md },
    captureLayout: { ...StyleSheet.absoluteFill },
    topBar: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: space.xs,
        padding: space.sm,
        backgroundColor: darkColors.surface,
    },
    title: { flex: 1 },
    viewfinder: { flex: 1, minHeight: 0, margin: space.lg },
    bottomBar: { alignItems: 'center', gap: space.sm, padding: space.md, backgroundColor: darkColors.canvas },
    caption: { width: '100%' },
    captionScroll: { alignSelf: 'stretch' },
    panel: {
        borderTopWidth: StyleSheet.hairlineWidth,
        borderColor: darkColors.border,
        borderTopLeftRadius: radius.sheet,
        borderTopRightRadius: radius.sheet,
        backgroundColor: darkColors.surface,
    },
    panelContent: { padding: space.md, gap: space.xs },
})
