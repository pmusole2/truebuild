import { useEffect, useState, type ReactElement, type ReactNode } from 'react'
import { ScrollView, StyleSheet, useWindowDimensions, View } from 'react-native'
import type { CameraIntent } from './controller'
import { AppButton, IconButton } from '../../ui/button'
import { ViewfinderCorners } from '../../ui/camera-chrome'
import { Callout, Caption, Heading } from '../../ui/text'
import { ErrorState, LoadingState, PermissionState } from '../../ui/states'
import { Notice } from '../../ui/status'
import { Card, Screen } from '../../ui/surface'
import { elevationStyle } from '../../theme/elevation'
import { BottomSheet } from '../../ui/sheet'
import { ThemeProvider } from '../../theme/theme'
import { darkColors, radius, space } from '../../theme/tokens'
import { PRIVACY_COPY } from './privacy-copy'

/** Assembly guide shown over the live preview: compact step progress and the current instructions with the diagram. */
export type AssemblyGuide = {
    readonly progress: string
    readonly title: string
    // A short reading of the step shown over the viewfinder. When present the full instructions stay one press away
    // in the sheet; without it the panel falls back to the full instructions.
    readonly summary?: ReactNode
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
                            <Card tone="result">
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
                            </Card>
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
                                                <Caption>{guide.progress}</Caption>
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
                                        style={[
                                            styles.panel,
                                            elevationStyle(2),
                                            { maxHeight: height * PANEL_MAX_RATIO },
                                        ]}
                                        contentContainerStyle={[
                                            styles.panelContent,
                                            guide.summary !== undefined && styles.panelRow,
                                        ]}
                                    >
                                        {guide.summary === undefined ? (
                                            <>
                                                <Caption>Current step instructions and diagram</Caption>
                                                {guide.instructions}
                                            </>
                                        ) : (
                                            <>
                                                <View style={styles.cue}>{guide.summary}</View>
                                                <AppButton
                                                    label="All step facts"
                                                    variant="quiet"
                                                    onPress={(): void => setInstructionsOpen(true)}
                                                />
                                            </>
                                        )}
                                    </ScrollView>
                                ) : null}
                                <View style={styles.bottomBar}>
                                    <ScrollView
                                        style={[styles.captionScroll, { maxHeight: height * 0.2 }]}
                                        contentContainerStyle={styles.caption}
                                    >
                                        <Callout>{cameraCaption(intent)}</Callout>
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
    // A tight frame margin keeps the viewfinder as large as the controls around it allow.
    viewfinder: { flex: 1, minHeight: 0, marginHorizontal: space.md, marginVertical: space.xs },
    bottomBar: {
        alignItems: 'center',
        gap: space.sm,
        paddingHorizontal: space.md,
        paddingVertical: space.sm,
        backgroundColor: darkColors.canvas,
    },
    caption: { width: '100%' },
    captionScroll: { alignSelf: 'stretch' },
    // The panel hugs its content (up to its maximum height) so the viewfinder keeps the rest of the screen.
    panel: {
        flexGrow: 0,
        borderTopWidth: StyleSheet.hairlineWidth,
        borderColor: darkColors.border,
        borderTopLeftRadius: radius.sheet,
        borderTopRightRadius: radius.sheet,
        backgroundColor: darkColors.surfaceRaised,
    },
    panelContent: { padding: space.sm, gap: space.xs },
    // One cue beside the "All step facts" action, so the panel is a single row tall.
    panelRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
    cue: { flex: 1, minWidth: 0 },
})
