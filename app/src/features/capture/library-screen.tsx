import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import {
    ScrollView,
    StyleSheet,
    View,
    type LayoutChangeEvent,
    type NativeScrollEvent,
    type NativeSyntheticEvent,
} from 'react-native'
import Animated, { useAnimatedStyle, useSharedValue, type SharedValue } from 'react-native-reanimated'
import { useColdEntrance } from '../../ui/cold-start'
import { useEntranceGroup, useEntranceTimeline } from '../../ui/motion'
import { useCoachAttention, useCoachScope, useCoachScreen } from '../onboarding/coach-provider'
import { homeCandidates } from '../onboarding/coach-inventory'
import { ShowTipsAgainRow } from '../onboarding/tips-rows'
import { FixedBottomBar } from '../../ui/bottom-bar'
import { useFeedback } from '../../ui/feedback'
import { MoreSheet } from '../../ui/sheet'
import { Card, Stack } from '../../ui/surface'
import { Body, Caption, Heading, Instruction, LargeTitle } from '../../ui/text'
import { LoadingState } from '../../ui/states'
import { ProgressBar } from '../../ui/progress'
import { Icon } from '../../ui/icons'
import { focusRingStyle, useFocusRing } from '../../ui/focus'
import { PressMotion } from '../../ui/press-motion'
import { useTheme } from '../../theme/theme'
import { radius, space, touchTarget } from '../../theme/tokens'
import type { LibraryEntry } from './library'
import { AboutThisCheck, HowItWorks } from './more-sections'
import { plainNotice, progressLine, stopFor } from './plain-copy'
import { ManualImage } from './page-media'
import { PlainNotice, ScreenBody } from './screen-layout'
import { InlineHeader, useMoreState, type ChromeProps } from './screen-header'
import { defaultNav, type ScreenNav } from './screen-nav'
import { SettingsSections } from './settings-screen'
import type { WorkflowScreenProps } from './workflow-types'

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
    const [state, setState] = useState({ key: resetKey, collapsed: false })
    useEffect(() => {
        scrollY.value = 0
    }, [resetKey, scrollY])
    const onCollapsedChange = useCallback(
        (collapsed: boolean): void => setState({ key: resetKey, collapsed }),
        [resetKey],
    )
    return { scrollY, collapsed: state.key === resetKey && state.collapsed, onCollapsedChange }
}

/** Small title that appears in the header as the large one collapses. Android and previews. */
export function PinnedTitle({ scrollY, title }: { scrollY: SharedValue<number>; title: string }): ReactElement {
    const style = useAnimatedStyle(() => ({ opacity: collapseProgress(scrollY.value) }))
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
        return { opacity: 1 - progress, transform: [{ scale: reduceMotion ? 1 : 1 - progress * 0.2 }] }
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
}: {
    scrollY: SharedValue<number>
    distance: number
    onHeight: (height: number) => void
}): ReactElement {
    const { reduceMotion } = useFeedback()
    const style = useAnimatedStyle(() => {
        const progress = collapseProgress(scrollY.value, distance)
        return reduceMotion
            ? { opacity: 1 - progress, transform: [{ scale: 1 }] }
            : { opacity: 1 - progress, transform: [{ scale: 1 - progress * 0.2 }] }
    })
    return (
        <Animated.View
            testID="home-heading"
            style={[styles.collapsing, style]}
            onLayout={(event: LayoutChangeEvent): void => onHeight(Math.ceil(event.nativeEvent.layout.height))}
        >
            <LargeTitle>{HOME_HEADING}</LargeTitle>
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
        return 'Your builds are opening.'
    }
    if (state.storageReadOnly) {
        return 'Adding is paused until your saved builds open again.'
    }
    if (state.pending !== null) {
        return 'Wait for the current request to finish.'
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
const PRIMARY_COMPACT = { pages: 'Add', overview: 'Answer', guide: 'Resume', done: 'Open' } as const

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
    const hint = failed ? (state.pending === null ? null : 'Please wait') : addHint(state)
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
        ? { label: 'Add manual', compactLabel: 'Add', onPress: addManual, disabled: true }
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
            ? { label: 'Add manual', icon: 'plus' as const, onPress: addManual }
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
                    overlay && { paddingBottom: space.md + barHeight },
                ]}
                keyboardShouldPersistTaps="handled"
                contentInsetAdjustmentBehavior="automatic"
                scrollEventThrottle={16}
                onScroll={onScroll}
            >
                <Animated.View style={headingEntrance}>
                    {largeTitle === 'content' ? <CollapsingTitle scrollY={scrollY} title="TrueBuild" /> : null}
                    {overlay ? <HomeHeading scrollY={scrollY} distance={distance} onHeight={setHeadingHeight} /> : null}
                </Animated.View>
                <Animated.View style={[styles.group, empty && overlay && styles.groupFill, contentEntrance]}>
                    {state.storageReadOnly ? null : <PlainNotice state={state} controller={controller} />}
                    {state.loading ? (
                        <Card>
                            <LoadingState label="Getting your builds ready." shape="card" />
                        </Card>
                    ) : failed ? (
                        <Instruction>{recoveryCopy}</Instruction>
                    ) : empty ? (
                        <View style={[styles.hero, overlay && styles.heroCentred]}>
                            <Icon name="image" />
                            <Instruction>Build furniture with step-by-step help.</Instruction>
                        </View>
                    ) : null}
                    {sole === undefined ? null : (
                        <ContinueCard entry={sole} pageUris={state.pageUris} resumable={!state.storageReadOnly} />
                    )}
                    {entries.length > 1
                        ? entries.map((entry) => (
                              <ManualRow
                                  key={entry.session.manualId}
                                  entry={entry}
                                  pageUris={state.pageUris}
                                  onOpen={(): void => nav.openStop(entry)}
                              />
                          ))
                        : null}
                </Animated.View>
            </ScrollView>
            <FixedBottomBar
                primary={primary}
                secondary={secondary}
                reason={hint}
                placement={overlay ? 'overlay' : 'flow'}
                onHeight={overlay ? setBarHeight : undefined}
            />
            <MoreSheet visible={more.open} title="More" onClose={more.hide}>
                <HowItWorks />
                <SettingsSections state={state} />
                <ShowTipsAgainRow onClose={more.hide} />
                <AboutThisCheck />
            </MoreSheet>
        </ScreenBody>
    )
}

