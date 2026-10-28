import type { ReactElement } from 'react'
import { Image, StyleSheet, View } from 'react-native'
import {
    stepEvidenceRequirements,
    type Fact,
    type ManualSession,
    type ParsedManual,
    type SourceRef,
    type PartRequirement,
} from '@truebuild/contracts'
import { Card, Stack } from '../../ui/surface'
import { Body, Callout, Caption, Heading, Label } from '../../ui/text'
import { MeasuredPane, type ComparisonFit, type ComparisonPane } from '../../ui/comparison'
import { space } from '../../theme/tokens'
import { stepPartChoices } from '../assembly/question-state'
import type { AssemblyGuide } from './camera-stage'
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
    const required = stepEvidenceRequirements(step)
    return (
        <Stack gap="xs">
            {showHeading ? <Heading>{`${step.order}. ${step.title}`}</Heading> : null}
            {step.parts.map((part) => (
                <View key={part.partId}>
                    <Body>{`${part.partId}: ${quantityText(part, session)}`}</Body>
                    {part.quantityBasis == null ? null : (
                        <CitationLabels refs={part.quantityBasis.sourceRefs} session={session} label="Quantity basis" />
                    )}
                </View>
            ))}
            {required.orientation || step.orientation.state === 'known' ? (
                <Body>{`Orientation: ${factText(step.orientation, (value) => value.description)}`}</Body>
            ) : null}
            {required.connection || step.connection.state === 'known' ? (
                <Body>{`Connection: ${factText(step.connection, (value) => value.description)}`}</Body>
            ) : null}
            {step.alternatives?.map((alternative) => (
                <View key={alternative.alternativeId}>
                    <Body>{`${alternative.alternativeId === step.selectedAlternativeId ? 'Chosen path' : 'Other path'}: ${alternative.title} — ${alternative.description}`}</Body>
                    <CitationLabels refs={alternative.sourceRefs} session={session} label="Alternative" />
                </View>
            ))}
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
 * What to look for while the camera is open: one cue, in the step's own words. The first visible check leads because it
 * is what the photo is judged against; the orientation stands in when the step has no known check. Unknown facts keep
 * their stated reason, the line is bounded to two lines, and every fact stays in the full instructions.
 */
export function StepGlance({ session, index }: { session: ManualSession; index: number }): ReactElement | null {
    const step = session.reviewedSteps[index]
    if (step === undefined) {
        return null
    }
    const required = stepEvidenceRequirements(step)
    const firstCheck = step.visibleChecks[0]
    const orientation =
        required.orientation || step.orientation.state === 'known'
            ? `Orientation: ${factText(step.orientation, (value) => value.description)}`
            : undefined
    const check = firstCheck === undefined ? undefined : `Visible check: ${factText(firstCheck.description, String)}`
    const cue = firstCheck?.description.state === 'known' ? check : (orientation ?? check)
    return cue === undefined ? null : <Callout numberOfLines={2}>{cue}</Callout>
}

/**
 * The step guide shown over the assembly camera. One builder serves the production camera route and the inert visual
 * preview, so the preview cannot drift from what the app wires: only the cue to look for sits over the viewfinder, and
 * every fact and cited diagram stays in the sheet.
 */
export function stepAssemblyGuide(
    session: ManualSession,
    index: number,
    pageUris: WorkflowState['pageUris'],
): AssemblyGuide | undefined {
    const step = session.reviewedSteps[index]
    if (step === undefined) {
        return undefined
    }
    return {
        progress: `Step ${index + 1} of ${session.reviewedSteps.length}`,
        title: step.title,
        summary: <StepGlance session={session} index={index} />,
        instructions: (
            <>
                <StepFacts session={session} index={index} />
                <SourceDiagrams refs={step.sourceRefs} session={session} pageUris={pageUris} fit="page" />
            </>
        ),
    }
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
    const required = stepEvidenceRequirements(step)
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
                                : `${name}: ${quantityText(part)}`}
                        </Body>
                    )
                })}
            </View>
            {required.orientation || step.orientation.state === 'known' ? (
                <View style={styles.group}>
                    <Label>Orientation</Label>
                    <Body>{factText(step.orientation, (value) => value.description)}</Body>
                </View>
            ) : null}
        </Card>
    )
}

function quantityText(part: PartRequirement, session?: ManualSession): string {
    if (part.quantityBasis?.kind === 'carried_over' && part.quantity.state === 'known') {
        const earlier = session?.reviewedSteps.find((step) => step.stepId === part.quantityBasis?.stepId)
        const label = earlier?.order ?? part.quantityBasis.stepId
        return `${part.quantity.value} (carried over from step ${label})`
    }
    if (part.quantity.state === 'known' || part.quantityBasis == null) {
        return factText(part.quantity, String)
    }
    return `Quantity basis: ${part.quantityBasis.kind === 'user_supplied' ? 'supplied by you' : 'not specified by the manual'}`
}

function CitationLabels({
    refs,
    session,
    label,
}: {
    refs: readonly SourceRef[]
    session: ManualSession
    label: string
}): ReactElement {
    return (
        <>
            {refs.map((ref, index) => (
                <Caption
                    key={index}
                >{`${label} cited page ${session.pages.findIndex((page) => page.pageId === ref.pageId) + 1}`}</Caption>
            ))}
        </>
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

/** One expected diagram for a cited page, measured against the page's own size so letterboxing is correct. */
export function SourceDiagram({
    reference,
    index,
    session,
    pageUris,
    sideBySide = false,
    fit = 'frame',
}: {
    reference: SourceRef
    // Position in the cited list. It names the pane (diagram-0, diagram-1) wherever the pane is drawn.
    index: number
    session: ManualSession
    pageUris: WorkflowState['pageUris']
    sideBySide?: boolean
    fit?: ComparisonFit
}): ReactElement {
    const page = session.pages.find((candidate) => candidate.pageId === reference.pageId)
    if (page === undefined) {
        return <Caption>Cited diagram unavailable.</Caption>
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
            reference.region === null ? [] : [{ id: `cited-${index}`, label: 'Cited area', box: reference.region }],
    }
    return <MeasuredPane pane={pane} testID={`diagram-${index}`} sideBySide={sideBySide} fit={fit} />
}

/**
 * Expected diagrams for cited pages. `skip` leaves out the first pages when the guide has already drawn them beside the
 * photo; the remaining panes keep the index they have in the full list.
 */
export function SourceDiagrams({
    refs,
    session,
    pageUris,
    skip = 0,
    fit = 'frame',
}: {
    refs: readonly SourceRef[]
    session: ManualSession
    pageUris: WorkflowState['pageUris']
    skip?: number
    fit?: ComparisonFit
}): ReactElement {
    return (
        <Stack gap="sm">
            {refs.map((reference, index) =>
                index < skip ? null : (
                    <SourceDiagram
                        key={`${reference.pageId}-${index}`}
                        reference={reference}
                        index={index}
                        session={session}
                        pageUris={pageUris}
                        fit={fit}
                    />
                ),
            )}
        </Stack>
    )
}

const styles = StyleSheet.create({
    group: { gap: space.xs },
})
