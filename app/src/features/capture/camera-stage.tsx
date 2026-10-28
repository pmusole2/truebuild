import { useEffect, useState, type ReactElement, type ReactNode } from 'react'
import { Pressable, StyleSheet, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import type { CameraIntent } from './controller'
import { AppButton, IconButton } from '../../ui/button'
import { ViewfinderCorners } from '../../ui/camera-chrome'
import { Body, Callout, Caption, Instruction } from '../../ui/text'
import { LoadingState } from '../../ui/states'
import { MoreSheet } from '../../ui/sheet'
import { ThemeProvider } from '../../theme/theme'
import { darkColors, radius, space, touchTarget } from '../../theme/tokens'

/** Assembly guide shown over the live preview: where the person is, one cue, and the full step one tap away. */
export type AssemblyGuide = {
    // "Step 2 of 8"
    readonly progress: string
    readonly title: string
    // The one line to show the camera, in the step's own words.
    readonly cue?: string
    // A small picture of the step; tapping it opens the full step.
    readonly thumbnail?: ReactNode
    readonly instructions: ReactNode
}

// Glass over the live preview: translucent dark, never a solid band.
const GLASS = 'rgba(15, 17, 19, 0.62)'
const THUMBNAIL_SIZE = 56

/** The single line shown at the bottom of the preview. Never more than one line. */
export function cameraCue(intent: CameraIntent | null, guide?: AssemblyGuide): string {
    if (intent === null) {
        return 'Fill the frame.'
    }
    if (intent.kind === 'page') {
        return 'Fill the frame with one page.'
    }
    if (intent.kind === 'question') {
        return 'Show the part you are asking about.'
    }
    return guide?.cue ?? 'Show the step you just built.'
}

/** What the pill at the top says: the step, or what the photo is for. */
export function cameraPill(intent: CameraIntent | null, guide?: AssemblyGuide): string {
    if (intent?.kind === 'page') {
        return 'Page photo'
    }
    if (intent?.kind === 'question') {
        return guide === undefined ? 'Ask photo' : `${guide.progress} · Ask`
    }
    return guide?.progress ?? 'Photo'
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
    const insets = useSafeAreaInsets()
    const [instructionsOpen, setInstructionsOpen] = useState(false)
    useEffect(() => {
        if (presentation.status !== 'preview') {
            setInstructionsOpen(false)
        }
    }, [presentation.status])
    const assembly = guide !== undefined && intent !== null && intent.kind !== 'page'
    return (
        <ThemeProvider scheme="dark">
            <View testID="camera-screen" style={styles.full}>
                {presentation.status === 'checking-access' ? (
                    <View style={styles.centered}>
                        <LoadingState label="Getting the camera ready." />
                    </View>
                ) : presentation.status === 'permission' ? (
                    <View testID="camera-permission" style={styles.centered}>
                        <Instruction>We need the camera to take photos of your manual and your work.</Instruction>
                        {presentation.error ? (
                            <Body tone="muted">We could not turn the camera on. Try again or open Settings.</Body>
                        ) : null}
                        <AppButton label="Allow camera" variant="accent" size="primary" onPress={onRequestPermission} />
                        {!presentation.canAskAgain ? (
                            <AppButton label="Open Settings" onPress={onOpenSettings} />
                        ) : null}
                        <AppButton label="Go back" variant="quiet" onPress={onCancel} />
                    </View>
                ) : presentation.status === 'error' ? (
                    <View testID="camera-error" style={styles.centered}>
                        <Instruction>The camera is not working. Close other apps and try again.</Instruction>
                        <AppButton label="Try again" variant="accent" size="primary" onPress={onRetry} />
                        <AppButton label="Go back" variant="quiet" onPress={onCancel} />
                    </View>
                ) : (
                    <>
                        {presentation.media}
                        <View
                            style={StyleSheet.absoluteFill}
                            pointerEvents="box-none"
                            testID={assembly ? 'assembly-camera' : undefined}
                        >
                            <View style={styles.viewfinder} pointerEvents="none">
                                <ViewfinderCorners />
                            </View>
                            <View style={[styles.top, { top: insets.top + space.xs }]} pointerEvents="box-none">
                                <View style={styles.glassButton}>
                                    <IconButton
                                        label="Close camera"
                                        icon="close"
                                        testID="camera-close"
                                        onPress={onCancel}
                                    />
                                </View>
                                <View
                                    style={styles.pill}
                                    accessible={true}
                                    accessibilityLabel={cameraPill(intent, guide)}
                                >
                                    <Caption tone="default">{cameraPill(intent, guide)}</Caption>
                                </View>
                                {assembly ? (
                                    <View style={styles.glassButton}>
                                        <IconButton
                                            label="Step details"
                                            icon="info"
                                            onPress={(): void => setInstructionsOpen(true)}
                                        />
                                    </View>
                                ) : (
                                    <View style={styles.glassSpacer} />
                                )}
                            </View>
                            <View
                                style={[styles.bottom, { paddingBottom: insets.bottom + space.md }]}
                                pointerEvents="box-none"
                            >
                                {assembly && guide.thumbnail !== undefined ? (
                                    <Pressable
                                        testID="camera-thumbnail"
                                        accessibilityRole="button"
                                        accessibilityLabel="See the step picture"
                                        onPress={(): void => setInstructionsOpen(true)}
                                        style={styles.thumbnail}
                                    >
                                        {guide.thumbnail}
                                    </Pressable>
                                ) : null}
                                <View style={styles.cue} testID="camera-cue">
                                    <Callout numberOfLines={1}>{cameraCue(intent, guide)}</Callout>
                                </View>
                                {presentation.shutter}
                            </View>
                        </View>
                    </>
                )}
                <MoreSheet
                    visible={instructionsOpen && assembly && presentation.status === 'preview'}
                    title={guide?.progress ?? 'This step'}
                    onClose={(): void => setInstructionsOpen(false)}
                    detents={['tall', 'full']}
                >
                    {guide?.instructions}
                </MoreSheet>
            </View>
        </ThemeProvider>
    )
}

const styles = StyleSheet.create({
    full: { flex: 1, backgroundColor: darkColors.canvas },
    centered: { flex: 1, justifyContent: 'center', padding: space.lg, gap: space.md },
    viewfinder: { ...StyleSheet.absoluteFill, margin: space.md },
    top: {
        position: 'absolute',
        left: space.md,
        right: space.md,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
    },
    glassButton: { backgroundColor: GLASS, borderRadius: radius.pill },
    glassSpacer: { width: touchTarget },
    pill: {
        backgroundColor: GLASS,
        borderRadius: radius.pill,
        paddingHorizontal: space.sm,
        minHeight: 32,
        justifyContent: 'center',
    },
    bottom: {
        position: 'absolute',
        left: 0,
        right: 0,
        bottom: 0,
        alignItems: 'center',
        gap: space.sm,
        paddingHorizontal: space.md,
    },
    cue: {
        backgroundColor: GLASS,
        borderRadius: radius.pill,
        paddingHorizontal: space.md,
        paddingVertical: space.xs,
        maxWidth: '100%',
    },
    thumbnail: {
        alignSelf: 'flex-start',
        width: THUMBNAIL_SIZE,
        height: THUMBNAIL_SIZE,
        borderRadius: radius.md,
        overflow: 'hidden',
    },
})