const THUMB_WIDTH = 64

/**
 * The first manual page, small and at its own proportions, when the page is already loaded. Nothing is read for it:
 * Home clears the loaded pages, and then the existing image icon stands in. Decorative, never a target.
 */
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
    const shown = page !== undefined && uri !== undefined
    return (
        <View
            testID="manual-thumb"
            accessibilityElementsHidden={true}
            importantForAccessibility="no-hide-descendants"
            style={[
                styles.thumb,
                { backgroundColor: colors.surfaceSunken },
                shown ? { aspectRatio: page.width / page.height } : styles.thumbFallback,
            ]}
        >
            {shown ? (
                <ManualImage uri={uri} label="First page of your manual" />
            ) : (
                <Icon name="image" color={colors.inkMuted} />
            )}
        </View>
    )
}

/** Where the one manual stands. A summary, not a button: "Keep building" below is the single way in. */
function ContinueCard({
    entry,
    pageUris,
    resumable,
}: {
    entry: LibraryEntry
    pageUris: LibraryProps['state']['pageUris']
    resumable: boolean
}): ReactElement {
    const total = entry.session.reviewedSteps.length
    const completed = entry.completedStepIds.length
    return (
        <Card tone="raised" testID="manual-card">
            <View style={styles.summary}>
                <ManualThumb entry={entry} pageUris={pageUris} />
                <View style={styles.summaryText}>
                    <Stack gap="xs">
                        <Heading>{entry.session.title}</Heading>
                        <Body>{progressLine(entry)}</Body>
                        {total === 0 ? null : (
                            <ProgressBar
                                label={`Steps done: ${completed} of ${total}`}
                                value={completed}
                                total={total}
                            />
                        )}
                        {resumable ? <Instruction>Pick up where you left off.</Instruction> : null}
                    </Stack>
                </View>
            </View>
        </Card>
    )
}

function ManualRow({
    entry,
    pageUris,
    onOpen,
}: {
    entry: LibraryEntry
    pageUris: LibraryProps['state']['pageUris']
    onOpen: () => void
}): ReactElement {
    const { colors } = useTheme()
    const focus = useFocusRing()
    return (
        <Card tone="raised" testID="manual-card">
            <PressMotion
                accessibilityRole="button"
                accessibilityLabel={`Open ${entry.session.title}`}
                {...focus.focusHandlers}
                onPress={onOpen}
                style={[styles.row, focusRingStyle(focus.focused, colors)]}
            >
                <ManualThumb entry={entry} pageUris={pageUris} />
                <View style={styles.summaryText}>
                    <Stack gap="xs">
                        <Heading>{entry.session.title}</Heading>
                        <Caption>{progressLine(entry)}</Caption>
                    </Stack>
                </View>
                <Icon name="chevronRight" color={colors.inkMuted} />
            </PressMotion>
        </Card>
    )
}

const styles = StyleSheet.create({
    content: { padding: space.md, gap: space.md },
    centred: { flexGrow: 1, justifyContent: 'center' },
    fill: { flexGrow: 1 },
    heroCentred: { flex: 1, justifyContent: 'center' },
    group: { gap: space.md },
    groupFill: { flexGrow: 1 },
    hero: { gap: space.sm, alignItems: 'flex-start' },
    collapsing: { transformOrigin: 'left center' },
    summary: { flexDirection: 'row', alignItems: 'flex-start', gap: space.sm },
    summaryText: { flex: 1 },
    thumb: { width: THUMB_WIDTH, borderRadius: radius.md, overflow: 'hidden' },
    thumbFallback: { height: THUMB_WIDTH, alignItems: 'center', justifyContent: 'center' },
    row: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: space.sm,
        minHeight: touchTarget,
    },
})
