import { waitCopyV2 } from '@truebuild/contracts'
import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import {
    Image,
    Platform,
    ScrollView,
    StyleSheet,
    View,
    type LayoutChangeEvent,
    type NativeScrollEvent,
    type NativeSyntheticEvent,
} from 'react-native'
import Svg, { Path, SvgXml } from 'react-native-svg'
import Animated, { useAnimatedStyle, useSharedValue, type SharedValue } from 'react-native-reanimated'
import { useColdEntrance } from '../../ui/cold-start'
import { useEntranceGroup, useEntranceTimeline } from '../../ui/motion'
import { useCoachAttention, useCoachScope, useCoachScreen } from '../onboarding/coach-provider'
import { homeCandidates } from '../onboarding/coach-inventory'
import { ShowTipsAgainRow } from '../onboarding/tips-rows'
import { FixedBottomBar } from '../../ui/bottom-bar'
import { useFeedback } from '../../ui/feedback'
import { MoreSheet } from '../../ui/sheet'
import { SectionHeader } from '../../ui/headers'
import { PartChip } from '../../ui/part-chip'
import { Card, Stack } from '../../ui/surface'
import { Body, Heading, Instruction, LargeTitle } from '../../ui/text'
import { LoadingState } from '../../ui/states'
import { ProgressBar } from '../../ui/progress'
import { Icon } from '../../ui/icons'
import { focusRingStyle, useFocusRing } from '../../ui/focus'
import { PressMotion } from '../../ui/press-motion'
import { useTheme } from '../../theme/theme'
import { space, touchTarget } from '../../theme/tokens'
import type { LibraryEntry } from './library'
import { AboutThisCheck, HowItWorks } from './more-sections'
import { plainNotice, plainPending, progressLine, stopFor } from './plain-copy'
import { inlineSvgXml } from './page-media'
import { PlainNotice, ScreenBody } from './screen-layout'
import { InlineHeader, useMoreState, type ChromeProps } from './screen-header'
import { defaultNav, type ScreenNav } from './screen-nav'
import { SettingsSections } from './settings-screen'
import type { WorkflowScreenProps } from './workflow-types'
import { originId, type RenderOrigin } from '../screens/render-origin'
/** Distance the large title takes to collapse into the small header title. */
export const COLLAPSE_DISTANCE = 56

/** 0 at rest, 1 once the large title has scrolled `distance` away. Pure so the header and the title share one rule. */
// Keep the default literal: Reanimated does not capture references used only in a default parameter.
export function collapseProgress(offset: number, distance: number = 56): number {
    'worklet'

    return Math.max(0, Math.min(1, offset / distance))
}

/**
 * Home's scroll offset and whether its large heading has scrolled away, for the one header and the one list that share
 * them. The state is presentational only. `resetKey` clears both when the screen behind them is swapped for another
 * (the gallery changing fixture or scheme), so the next Home does not inherit a collapsed bar.
 */
export function useHomeTitle(resetKey?: string): {
    readonly scrollY: SharedValue<number>
    readonly collapsed: boolean
    readonly onCollapsedChange: (collapsed: boolean) => void
} {
    const scrollY = useSharedValue(0)
    const [state, setState] = useState({
        key: resetKey,
        collapsed: false,
    })
    useEffect(() => {
        scrollY.value = 0
    }, [resetKey, scrollY])
    const onCollapsedChange = useCallback(
        (collapsed: boolean): void =>
            setState({
                key: resetKey,
                collapsed,
            }),
        [resetKey],
    )
    return {
        scrollY,
        collapsed: state.key === resetKey && state.collapsed,
        onCollapsedChange,
    }
}

/** Small title that appears in the header as the large one collapses. Android and previews. */
export function PinnedTitle({ scrollY, title }: { scrollY: SharedValue<number>; title: string }): ReactElement {
    const style = useAnimatedStyle(() => ({
        opacity: collapseProgress(scrollY.value),
    }))
    return (
        <Animated.View testID="pinned-title" style={style}>
            <Heading numberOfLines={1}>{title}</Heading>
        </Animated.View>
    )
}
function CollapsingTitle({ scrollY, title }: { scrollY: SharedValue<number>; title: string }): ReactElement {
    const { reduceMotion } = useFeedback()
    const style = useAnimatedStyle(() => {
        const progress = collapseProgress(scrollY.value)
        return {
            opacity: 1 - progress,
            transform: [
                {
                    scale: reduceMotion ? 1 : 1 - progress * 0.2,
                },
            ],
        }
    })
    return (
        <Animated.View testID="collapsing-title" style={[styles.collapsing, style]}>
            <LargeTitle>{title}</LargeTitle>
        </Animated.View>
    )
}

