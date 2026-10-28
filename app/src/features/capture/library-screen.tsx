import type { ReactElement } from 'react'
import {
    Pressable,
    ScrollView,
    StyleSheet,
    View,
    type NativeScrollEvent,
    type NativeSyntheticEvent,
} from 'react-native'
import Animated, { useAnimatedStyle, useSharedValue, type SharedValue } from 'react-native-reanimated'
import { FixedBottomBar } from '../../ui/bottom-bar'
import { MoreSheet } from '../../ui/sheet'
import { Card, Stack } from '../../ui/surface'
import { Body, Caption, Heading, Instruction, LargeTitle } from '../../ui/text'
import { LoadingState } from '../../ui/states'
import { ProgressBar } from '../../ui/progress'
import { Icon } from '../../ui/icons'
import { focusRingStyle, useFocusRing } from '../../ui/focus'
import { useTheme } from '../../theme/theme'
import { space, touchTarget } from '../../theme/tokens'
import type { LibraryEntry } from './library'
import { AboutThisCheck, HowItWorks } from './more-sections'
import { progressLine, stopFor } from './plain-copy'
import { PlainNotice, ScreenBody } from './screen-layout'
import { InlineHeader, useMoreState, type ChromeProps } from './screen-header'
import { defaultNav, type ScreenNav } from './screen-nav'
import { SettingsSections } from './settings-screen'
import type { WorkflowScreenProps } from './workflow-types'

/** Distance the large title takes to collapse into the small header title. */
export const COLLAPSE_DISTANCE = 56

/** 0 at rest, 1 once the large title has scrolled away. Pure so the header and the title share one rule. */
export function collapseProgress(offset: number): number {
    'worklet'
    return Math.max(0, Math.min(1, offset / COLLAPSE_DISTANCE))
}

/** Small title that appears in the header as the large one collapses. Android and previews; iOS uses its native title. */
export function PinnedTitle({ scrollY, title }: { scrollY: SharedValue<number>; title: string }): ReactElement {
    const style = useAnimatedStyle(() => ({ opacity: collapseProgress(scrollY.value) }))
    return (
        <Animated.View testID="pinned-title" style={style}>
            <Heading numberOfLines={1}>{title}</Heading>
        </Animated.View>
    )
}

function CollapsingTitle({ scrollY, title }: { scrollY: SharedValue<number>; title: string }): ReactElement {
    const style = useAnimatedStyle(() => {
        const progress = collapseProgress(scrollY.value)
        return { opacity: 1 - progress, transform: [{ scale: 1 - progress * 0.2 }] }
    })
    return (
        <Animated.View testID="collapsing-title" style={[styles.collapsing, style]}>
            <LargeTitle>{title}</LargeTitle>
        </Animated.View>
    )
}

type LibraryProps = WorkflowScreenProps &
    ChromeProps & {
        readonly nav?: ScreenNav
        // 'content' draws the large title inside the scroll (Android, previews); 'native' leaves it to the iOS header.
        readonly largeTitle?: 'content' | 'native'
        readonly scrollY?: SharedValue<number>
    }

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

