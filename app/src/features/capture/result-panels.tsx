import type { ReactElement } from 'react'
import { Image, StyleSheet, View } from 'react-native'
import { Rect } from 'react-native-svg'
import type { CheckResult, ManualSession, QuestionResult } from '@truebuild/contracts'
import type { Point } from '../assembly/frame-geometry'
import { Card } from '../../ui/surface'
import { Body, Caption, Heading } from '../../ui/text'
import { ComparisonFrame, type ComparisonPane } from '../../ui/comparison'
import { ResultSheet } from '../../ui/result-sheet'
import { ResultReveal } from '../../ui/result-reveal'
import { useTheme } from '../../theme/theme'
import { radius } from '../../theme/tokens'
import type { WorkflowState } from './controller'
import type { LibraryEntry } from './library'
import { ModelProvenance, SourceDiagrams } from './step-facts'

/** The verdict for a frozen check, exactly as the backend returned it. Refusals keep their reason and missing evidence. */
export function CheckPanel({
    check,
    session,
    pageUris,
}: {
    check: CheckResult
    session: ManualSession
    pageUris: WorkflowState['pageUris']
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
                    check.decision === 'refuse' ? undefined : (
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
}: {
    answer: QuestionResult
    session: ManualSession
    pageUris: WorkflowState['pageUris']
}): ReactElement {
    return (
        <ResultReveal identity={`answer:${answer.answer}`} feedback="selection">
            <View accessibilityLiveRegion="polite">
                <Card>
                    <Heading>Answer</Heading>
                    <Caption>Answer to your question from the manual pages. It is not a step check.</Caption>
                    <Body>{answer.answer}</Body>
                    <ModelProvenance result={answer} />
                    {answer.missingEvidence.map((missing, index) => (
                        <Caption key={index}>{`Missing: ${missing}`}</Caption>
                    ))}
                    <SourceDiagrams refs={answer.sourceRefs} session={session} pageUris={pageUris} />
                </Card>
            </View>
        </ResultReveal>
    )
}

/**
 * A refusal shows the expected diagram and the frozen photo side by side, with the observed region measured on each.
 * The photo pane stays tappable, so a point can be chosen after a refusal without retaking the photo.
 */
export function RefusalComparison({
    refusal,
    observation,
    entry,
    pageUris,
    onTapPoint,
}: {
    refusal: CheckResult
    observation: { uri: string; width: number; height: number }
    entry: LibraryEntry
    pageUris: WorkflowState['pageUris']
    onTapPoint: ((point: Point) => void) | undefined
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
                <Image
                    source={{ uri: diagramUri }}
                    accessibilityLabel="Cited manual page"
                    resizeMode="stretch"
                    style={StyleSheet.absoluteFill}
                />
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
    }
    return <ComparisonFrame diagram={diagram} photo={photo} />
}

/** The grounded region, drawn as an SVG child because FrozenPhoto places its overlay inside an Svg. */
export function CheckHighlight({
    rect,
}: {
    rect: { x: number; y: number; width: number; height: number }
}): ReactElement {
    const { colors } = useTheme()
    return (
        <Rect
            x={rect.x}
            y={rect.y}
            width={rect.width}
            height={rect.height}
            rx={radius.sm}
            fill="none"
            stroke={colors.accent}
            strokeWidth={3}
        />
    )
}