/**
 * iOS Home's large heading. The platform's own large title painted nothing on a real device, so the heading lives in
 * the list and fades as the list scrolls; the native bar then shows its small platform title. It wraps and is never
 * capped. The fade runs over the heading's own measured height, so a tall heading at the largest text size does not
 * fade out early and leave a blank gap while it is still on screen.
 */
function HomeHeading({
    scrollY,
    distance,
    onHeight,
    title = HOME_HEADING,
    origin,
}: {
    scrollY: SharedValue<number>
    distance: number
    onHeight: (height: number) => void
    title?: string
    origin?: RenderOrigin
}): ReactElement {
    const { reduceMotion } = useFeedback()
    const style = useAnimatedStyle(() => {
        const progress = collapseProgress(scrollY.value, distance)
        return reduceMotion
            ? {
                  opacity: 1 - progress,
                  transform: [
                      {
                          scale: 1,
                      },
                  ],
              }
            : {
                  opacity: 1 - progress,
                  transform: [
                      {
                          scale: 1 - progress * 0.2,
                      },
                  ],
              }
    })
    return (
        <Animated.View
            testID="home-heading"
            style={[styles.collapsing, style]}
            onLayout={(event: LayoutChangeEvent): void => onHeight(Math.ceil(event.nativeEvent.layout.height))}
        >
            <LargeTitle nativeID={origin === undefined ? undefined : originId(origin)}>{title}</LargeTitle>
        </Animated.View>
    )
}
type LibraryProps = WorkflowScreenProps &
    ChromeProps & {
        readonly nav?: ScreenNav
        // 'content' draws "TrueBuild" inside the scroll (Android, previews). 'heading' (iOS) draws "Your builds" there
        // and reports, through onCollapsedChange, when it has scrolled away so the native bar can show its own title.
        readonly largeTitle?: 'content' | 'heading'
        readonly scrollY?: SharedValue<number>
        readonly onCollapsedChange?: (collapsed: boolean) => void
    }
const HOME_HEADING = 'Your builds'

/** Why Add manual is unavailable, so a disabled primary action is never unexplained. */
function addHint(state: WorkflowScreenProps['state']): string | null {
    if (state.loading) {
        return waitCopyV2('home').action
    }
    if (state.storageReadOnly) {
        return 'Adding is paused until your saved builds open again.'
    }
    if (state.pending !== null) {
        return plainPending(state.pending, 'home')
    }
    return null
}
const PRIMARY_LABEL = {
    pages: 'Add photos',
    overview: 'Answer a few questions',
    guide: 'Keep building',
    done: 'See finished build',
} as const

