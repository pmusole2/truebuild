import { useState, type ReactElement } from 'react'
import { ScrollView, StyleSheet, useWindowDimensions, View } from 'react-native'
import { Stack as RouterStack } from 'expo-router'
import type { LibraryEntry } from '../capture/library'
import { useWorkflowActions } from '../capture/native-routes'
import { useMoreState } from '../capture/screen-header'
import { useWorkflow } from '../capture/workflow-context'
import { AppButton } from '../../ui/button'
import { Card, Stack } from '../../ui/surface'
import { Body, Caption, Heading } from '../../ui/text'
import { space } from '../../theme/tokens'
import { ScreenBlocks } from './blocks'
import { ScreenPending } from './host'
import { useJudge } from './judge-context'
import { MandatoryFacts } from './mandatory'
import { sessionForScreens } from './screen-spec'
import { useScreenSlot, type ScreenSlot } from './use-screen-slot'

/** Two panes sit side by side from this width; narrower, they stack and the page scrolls. */
export const SIDE_BY_SIDE_WIDTH = 720

/** A manual can be composed when it has been read and its facts confirmed; nothing is confirmed on its behalf here. */
export function comparable(entry: LibraryEntry): boolean {
    return entry.session.reviewStatus === 'reviewed' && entry.session.reviewedSteps.length > 0
}

function paneNote(slot: ScreenSlot | undefined): string {
    if (slot === undefined) return 'Generated screens are off in this build.'
    switch (slot.status) {
        case 'pending':
            return 'Composing…'
        case 'native':
            return `Shown by the app instead (${slot.reason}${slot.code === null ? '' : `, ${slot.code}`}).`
        case 'ready': {
            const { metadata } = slot.screen.document
            if (metadata.evidence === 'synthetic-fixture') {
                return metadata.source === 'generated'
                    ? 'Simulated composition (generated source) · no model call'
                    : 'Built by the app from the manual · simulated, no model call'
            }
            const who =
                metadata.source === 'generated'
                    ? `Composed by ${metadata.model ?? 'the model'}${metadata.effort === null ? '' : ` at ${metadata.effort} effort`}`
                    : `Built by the app from the manual${metadata.fallbackReason === null ? '' : ` (${metadata.fallbackReason})`}`
            return who
        }
    }
}

/**
 * One manual's guide page, composed from its own facts and drawn by the same renderer as the real Guide. The step is the
 * manual's first, so both panes show the same position and any difference is the composition, not the content.
 */
export function ComparePane({ entry }: { readonly entry: LibraryEntry }): ReactElement {
    const { state } = useWorkflow()
    const { controller, nav } = useWorkflowActions()
    const more = useMoreState()
    const step = entry.session.reviewedSteps[0]
    const slot = useScreenSlot({
        kind: 'guide',
        spec:
            step === undefined
                ? null
                : {
                      kind: 'guide',
                      session: sessionForScreens(entry.session),
                      stepId: step.stepId,
                      captureId: null,
                      result: null,
                      failure: null,
                  },
        facts: {},
        state,
        entry,
        controller,
        nav,
        extras: { showMore: more.show },
        more,
        heroMode: 'inline',
        whilePending: 'skeleton',
        capture: null,
        readOnly: true,
    })
    return (
        <Card testID={`compare-pane-${entry.session.manualId}`} tone="raised">
            <Stack gap="sm">
                <Heading>{entry.session.title}</Heading>
                <Caption>{paneNote(slot)}</Caption>
                {slot?.status === 'pending' ? <ScreenPending /> : null}
                {slot?.status === 'ready' ? (
                    <>
                        <Body>{slot.screen.title}</Body>
                        <ScreenBlocks
                            nodes={slot.screen.guarded.body}
                            paths={slot.screen.guarded.paths}
                            context={slot.screen.context}
                        />
                        <Caption>{`Main button: ${slot.screen.bar.primary.label}${slot.screen.bar.secondary === undefined ? '' : ` · Second: ${slot.screen.bar.secondary.label}`}`}</Caption>
                    </>
                ) : null}
                <MandatoryFacts session={entry.session} stepId={step?.stepId ?? null} slot={slot} />
            </Stack>
        </Card>
    )
}

function Choice({
    entry,
    chosen,
    onPress,
}: {
    readonly entry: LibraryEntry
    readonly chosen: boolean
    readonly onPress: () => void
}): ReactElement {
    const ok = comparable(entry)
    return (
        <AppButton
            testID={`compare-choose-${entry.session.manualId}`}
            label={ok ? entry.session.title : `${entry.session.title} (finish Quick check first)`}
            accessibilityLabel={`${entry.session.title}${chosen ? ', chosen' : ''}${ok ? '' : ', not ready: finish Quick check first'}`}
            variant={chosen ? 'accent' : 'secondary'}
            disabled={!ok}
            onPress={onPress}
        />
    )
}

/**
 * Judge-only: pick any two manuals from the library and see each one's guide composed by the same renderer. This is the
 * product path with real library sessions; it fabricates nothing and changes nothing in either manual.
 */
export function CompareScreen(): ReactElement {
    const { showBuilt } = useJudge()
    return showBuilt ? <EnabledCompareScreen /> : <Body>Turn on the judge view in More to compare manuals.</Body>
}

function EnabledCompareScreen(): ReactElement {
    const { state, screens } = useWorkflow()
    const { width } = useWindowDimensions()
    const [chosen, setChosen] = useState<readonly string[]>([])
    const toggle = (manualId: string): void =>
        setChosen((current) =>
            current.includes(manualId) ? current.filter((id) => id !== manualId) : [...current, manualId].slice(-2),
        )
    const panes = chosen.flatMap((id) => state.entries.filter((entry) => entry.session.manualId === id))
    return (
        <>
            <RouterStack.Screen options={{ title: 'Compare two manuals' }} />
            <ScrollView testID="compare-screen" contentContainerStyle={styles.content}>
                <Body>Pick any two manuals. Each one's guide is composed from its own facts, side by side.</Body>
                {screens === null ? (
                    <Caption>Generated screens are off in this build, so there is nothing to compose.</Caption>
                ) : null}
                {state.entries.length < 2 ? (
                    <Caption>Read and confirm two manuals first.</Caption>
                ) : (
                    <Stack gap="xs">
                        {state.entries.map((entry) => (
                            <Choice
                                key={entry.session.manualId}
                                entry={entry}
                                chosen={chosen.includes(entry.session.manualId)}
                                onPress={(): void => toggle(entry.session.manualId)}
                            />
                        ))}
                    </Stack>
                )}
                <View
                    testID="compare-panes"
                    style={[styles.panes, width >= SIDE_BY_SIDE_WIDTH ? styles.row : styles.column]}
                >
                    {panes.map((entry) => (
                        <View
                            key={entry.session.manualId}
                            style={width >= SIDE_BY_SIDE_WIDTH ? styles.pane : undefined}
                        >
                            <ComparePane entry={entry} />
                        </View>
                    ))}
                </View>
            </ScrollView>
        </>
    )
}

const styles = StyleSheet.create({
    content: { padding: space.md, gap: space.md },
    panes: { gap: space.md },
    row: { flexDirection: 'row' },
    column: { flexDirection: 'column' },
    pane: { flex: 1 },
})
