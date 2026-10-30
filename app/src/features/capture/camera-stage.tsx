import { useEffect, useRef, useState, type ComponentRef, type ReactElement, type ReactNode } from 'react'
import Animated from 'react-native-reanimated'
import { ScrollView, StyleSheet, View } from 'react-native'
import { StatusBar } from 'expo-status-bar'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import type { CameraIntent } from './controller'
import { IconButton } from '../../ui/button'
import { FixedBottomBar, type BarAction } from '../../ui/bottom-bar'
import { ViewfinderCorners } from '../../ui/camera-chrome'
import { useLargeText } from '../../ui/large-text'
import { PressMotion } from '../../ui/press-motion'
import { Body, Callout, Caption, Instruction } from '../../ui/text'
import { useMeterRoot } from '../../ui/meter-roots'
import { LoadingState } from '../../ui/states'
import { MoreSheet } from '../../ui/sheet'
import { ThemeProvider } from '../../theme/theme'
import { darkColors, radius, space, touchTarget } from '../../theme/tokens'
import { CoachLocalOverlay } from '../onboarding/coach-overlay'
import { cameraCandidates } from '../onboarding/coach-inventory'
import { useContentFade } from '../../ui/motion'
import { useCoach, useCoachAttention, useCoachScope, useCoachScreen } from '../onboarding/coach-provider'
import { applyWrittenTips } from '../documents/coach-copy'

/** Assembly guide shown over the live preview: where the person is, one cue, and the full step one tap away. */
export type AssemblyGuide = {
    // "Step 2 of 8"
    readonly progress: string
    readonly title: string
    // A small picture of the step; tapping it opens the full step.
    readonly thumbnail?: ReactNode
    readonly instructions: ReactNode
}

/**
 * Wording the step's composed guide gave the camera: the one-line cue, the top pill and tip copy for the shutter. It
 * only replaces words. The preview, corners, shutter, permission flow and every gate stay the camera's own, and each
 * item names the server-owned origin of the document component that wrote it.
 */
export type CameraWording = {
    readonly cue: { readonly text: string; readonly nativeID: string } | null
    readonly pill: { readonly text: string; readonly nativeID: string } | null
    readonly tips: ReadonlyMap<string, { readonly heading: string; readonly text: string }>
}

// Glass over the live preview: translucent dark, never a solid band.
const GLASS = 'rgba(15, 17, 19, 0.62)'
const THUMBNAIL_SIZE = 56

/** "2/8" from "Step 2 of 8": the compact progress at accessibility text sizes. Null when the text is not that shape. */
function compactProgress(progress: string): string | null {
    const match = /(\d+) of (\d+)/u.exec(progress)
    return match === null ? null : `${match[1]}/${match[2]}`
}

/**
 * The single line shown at the bottom of the preview: one short, generic instruction at every text size, so it fits
 * without being cut off. It never names a part or fact of the manual; the full step is one tap away in the picture's
 * details.
 */
export function cameraCue(intent: CameraIntent | null, wording?: CameraWording): string {
    if (wording?.cue != null && intent !== null && intent.kind !== 'page') {
        return wording.cue.text
    }
    if (intent === null) {
        return 'Fill the frame.'
    }
    return intent.kind === 'page' ? 'Show a page.' : 'Show the part.'
}