// Short visible verbs at accessibility text sizes; the full labels above stay as the accessible names.
const PRIMARY_COMPACT = {
    pages: 'Add',
    overview: 'Answer',
    guide: 'Resume',
    done: 'Open',
} as const
export function LibraryScreen({
    state,
    controller,
    nav: navProp,
    chrome = 'inline',
    more: moreProp,
    largeTitle = chrome === 'inline' ? 'content' : 'heading',
    scrollY: scrollYProp,
    onCollapsedChange,
}: LibraryProps): ReactElement {
    const internalMore = useMoreState()
    const more = moreProp ?? internalMore
    // On iOS the list fills the screen under a floating bar, padded by the bar's measured height, so the heading
    // scrolls with it. Elsewhere the bar sits below the list as before.
    const overlay = largeTitle === 'heading'
    const [barHeight, setBarHeight] = useState(0)
    const [headingHeight, setHeadingHeight] = useState(0)
    const collapsed = useRef(false)
    const latestOffset = useRef(0)
    const distance = headingHeight > 0 ? headingHeight : COLLAPSE_DISTANCE
    const reconcileTitle = useCallback(
        (offset: number): void => {
            const nextCollapsed = offset >= distance
            if (overlay && onCollapsedChange !== undefined && nextCollapsed !== collapsed.current) {
                collapsed.current = nextCollapsed
                onCollapsedChange(nextCollapsed)
            }
        },
        [distance, onCollapsedChange, overlay],
    )
    useEffect(() => {
        reconcileTitle(latestOffset.current)
    }, [reconcileTitle])
    const ownScroll = useSharedValue(0)
    const scrollY = scrollYProp ?? ownScroll
    const nav = navProp ?? defaultNav(controller)
    const addDisabled = state.loading || state.pending !== null || state.storageReadOnly
    const failed = !state.loading && state.storageReadOnly
    const hint = failed ? plainPending(state.pending, 'home') : addHint(state)
    const recoveryCopy =
        state.notice === null
            ? 'Your saved builds need another try.'
            : plainNotice(state.notice).replace(/ Try again\.$/u, '')
    const empty = !state.loading && !state.storageReadOnly && state.entries.length === 0

    // Most recently touched first; the first one is where "keep building" goes.
    const entries = [...state.entries].sort((a, b) => b.session.updatedAt.localeCompare(a.session.updatedAt))
    const sole = entries.length === 1 ? entries[0] : undefined
    const addManual = (): void => {
        void controller.createManual()
    }
    const onScroll = (event: NativeSyntheticEvent<NativeScrollEvent>): void => {
        const offset = event.nativeEvent.contentOffset.y
        latestOffset.current = offset
        scrollY.value = offset
        reconcileTitle(offset)
    }
    const primary = state.loading
        ? {
              label: 'Add manual',
              compactLabel: 'Add',
              testID: 'home-add',
              onPress: addManual,
              disabled: true,
          }
        : failed
          ? {
                label: 'Try again',
                compactLabel: 'Retry',
                testID: 'retry-library',
                disabled: state.pending !== null,
                onPress: (): void => {
                    void controller.restore()
                },
            }
          : sole !== undefined && !addDisabled
            ? {
                  label: PRIMARY_LABEL[stopFor(sole)],
                  compactLabel: PRIMARY_COMPACT[stopFor(sole)],
                  testID: 'keep-building',
                  onPress: (): void => nav.openStop(sole),
              }
            : {
                  label: 'Add manual',
                  compactLabel: 'Add',
                  icon: 'plus' as const,
                  testID: 'home-add',
                  onPress: addManual,
                  disabled: addDisabled,
              }
    // The empty Home has no secondary: How it works is in More. A sole manual keeps one quiet Add beside its resume.
    const secondary =
        sole !== undefined && !addDisabled
            ? {
                  label: 'Add manual',
                  icon: 'plus' as const,
                  testID: 'home-add',
                  onPress: addManual,
              }
            : undefined
    // First-run tips: the real Add or resume primary, and the native header's More. Anything working or covering the
    // screen holds them back; the screen's own state is the only source of what to teach.
    const scope = useCoachScope()
    useCoachScreen('home', {
        suppressed: state.loading || state.pending !== null || state.storageReadOnly || failed || more.open,
        candidates: homeCandidates({
            add: !failed && !addDisabled && sole === undefined,
            resume: !failed && !addDisabled && sole !== undefined,
            more: chrome === 'native',
        }),
    })
    // The launch entrance plays once, for the first cold start only, after the content is ready. The heading and the
    // content share one timeline; the header and the bottom bar never move.
    const attention = useCoachAttention()
    const motionEnabled =
        !state.loading && !state.storageReadOnly && state.pending === null && !more.open && !attention && scope.active
    const cold = useColdEntrance(!state.loading, !motionEnabled)
    const timeline = useEntranceTimeline(cold, motionEnabled)
    const headingEntrance = useEntranceGroup(timeline, 0, 0.6, true)
    const contentEntrance = useEntranceGroup(timeline, 0.3, 1, true)
    return (
        <ScreenBody testID="library-screen">
            {chrome === 'inline' ? <InlineHeader title="Your builds" more={more} /> : null}
            {/* The scroll view is the first child so the list fills the screen under the header. */}
            <ScrollView
                testID="library-scroll"
                contentContainerStyle={[
                    styles.content,
                    empty && !overlay && styles.centred,
                    empty && overlay && styles.fill,
                    overlay && {
                        paddingBottom: space.md + barHeight,
                    },
                ]}
                keyboardShouldPersistTaps="handled"
                contentInsetAdjustmentBehavior="automatic"
                scrollEventThrottle={16}
                onScroll={onScroll}
            >
                <Animated.View style={headingEntrance}>
                    {largeTitle === 'content' ? <CollapsingTitle scrollY={scrollY} title="TrueBuild" /> : null}
                    {overlay ? (
                        <HomeHeading
                            scrollY={scrollY}
                            distance={distance}
                            onHeight={setHeadingHeight}
                            title={HOME_HEADING}
                            origin={undefined}
                        />
                    ) : null}
                </Animated.View>
                <Animated.View style={[styles.group, empty && overlay && styles.groupFill, contentEntrance]}>
                    {state.storageReadOnly ? null : <PlainNotice state={state} controller={controller} />}
                    {state.loading ? (
                        <Card>
                            <LoadingState label={waitCopyV2('home').heading} shape="card" />
                        </Card>
                    ) : failed ? (
                        <Instruction>{recoveryCopy}</Instruction>
                    ) : empty ? (
                        <HomeEmptyState />
                    ) : null}
                    {entries.map((entry) => (
                        <ManualRow
                            key={entry.session.manualId}
                            entry={entry}
                            pageUris={state.pageUris}
                            disabled={state.pending !== null || state.storageReadOnly}
                            onOpen={(): void => nav.openStop(entry)}
                        />
                    ))}
                    {sole === undefined || state.storageReadOnly ? null : <WhatsNextPreview entry={sole} />}
                </Animated.View>
            </ScrollView>
            <FixedBottomBar
                {...{
                    primary,
                    secondary,
                }}
                reason={hint ?? null}
                placement={overlay ? 'overlay' : 'flow'}
                onHeight={overlay ? setBarHeight : undefined}
            />
            <MoreSheet visible={more.open} title="More" onClose={more.hide}>
                <HowItWorks />
                <SettingsSections state={state} />
                <ShowTipsAgainRow onClose={more.hide} />
                <AboutThisCheck onCompare={more.hide} />
            </MoreSheet>
        </ScreenBody>
    )
}
/** Only the saved manual title names a manual; this session contract has no extracted product title. */
export function savedManualTitle(entry: LibraryEntry): string {
    const title = entry.session.title.trim()
    return title === '' || /^untitled(?: manual)?$/iu.test(title) ? 'Untitled manual' : title
}

