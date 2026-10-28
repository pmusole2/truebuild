import type { ReactElement } from 'react'
import { StyleSheet, View } from 'react-native'
import { FixedBottomBar } from '../../ui/bottom-bar'
import { MoreSheet } from '../../ui/sheet'
import { Stack } from '../../ui/surface'
import { StepList, type StepListItem } from '../../ui/progress'
import { Instruction } from '../../ui/text'
import { space } from '../../theme/tokens'
import type { LibraryEntry } from './library'
import { ScreenBody, TextRegion, useHeroHeight } from './screen-layout'
import { InlineHeader, useMoreState, type ChromeProps } from './screen-header'
import { defaultNav, type ScreenNav } from './screen-nav'
import { StepPicture } from './step-picture'
import type { WorkflowScreenProps } from './workflow-types'

type DoneProps = WorkflowScreenProps & ChromeProps & { entry: LibraryEntry; readonly nav?: ScreenNav }

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
}: DoneProps): ReactElement {
    const { session } = entry
    const nav = navProp ?? defaultNav(controller)
    const internalMore = useMoreState()
    const more = moreProp ?? internalMore
    const heroHeight = useHeroHeight()
    const last = session.reviewedSteps[session.reviewedSteps.length - 1]
    const items: StepListItem[] = session.reviewedSteps.map((step) => ({
        id: step.stepId,
        title: step.title,
        state: entry.completedStepIds.includes(step.stepId) ? 'done' : 'upcoming',
    }))
    return (
        <ScreenBody testID="done-screen">
            {chrome === 'inline' ? <InlineHeader title="Done" more={more} /> : null}
            <View style={styles.hero}>
                <StepPicture
                    reference={last?.sourceRefs[0]}
                    session={session}
                    pageUris={state.pageUris}
                    height={heroHeight}
                    testID="done-hero"
                />
            </View>
            <TextRegion>
                <Instruction>You finished every step. Nice work.</Instruction>
            </TextRegion>
            <FixedBottomBar
                primary={{ label: 'Back to Home', compactLabel: 'Home', testID: 'done-home', onPress: nav.leave }}
            />
            <MoreSheet
                visible={more.open}
                title="All steps"
                compactTitle="Steps"
                onClose={more.hide}
                detents={['tall', 'full']}
            >
                <Stack gap="md">
                    <StepList steps={items} />
                </Stack>
            </MoreSheet>
        </ScreenBody>
    )
}

const styles = StyleSheet.create({ hero: { paddingHorizontal: space.md, paddingTop: space.xs } })
