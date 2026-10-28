import type { ReactElement } from 'react'
import { Image, StyleSheet, View } from 'react-native'
import type { CheckResult, ManualSession, QuestionResult } from '@truebuild/contracts'
import { boxOnDisplay, type Point, type Rect } from '../assembly/frame-geometry'
import { GroundedRegionOutline, PartRegionOverlays } from '../assembly/grounded-overlays'
import { Card } from '../../ui/surface'
import { Body, Caption, Heading } from '../../ui/text'
import { ComparisonFrame, type ComparisonPane } from '../../ui/comparison'
import { ResultSheet } from '../../ui/result-sheet'
import { ResultReveal } from '../../ui/result-reveal'
import type { WorkflowState } from './controller'
import { ManualImage } from './page-media'
import { groundedRegion } from './grounded-region'
import type { LibraryEntry } from './library'
import { guidanceNotes, type PartGuidance } from './part-regions'
import { ModelProvenance, SourceDiagrams } from './step-facts'

/** The verdict for a frozen check, exactly as the backend returned it. Refusals keep their reason and missing evidence. */
export function CheckPanel({
    check,
    session,
    pageUris,
    showSource = true,
}: {
    check: CheckResult
    session: ManualSession
    pageUris: WorkflowState['pageUris']
    // The guide shows the cited diagram as its own evidence block beside the photo, so the verdict card stays short.
    showSource?: boolean
}): ReactElement {
    return (
        <ResultReveal
            identity={`check:${check.decision}:${check.reason}`}
            feedback={check.decision === 'pass' ? 'success' : 'warning'}
        >
            <ResultSheet
                verdict={check.decision}
                reason={check.reason}
                missing={check.missingEvidence}
                citedPage={
                    check.decision === 'refuse' || !showSource ? undefined : (
                        <SourceDiagrams refs={check.sourceRefs} session={session} pageUris={pageUris} />
                    )
                }
            />
            <ModelProvenance result={check} />
            {check.secondOpinion === undefined || check.secondOpinion.status === 'available' ? null : (
                <Caption>{`Second opinion: ${check.secondOpinion.model} (${check.secondOpinion.status})`}</Caption>
            )}
        </ResultReveal>
    )
}

/**
 * A question answer. It is neutral: no pass, refuse or cannot-verify tag, because a question never verifies a step.
 * It is a polite live region, so assistive tech announces the answer when it arrives.
 */
export function AnswerPanel({
    answer,
    session,
    pageUris,
    showSource = true,
}: {
    answer: QuestionResult
    session: ManualSession
    pageUris: WorkflowState['pageUris']
    showSource?: boolean
}): ReactElement {
    return (
        <ResultReveal identity={`answer:${answer.answer}`} feedback="selection">
            <View accessibilityLiveRegion="polite">
                {/* Hero card like a verdict, but neutral: no verdict colour or tag. */}
                <Card tone="result">
                    <Heading>Answer</Heading>
                    <Caption>Answer to your question from the manual pages. It is not a step check.</Caption>
                    <Body>{answer.answer}</Body>
                    <ModelProvenance result={answer} />
                    {answer.missingEvidence.map((missing, index) => (
                        <Caption key={index}>{`Missing: ${missing}`}</Caption>
                    ))}
                    {showSource ? (
                        <SourceDiagrams refs={answer.sourceRefs} session={session} pageUris={pageUris} />
                    ) : null}
                </Card>
            </View>
        </ResultReveal>
    )
}

/**
 * A refusal shows the expected diagram and the frozen photo side by side, with the observed region measured on each.
 * The photo pane stays tappable, so a point can be chosen after a refusal without retaking the photo. Located next-part
 * and target regions are drawn on the photo pane only, through the pane's overlay, and are named in text beneath it.
 */
export function RefusalComparison({
    refusal,
    observation,
    entry,
    pageUris,
    onTapPoint,
    guidance,
    onViewDiagram,
}: {
    refusal: CheckResult
    observation: { uri: string; width: number; height: number }
    entry: LibraryEntry
    pageUris: WorkflowState['pageUris']
    onTapPoint: ((point: Point) => void) | undefined
    guidance?: PartGuidance | undefined
    // Opens the full-width diagram while the half-width comparison is shown.
    onViewDiagram?: () => void
}): ReactElement {
    const cited = refusal.sourceRefs[0]
    const page =
        cited === undefined ? undefined : entry.session.pages.find((candidate) => candidate.pageId === cited.pageId)
    const diagramUri = page === undefined ? undefined : pageUris[page.pageId]
    const diagram: ComparisonPane = {
        caption: 'Manual diagram',
        media:
            diagramUri === undefined ? (
                <Caption>Cited diagram unavailable.</Caption>
            ) : (
                <ManualImage uri={diagramUri} label="Cited manual page" />
            ),
        mediaSize: page === undefined ? { width: 1, height: 1 } : { width: page.width, height: page.height },
        regions: cited?.region ? [{ id: 'cited', label: 'Cited area', box: cited.region }] : [],
    }
    const photo: ComparisonPane = {
        caption: 'Your photo',
        media: (
            <Image
                source={{ uri: observation.uri }}
                accessibilityLabel="Your photo of this step"
                resizeMode="stretch"
                style={StyleSheet.absoluteFill}
            />
        ),
        mediaSize: { width: observation.width, height: observation.height },
        regions: refusal.observedRegion
            ? [{ id: 'observed', label: 'Observed part', box: refusal.observedRegion }]
            : [],
        onTapPoint,
        overlay:
            guidance === undefined || (guidance.next === null && guidance.target === null)
                ? undefined
                : (displayed): ReactElement => <PartGuidanceOverlay guidance={guidance} displayed={displayed} />,
        notes: guidance === undefined ? undefined : guidanceNotes(guidance),
    }
    return <ComparisonFrame diagram={diagram} photo={photo} onViewDiagram={onViewDiagram} />
}

/**
 * Pulse identity for a grounded pass: tied to its capture and the exact returned region, so notes or other metadata
 * never replay it. Only a pass that actually returned a region is keyed; a pass without one never invents a region.
 */
export function passPulseKey(check: CheckResult, captureId: string): string | null {
    const region = check.decision === 'pass' ? groundedRegion(check) : null
    return region === null ? null : `pass:${captureId}:${region.x}:${region.y}:${region.width}:${region.height}`
}

/** The grounded region, drawn as an SVG child because FrozenPhoto places its overlay inside an Svg. */
export function CheckHighlight({
    rect,
    pulseKey = null,
}: {
    rect: { x: number; y: number; width: number; height: number } | null
    pulseKey?: string | null
}): ReactElement {
    return <GroundedRegionOutline rect={rect} pulseKey={pulseKey} />
}

/** Next part, target and the paired arrow, placed on the displayed photo rect. Draws only what `guidance` carries. */
export function PartGuidanceOverlay({
    guidance,
    displayed,
}: {
    guidance: PartGuidance
    displayed: Rect
}): ReactElement {
    return (
        <PartRegionOverlays
            next={guidance.next === null ? null : boxOnDisplay(guidance.next.box, displayed)}
            target={guidance.target === null ? null : boxOnDisplay(guidance.target.box, displayed)}
            arrow={guidance.arrow}
        />
    )
}
