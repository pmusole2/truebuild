import type { ReactElement } from 'react'
import { StyleSheet, View } from 'react-native'
import {
    stepEvidenceRequirements,
    type ManualSession,
    type ParsedManual,
    type SourceRef,
    type PartRequirement,
} from '@truebuild/contracts'
import { Card, Stack } from '../../ui/surface'
import { Body, Caption, Label } from '../../ui/text'
import { MeasuredPane, type ComparisonFit, type ComparisonPane } from '../../ui/comparison'
import { space } from '../../theme/tokens'
import { stepPartChoices } from '../assembly/question-state'
import type { AssemblyGuide } from './camera-stage'
import type { WorkflowState } from './controller'
import { factText } from './fact-text'
import { StepDetails } from './step-details'
import { StepPicture } from './step-picture'
import { ManualImage } from './page-media'

export { factText } from './fact-text'

/**
 * What to show the camera: one line, in the step's own words. The first known visible check leads because it is what the
 * photo is judged against; a known orientation stands in when the step has no known check. Unknown facts are not turned
 * into a cue. Null means the camera falls back to a generic line; every fact stays in More.
 */
export function stepCue(session: ManualSession, index: number): string | undefined {
    const step = session.reviewedSteps[index]
    if (step === undefined) {
        return undefined
    }
    const check = step.visibleChecks[0]
    if (check?.description.state === 'known') {
        return check.description.value
    }
    return step.orientation.state === 'known' ? step.orientation.value.description : undefined
}

/**
 * The step guide shown over the assembly camera. One builder serves the production camera route and the inert visual
 * preview, so the preview cannot drift from what the app wires: only a one-line cue and a small picture sit over the
 * viewfinder, and every fact and cited diagram stays in More.
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
        cue: stepCue(session, index),
        thumbnail: (
            <StepPicture
                reference={step.sourceRefs[0]}
                session={session}
                pageUris={pageUris}
                height={56}
                testID="camera-step-picture"
            />
        ),
        instructions: (
            <>
                <StepDetails session={session} index={index} />
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
                <ManualImage uri={uri} label={`Expected diagram page ${pageNumber}`} />
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