/** A static blueprint motif, shared by missing covers and the first-run invitation. */
function BlueprintTile({ large = false }: { large?: boolean }): ReactElement {
    const { colors } = useTheme()
    return (
        <View
            testID="manual-blueprint"
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
            style={[styles.blueprint, large && styles.blueprintLarge, { backgroundColor: colors.surfaceSunken }]}
        >
            <Svg width={large ? 112 : 54} height={large ? 112 : 54} viewBox="0 0 80 80" fill="none" aria-hidden>
                <Path d="M12 16h56v48H12z M20 8v64 M60 8v64 M6 24h68 M6 56h68" stroke={colors.border} strokeWidth={1} />
                <Path
                    d="m25 31 17-9 16 9-17 9z M25 31v18l16 10 17-10V31 M41 40v19"
                    stroke={colors.accent}
                    strokeWidth={2}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                />
            </Svg>
        </View>
    )
}

export function HomeEmptyState({
    nativeID,
    subtitle = 'Photograph the pages. Build one step at a time.',
}: {
    nativeID?: string
    subtitle?: string
}): ReactElement {
    return (
        <View nativeID={nativeID} style={styles.hero}>
            <BlueprintTile large />
            <Heading style={styles.emptyTitle}>Add your first manual</Heading>
            <Body tone="muted" style={styles.emptyDetail}>
                {subtitle}
            </Body>
        </View>
    )
}

/** An 80-point cover. Available pixels crop into the square; missing pixels keep the same blueprint tile. */
function ManualThumb({
    entry,
    pageUris,
}: {
    entry: LibraryEntry
    pageUris: LibraryProps['state']['pageUris']
}): ReactElement {
    const { colors } = useTheme()
    const page = entry.session.pages[0]
    const uri = page === undefined ? undefined : pageUris[page.pageId]
    const xml = uri === undefined || Platform.OS === 'web' ? null : inlineSvgXml(uri)
    return (
        <View
            testID="manual-thumb"
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
            style={[styles.thumb, { backgroundColor: colors.surfaceSunken }]}
        >
            {uri === undefined ? (
                <BlueprintTile />
            ) : xml === null ? (
                <Image
                    source={{ uri }}
                    accessibilityLabel="First page of your manual"
                    resizeMode="cover"
                    style={StyleSheet.absoluteFill}
                />
            ) : (
                <View
                    accessibilityRole="image"
                    accessibilityLabel="First page of your manual"
                    style={StyleSheet.absoluteFill}
                >
                    <SvgXml xml={xml} width="100%" height="100%" preserveAspectRatio="xMidYMid slice" />
                </View>
            )}
        </View>
    )
}