export function LibraryScreen({
    state,
    controller,
    nav: navProp,
    chrome = 'inline',
    more: moreProp,
    largeTitle = chrome === 'inline' ? 'content' : 'native',
    scrollY: scrollYProp,
}: LibraryProps): ReactElement {
    const internalMore = useMoreState()
    const more = moreProp ?? internalMore
    const ownScroll = useSharedValue(0)
    const scrollY = scrollYProp ?? ownScroll
    const nav = navProp ?? defaultNav(controller)
    const addDisabled = state.loading || state.pending !== null || state.storageReadOnly
    const hint = addHint(state)
    const failed = !state.loading && state.storageReadOnly && state.entries.length === 0
    const empty = !state.loading && !state.storageReadOnly && state.entries.length === 0
    // Most recently touched first; the first one is where "keep building" goes.
    const entries = [...state.entries].sort((a, b) => b.session.updatedAt.localeCompare(a.session.updatedAt))
    const sole = entries.length === 1 ? entries[0] : undefined
    const addManual = (): void => {
        void controller.createManual()
    }
    const onScroll = (event: NativeSyntheticEvent<NativeScrollEvent>): void => {
        scrollY.value = event.nativeEvent.contentOffset.y
    }
    const primary = state.loading
        ? { label: 'Add manual', onPress: addManual, disabled: true }
        : failed
          ? {
                label: 'Try again',
                testID: 'retry-library',
                onPress: (): void => {
                    void controller.restore()
                },
            }
          : sole !== undefined && !addDisabled
            ? {
                  label: PRIMARY_LABEL[stopFor(sole)],
                  testID: 'keep-building',
                  onPress: (): void => nav.openStop(sole),
              }
            : { label: 'Add manual', icon: 'plus' as const, onPress: addManual, disabled: addDisabled }
    const secondary = empty
        ? { label: 'How it works', onPress: (): void => more.show() }
        : sole !== undefined && !addDisabled
          ? { label: 'Add manual', onPress: addManual }
          : undefined
    return (
        <ScreenBody testID="library-screen">
            {chrome === 'inline' ? <InlineHeader title="Your builds" more={more} /> : null}
            {/* The scroll view is the first child so the iOS large title collapses with it. */}
            <ScrollView
                testID="library-scroll"
                contentContainerStyle={[styles.content, empty && styles.centred]}
                keyboardShouldPersistTaps="handled"
                contentInsetAdjustmentBehavior="automatic"
                scrollEventThrottle={16}
                onScroll={onScroll}
            >
                {largeTitle === 'content' ? <CollapsingTitle scrollY={scrollY} title="TrueBuild" /> : null}
                <PlainNotice state={state} controller={controller} />
                {state.loading ? (
                    <Card>
                        <LoadingState label="Getting your builds ready." shape="card" />
                    </Card>
                ) : failed ? (
                    <Instruction>We could not open your saved builds. Your photos are still on this phone.</Instruction>
                ) : empty ? (
                    <View style={styles.hero}>
                        <Icon name="image" />
                        <Instruction>Build furniture with step-by-step help.</Instruction>
                    </View>
                ) : null}
                {sole === undefined ? null : <ContinueCard entry={sole} onOpen={(): void => nav.openStop(sole)} />}
                {entries.length > 1
                    ? entries.map((entry) => (
                          <ManualRow
                              key={entry.session.manualId}
                              entry={entry}
                              onOpen={(): void => nav.openStop(entry)}
                          />
                      ))
                    : null}
            </ScrollView>
            <FixedBottomBar primary={primary} secondary={secondary} reason={hint} />
            <MoreSheet visible={more.open} title="More" onClose={more.hide}>
                <HowItWorks />
                <SettingsSections state={state} />
                <AboutThisCheck />
            </MoreSheet>
        </ScreenBody>
    )
}

function ContinueCard({ entry, onOpen }: { entry: LibraryEntry; onOpen: () => void }): ReactElement {
    const { colors } = useTheme()
    const focus = useFocusRing()
    const total = entry.session.reviewedSteps.length
    const completed = entry.completedStepIds.length
    return (
        <Card tone="raised" testID="manual-card">
            <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Open ${entry.session.title}`}
                {...focus.focusHandlers}
                onPress={onOpen}
                style={[styles.press, focusRingStyle(focus.focused, colors)]}
            >
                <Heading>{entry.session.title}</Heading>
                <Body>{progressLine(entry)}</Body>
                {total === 0 ? null : (
                    <ProgressBar label={`Steps done: ${completed} of ${total}`} value={completed} total={total} />
                )}
                <Instruction>Pick up where you left off.</Instruction>
            </Pressable>
        </Card>
    )
}

function ManualRow({ entry, onOpen }: { entry: LibraryEntry; onOpen: () => void }): ReactElement {
    const { colors } = useTheme()
    const focus = useFocusRing()
    return (
        <Card tone="raised" testID="manual-card">
            <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Open ${entry.session.title}`}
                {...focus.focusHandlers}
                onPress={onOpen}
                style={[styles.row, focusRingStyle(focus.focused, colors)]}
            >
                <Stack gap="xs">
                    <Heading>{entry.session.title}</Heading>
                    <Caption>{progressLine(entry)}</Caption>
                </Stack>
                <Icon name="chevronRight" color={colors.inkMuted} />
            </Pressable>
        </Card>
    )
}

const styles = StyleSheet.create({
    content: { padding: space.md, gap: space.md },
    centred: { flexGrow: 1, justifyContent: 'center' },
    hero: { gap: space.sm, alignItems: 'flex-start' },
    collapsing: { transformOrigin: 'left center' },
    press: { gap: space.xs, minHeight: touchTarget },
    row: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: space.sm,
        minHeight: touchTarget,
    },
})