/** What the pill at the top says: the step, or what the photo is for. Compact form: "2/8", "Page", "Ask". */
export function cameraPill(
    intent: CameraIntent | null,
    guide?: AssemblyGuide,
    compact = false,
    wording?: CameraWording,
): string {
    const count = guide === undefined ? null : compactProgress(guide.progress)
    // The compact form exists for the largest text sizes, where it is the only one that fits; it is never replaced.
    if (!compact && wording?.pill != null && intent !== null && intent.kind !== 'page') {
        return wording.pill.text
    }
    if (intent?.kind === 'page') {
        return compact ? 'Page' : 'Page photo'
    }
    if (intent?.kind === 'question') {
        return guide === undefined
            ? compact
                ? 'Ask'
                : 'Ask photo'
            : `${compact ? (count ?? 'Step') : guide.progress} · Ask`
    }
    return compact ? (count ?? 'Photo') : (guide?.progress ?? 'Photo')
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
    shutterReady = false,
    busy = false,
    wording,
}: {
    readonly intent: CameraIntent | null
    readonly guide?: AssemblyGuide
    readonly presentation: CameraPresentation
    readonly onCancel: () => void
    readonly onRequestPermission: () => void
    readonly onOpenSettings: () => void
    readonly onRetry: () => void
    // The shutter can be pressed: the preview is live and nothing is being captured. Tips wait for it.
    readonly shutterReady?: boolean
    readonly busy?: boolean
    // Words from the step's composed guide, when it has any.
    readonly wording?: CameraWording
}): ReactElement {
    const insets = useSafeAreaInsets()
    const large = useLargeText()
    // The camera is a full-screen modal route with its own window; the host meter reaches it through this ref.
    const root = useRef<ComponentRef<typeof View>>(null)
    const attachRoot = useMeterRoot(root, 'camera')
    const coaching = useCoach()?.active?.screen === 'camera'
    const [instructionsOpen, setInstructionsOpen] = useState(false)
    useEffect(() => {
        if (presentation.status !== 'preview') {
            setInstructionsOpen(false)
        }
    }, [presentation.status])
    const assembly = guide !== undefined && intent !== null && intent.kind !== 'page'
    // One tip, inside this modal (never a second modal), and only over a live, ready, idle shutter.
    useCoachScreen('camera', {
        host: 'local',
        suppressed: presentation.status !== 'preview' || !shutterReady || busy || instructionsOpen,
        candidates: applyWrittenTips(
            cameraCandidates({ intent: intent === null ? null : intent.kind === 'page' ? 'page' : 'part' }),
            assembly ? wording?.tips : undefined,
        ),
    })
    const scope = useCoachScope()
    const attention = useCoachAttention()
    const chromeFade = useContentFade(
        `${presentation.status}:${shutterReady ? 'ready' : 'waiting'}`,
        scope.active && !attention && !busy && !instructionsOpen && (presentation.status !== 'preview' || shutterReady),
    )
    const openDetails = (): void => setInstructionsOpen(true)
    // The explanation scrolls, the close control stays in the header and the one recovery action sits in the fixed bar.
    const recovery: { readonly body: ReactNode; readonly action: BarAction | null; readonly testID?: string } | null =
        presentation.status === 'permission'
            ? {
                  testID: 'camera-permission',
                  body: (
                      <>
                          <Instruction>We need the camera for photos of your manual and work.</Instruction>
                          {presentation.canAskAgain ? null : (
                              <Body tone="muted">Turn on Camera for TrueBuild in Settings.</Body>
                          )}
                          {presentation.error ? (
                              <Body tone="muted">
                                  {presentation.canAskAgain
                                      ? 'We could not turn the camera on. Try again.'
                                      : 'We could not open Settings. Try again.'}
                              </Body>
                          ) : null}
                      </>
                  ),
                  // A permanent refusal cannot be asked again, so the one useful action is Settings, never a dead Allow.
                  action: presentation.canAskAgain
                      ? { label: 'Allow camera', compactLabel: 'Allow', onPress: onRequestPermission }
                      : { label: 'Open Settings', compactLabel: 'Settings', onPress: onOpenSettings },
              }
            : presentation.status === 'error'
              ? {
                    testID: 'camera-error',
                    body: <Instruction>The camera is not working. Close other apps and try again.</Instruction>,
                    action: { label: 'Try again', compactLabel: 'Retry', onPress: onRetry },
                }
              : presentation.status === 'checking-access'
                ? { body: <LoadingState label="Getting the camera ready." />, action: null }
                : null
    return (
        <ThemeProvider scheme="dark">
            <View ref={attachRoot} testID="camera-screen" style={styles.full}>
                <View
                    style={styles.full}
                    accessibilityElementsHidden={coaching}
                    importantForAccessibility={coaching ? 'no-hide-descendants' : 'auto'}
                >
                    {/* The camera is dark and full bleed in both appearances, so its status bar text is always light. */}
                    <StatusBar style="light" />
                    {recovery !== null ? (
                        <>
                            <View style={[styles.stateHeader, { paddingTop: insets.top + space.xs }]}>
                                <IconButton label="Go back" icon="close" testID="camera-close" onPress={onCancel} />
                            </View>
                            <Animated.View style={[styles.stateScroll, chromeFade]}>
                                <ScrollView
                                    testID={recovery.testID}
                                    style={styles.stateScroll}
                                    contentContainerStyle={styles.stateContent}
                                >
                                    {recovery.body}
                                </ScrollView>
                            </Animated.View>
                            {recovery.action === null ? null : <FixedBottomBar primary={recovery.action} />}
                        </>
                    ) : presentation.status === 'preview' ? (
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
                                <Animated.View
                                    style={[styles.top, { top: insets.top + space.xs }, chromeFade]}
                                    pointerEvents="box-none"
                                >
                                    <View style={styles.glassButton}>
                                        <IconButton
                                            label="Close camera"
                                            icon="close"
                                            testID="camera-close"
                                            onPress={onCancel}
                                        />
                                    </View>
                                    <View
                                        nativeID={
                                            assembly && wording?.pill != null
                                                ? large
                                                    ? 'truebuild-render-origin:shell'
                                                    : wording.pill.nativeID
                                                : undefined
                                        }
                                        style={styles.pill}
                                        accessible={true}
                                        accessibilityLabel={cameraPill(intent, guide, false, wording)}
                                    >
                                        <Caption tone="default">{cameraPill(intent, guide, large, wording)}</Caption>
                                    </View>
                                    <View style={styles.glassSpacer} />
                                </Animated.View>
                                <Animated.View
                                    style={[styles.bottom, { paddingBottom: insets.bottom + space.md }, chromeFade]}
                                    pointerEvents="box-none"
                                >
                                    {assembly ? (
                                        guide.thumbnail !== undefined ? (
                                            // The picture opens the step's details, so no second info control is needed.
                                            <PressMotion
                                                testID="camera-thumbnail"
                                                accessibilityRole="button"
                                                accessibilityLabel="See the step picture"
                                                onPress={openDetails}
                                                style={styles.thumbnail}
                                            >
                                                {guide.thumbnail}
                                            </PressMotion>
                                        ) : (
                                            // With no picture to tap, the details keep one way in.
                                            <View style={[styles.glassButton, styles.detailsButton]}>
                                                <IconButton label="Step details" icon="info" onPress={openDetails} />
                                            </View>
                                        )
                                    ) : null}
                                    <View
                                        nativeID={assembly && wording?.cue != null ? wording.cue.nativeID : undefined}
                                        style={styles.cue}
                                        testID="camera-cue"
                                        accessible={true}
                                        accessibilityLabel={cameraCue(intent, assembly ? wording : undefined)}
                                    >
                                        <Callout numberOfLines={large ? undefined : 1}>
                                            {cameraCue(intent, assembly ? wording : undefined)}
                                        </Callout>
                                    </View>
                                    {presentation.shutter}
                                </Animated.View>
                            </View>
                        </>
                    ) : null}
                    <MoreSheet
                        visible={instructionsOpen && assembly && presentation.status === 'preview'}
                        title={guide?.progress ?? 'This step'}
                        compactTitle={
                            guide === undefined
                                ? undefined
                                : `Step ${compactProgress(guide.progress)?.split('/')[0] ?? ''}`.trim()
                        }
                        onClose={(): void => setInstructionsOpen(false)}
                        detents={['tall', 'full']}
                    >
                        {guide?.instructions}
                    </MoreSheet>
                </View>
                <CoachLocalOverlay screen="camera" />
            </View>
        </ThemeProvider>
    )
}

const styles = StyleSheet.create({
    full: { flex: 1, backgroundColor: darkColors.canvas },
    stateHeader: { flexDirection: 'row', paddingHorizontal: space.md },
    stateScroll: { flex: 1, minHeight: 0 },
    stateContent: { flexGrow: 1, justifyContent: 'center', padding: space.lg, gap: space.md },
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
    detailsButton: { alignSelf: 'flex-start' },
    thumbnail: {
        alignSelf: 'flex-start',
        width: THUMBNAIL_SIZE,
        height: THUMBNAIL_SIZE,
        borderRadius: radius.md,
        overflow: 'hidden',
    },
})