/** Preview comes only from the current reviewed step and its known registry parts. It adds no invented facts. */
export function WhatsNextPreview({ entry, nativeID }: { entry: LibraryEntry; nativeID?: string }): ReactElement | null {
    const step = entry.session.reviewedSteps[entry.stepIndex]
    if (step === undefined || stopFor(entry) !== 'guide') return null
    const parts = step.parts.flatMap((requirement) => {
        const part = entry.session.parts.find((candidate) => candidate.partId === requirement.partId)
        return part?.name.state === 'known'
            ? [{ id: part.partId, name: part.name.value, quantity: requirement.quantity }]
            : []
    })
    return (
        <View nativeID={nativeID} testID="home-next-preview" style={styles.preview}>
            <SectionHeader title="What's next" />
            <Card>
                <Heading>{step.title}</Heading>
                {parts.length === 0 ? null : (
                    <View style={styles.parts}>
                        {parts.map((part) => (
                            <PartChip
                                key={part.id}
                                name={part.name}
                                count={part.quantity.state === 'known' ? part.quantity.value : null}
                            />
                        ))}
                    </View>
                )}
            </Card>
        </View>
    )
}

export function ManualRow({
    entry,
    pageUris,
    onOpen,
    nativeID,
    disabled = false,
    showProgress = true,
}: {
    entry: LibraryEntry
    pageUris: LibraryProps['state']['pageUris']
    onOpen: () => void
    nativeID?: string
    disabled?: boolean
    showProgress?: boolean
}): ReactElement {
    const { colors } = useTheme()
    const focus = useFocusRing()
    const step = entry.session.reviewedSteps[entry.stepIndex]
    const next =
        stopFor(entry) === 'guide' && step !== undefined
            ? `${progressLine(entry)} · Next: ${step.title}`
            : progressLine(entry)
    return (
        <Card tone="raised" testID="manual-card" nativeID={nativeID}>
            <PressMotion
                accessibilityRole="button"
                accessibilityLabel={`Open ${savedManualTitle(entry)}`}
                accessibilityState={{
                    disabled,
                }}
                disabled={disabled}
                {...focus.focusHandlers}
                onPress={onOpen}
                style={[styles.row, focusRingStyle(focus.focused, colors)]}
            >
                <ManualThumb entry={entry} pageUris={pageUris} />
                <View style={styles.summaryText}>
                    <Stack gap="xs">
                        <Heading numberOfLines={2}>{savedManualTitle(entry)}</Heading>
                        <Body tone="muted" numberOfLines={1} style={styles.nextLine}>
                            {next}
                        </Body>
                        {showProgress && entry.session.reviewedSteps.length > 0 ? (
                            <ProgressBar
                                label={`Steps done: ${entry.completedStepIds.length} of ${entry.session.reviewedSteps.length}`}
                                value={entry.completedStepIds.length}
                                total={entry.session.reviewedSteps.length}
                            />
                        ) : null}
                    </Stack>
                </View>
                <Icon name="chevronRight" color={colors.inkMuted} />
            </PressMotion>
        </Card>
    )
}
const styles = StyleSheet.create({
    content: {
        padding: space.md,
        gap: space.md,
    },
    centred: {
        flexGrow: 1,
        justifyContent: 'center',
    },
    fill: {
        flexGrow: 1,
    },
    group: {
        gap: space.md,
    },
    groupFill: {
        flexGrow: 1,
    },
    hero: {
        flex: 1,
        gap: space.md,
        alignItems: 'center',
        justifyContent: 'center',
        paddingVertical: space.xl,
    },
    emptyTitle: { fontSize: 22, lineHeight: 28, fontWeight: '600', textAlign: 'center' },
    emptyDetail: { fontSize: 15, lineHeight: 21, textAlign: 'center' },
    blueprint: { flex: 1, alignItems: 'center', justifyContent: 'center', width: '100%' },
    blueprintLarge: { flex: 0, width: 160, height: 144, borderRadius: 24, marginBottom: space.sm },
    preview: { gap: 0 },
    parts: { flexDirection: 'row', flexWrap: 'wrap', gap: space.xs },
    nextLine: { fontSize: 15, lineHeight: 21 },
    collapsing: {
        transformOrigin: 'left center',
    },
    summaryText: {
        flex: 1,
    },
    thumb: {
        width: 80,
        height: 80,
        borderRadius: 12,
        overflow: 'hidden',
    },
    row: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: space.sm,
        minHeight: touchTarget,
    },
})
