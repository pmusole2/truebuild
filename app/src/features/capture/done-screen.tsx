import type { ReactElement } from 'react'
import { StyleSheet, View } from 'react-native'
import Animated from 'react-native-reanimated'
import { FixedBottomBar } from '../../ui/bottom-bar'
import { MoreSheet } from '../../ui/sheet'
import { Stack } from '../../ui/surface'
import { StepList, type StepListItem } from '../../ui/progress'
import { useCoachAttention, useCoachScope } from '../onboarding/coach-provider'
import { useLoadEntrance } from '../../ui/motion'
import { Instruction } from '../../ui/text'
import { space } from '../../theme/tokens'
import type { LibraryEntry } from './library'
import { ScreenBody, TextRegion, useHeroHeight } from './screen-layout'
import { InlineHeader, useMoreState, type ChromeProps } from './screen-header'
import { defaultNav, type ScreenNav } from './screen-nav'
import { StepPicture } from './step-picture'
import type { WorkflowScreenProps } from './workflow-types'
import { ComposedHero, composeBar, GeneratedBody, MoreIntro, ScreenPending } from '../screens/host'
import type { ScreenSlot } from '../screens/use-screen-slot'

type DoneProps = WorkflowScreenProps &
    ChromeProps & {
        entry: LibraryEntry
        readonly nav?: ScreenNav
        // The model-composed screen and More intro, or undefined for the native ones.
        readonly slot?: ScreenSlot
        readonly moreSlot?: ScreenSlot
    }

/**
 * Done: calm and truthful. Marked-complete steps are the person's own record and do not prove any check, so the screen
 * claims only that the steps were finished.
 */
export function DoneScreen({
    state,
    controller,
    entry,
    nav: navProp,
    chrome = 'inline',
    more: moreProp,
    slot,
    moreSlot,
}: DoneProps): ReactElement {
    const { session } = entry
    const nav = navProp ?? defaultNav(controller)
    const internalMore = useMoreState()
    const more = moreProp ?? internalMore
    const heroHeight = useHeroHeight()
    const last = session.reviewedSteps[session.reviewedSteps.length - 1]
    // The arrival replaces the guide; the picture and sentence settle once, the bar is present from the first frame.
    const scope = useCoachScope()
    const attention = useCoachAttention()
    const entrance = useLoadEntrance(scope.active && !attention && !more.open && state.pending === null)
    const composed = slot?.status === 'ready' ? slot.screen : null
    const items: StepListItem[] = session.reviewedSteps.map((step) => ({
        id: step.stepId,
        title: step.title,
        state: entry.completedStepIds.includes(step.stepId) ? 'done' : 'upcoming',
    }))
    return (
        <ScreenBody testID="done-screen">
            {chrome === 'inline' ? <InlineHeader title="Done" more={more} /> : null}
            <Animated.View style={[styles.flex, entrance]}>
                {composed !== null ? (
                    <ComposedHero screen={composed} />
                ) : (
                    <View style={styles.hero}>
                        <StepPicture
                            reference={last?.sourceRefs[0]}
                            references={session.reviewedSteps.flatMap((item) => item.sourceRefs)}
                            session={session}
                            pageUris={state.pageUris}
                            height={heroHeight}
                            testID="done-hero"
                            cover
                        />
                    </View>
                )}
                <TextRegion>
                    {composed !== null ? (
                        <GeneratedBody screen={composed} enabled={state.pending === null && !more.open} pinned />
                    ) : slot?.status === 'pending' ? (
                        <ScreenPending />
                    ) : (
                        <Instruction>You finished every step. Nice work.</Instruction>
                    )}
                </TextRegion>
            </Animated.View>
            <FixedBottomBar
                {...composeBar(
                    {
                        primary: {
                            label: 'Back to Home',
                            compactLabel: 'Home',
                            testID: 'done-home',
                            onPress: nav.leave,
                        },
                    },
                    slot,
                )}
            />
            <MoreSheet
                visible={more.open}
                title="All steps"
                compactTitle="Steps"
                onClose={more.hide}
                detents={['tall', 'full']}
            >
                <Stack gap="md">
                    <MoreIntro slot={moreSlot} />
                    <StepList steps={items} />
                </Stack>
            </MoreSheet>
        </ScreenBody>
    )
}

const styles = StyleSheet.create({
    flex: { flex: 1, minHeight: 0 },
    hero: { paddingHorizontal: space.md, paddingTop: space.xs },
})
