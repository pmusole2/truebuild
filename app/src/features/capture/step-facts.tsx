import type { ReactElement } from 'react'
import { Image, StyleSheet, View } from 'react-native'
import type { Fact, ManualSession, ParsedManual, SourceRef } from '@truebuild/contracts'
import { Card, Stack } from '../../ui/surface'
import { Body, Caption, Heading, Label } from '../../ui/text'
import { MeasuredPane, type ComparisonPane } from '../../ui/comparison'
import { space } from '../../theme/tokens'
import { stepPartChoices } from '../assembly/question-state'
import type { WorkflowState } from './controller'

export function factText<T>(fact: Fact<T>, display: (value: T) => string): string {
    return fact.state === 'known' ? display(fact.value) : `Unknown: ${fact.reason}`
}

export function StepFacts({
    session,
    index,
    showHeading = true,
}: {
    session: ManualSession
    index: number
    // A review card already shows the step's order and title above the opened facts.
    showHeading?: boolean
}): ReactElement {
    const step = session.reviewedSteps[index]
    if (step === undefined) {
        return <Body tone="muted">No extracted steps yet.</Body>
    }
    return (
        <Stack gap="xs">
            {showHeading ? <Heading>{`${step.order}. ${step.title}`}</Heading> : null}
            {step.parts.map((part) => (
                <Body key={part.partId}>{`${part.partId}: ${factText(part.quantity, String)}`}</Body>
            ))}
            <Body>{`Orientation: ${factText(step.orientation, (value) => value.description)}`}</Body>
            <Body>{`Connection: ${factText(step.connection, (value) => value.description)}`}</Body>
            {step.visibleChecks.map((check) => (
                <Body key={check.checkId}>{`Visible check: ${factText(check.description, String)}`}</Body>
            ))}
            {step.correction?.actions.map((action) => (
                <Body key={action.actionId}>{`Correction: ${action.instruction}`}</Body>
            ))}
        </Stack>
    )
}

/**
 * The facts a builder needs while the guide is on screen: the parts this step uses with their quantities, and how they
 * are oriented. Unknown facts keep their stated reason. The full facts and diagrams stay in the instructions sheet.
 */
export function StepSummary({ session, index }: { session: ManualSession; index: number }): ReactElement | null {
    const step = session.reviewedSteps[index]
    if (step === undefined) {
        return null
    }
    const labels = new Map(stepPartChoices(session, step).map((choice) => [choice.partId, choice.label]))
    return (
        <Card tone="raised">
            <View style={styles.group}>
                <Label>Parts</Label>
                {step.parts.length === 0 ? <Body tone="muted">No parts listed for this step.</Body> : null}
                {step.parts.map((part) => {
                    const name = labels.get(part.partId) ?? part.partId
                    return (
                        <Body key={part.partId}>
                            {part.quantity.state === 'known'
                                ? `${part.quantity.value} × ${name}`
                                : `${name}: ${factText(part.quantity, String)}`}
                        </Body>
                    )
                })}
            </View>
            <View style={styles.group}>
                <Label>Orientation</Label>
                <Body>{factText(step.orientation, (value) => value.description)}</Body>
            </View>
        </Card>
    )
}

/** Server provenance only. Notes remain bounded plain text and never change a verdict or answer's meaning. */
export function ModelProvenance({ result }: { result: Pick<ParsedManual, 'model' | 'modelNotes'> }): ReactElement {
    return (
        <>
            {result.model === undefined ? null : <Caption>{`Model: ${result.model}`}</Caption>}
            {result.modelNotes?.slice(0, 10).map((note, index) => (
                <Caption key={index}>{`Model note: ${note.slice(0, 500)}`}</Caption>
            ))}
        </>
    )
}

/** Expected diagrams for cited pages. Highlights are measured against each page's own size, so letterboxing is correct. */
export function SourceDiagrams({
    refs,
    session,
    pageUris,
}: {
    refs: readonly SourceRef[]
    session: ManualSession
    pageUris: WorkflowState['pageUris']
}): ReactElement {
    return (
        <Stack gap="sm">
            {refs.map((ref, index) => {
                const page = session.pages.find((candidate) => candidate.pageId === ref.pageId)
                if (page === undefined) {
                    return <Caption key={index}>Cited diagram unavailable.</Caption>
                }
                const pageNumber = session.pages.indexOf(page) + 1
                const uri = pageUris[page.pageId]
                const pane: ComparisonPane = {
                    caption: `Expected diagram · page ${pageNumber}`,
                    media:
                        uri === undefined ? (
                            <Caption>Loading page…</Caption>
                        ) : (
                            <Image
                                source={{ uri }}
                                accessibilityLabel={`Expected diagram page ${pageNumber}`}
                                resizeMode="stretch"
                                style={StyleSheet.absoluteFill}
                            />
                        ),
                    mediaSize: { width: page.width, height: page.height },
                    regions:
                        ref.region === null ? [] : [{ id: `cited-${index}`, label: 'Cited area', box: ref.region }],
                }
                return (
                    <MeasuredPane
                        key={`${ref.pageId}-${index}`}
                        pane={pane}
                        testID={`diagram-${index}`}
                        sideBySide={false}
                    />
                )
            })}
        </Stack>
    )
}

const styles = StyleSheet.create({
    group: { gap: space.xs },
})
