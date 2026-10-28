import type { ReactElement } from 'react'
import { StyleSheet, View } from 'react-native'
import {
    layoutSchema,
    type CheckResult,
    type Layout,
    type ManualSession,
    type ManualStep,
    type QuestionResult,
    type SourceRef,
} from '@truebuild/contracts'
import { Card } from '../../ui/surface'
import { Body, Label } from '../../ui/text'
import { space } from '../../theme/tokens'
import { stepPartChoices } from '../assembly/question-state'
import type { WorkflowState } from './controller'
import { factText, SourceDiagrams, StepSummary } from './step-facts'

type Resolved = { kind: 'lines'; label: string; lines: string[] } | { kind: 'diagrams'; refs: SourceRef[] }

type LayoutResult = CheckResult | QuestionResult

/** Maps every id to the current step's own validated text; one id that does not resolve rejects the whole layout. */
function resolveComponent(
    component: Layout['components'][number],
    session: ManualSession,
    step: ManualStep,
    result: LayoutResult,
): Resolved | null {
    switch (component.type) {
        case 'part_grid': {
            const labels = new Map(stepPartChoices(session, step).map((choice) => [choice.partId, choice.label]))
            const lines: string[] = []
            for (const partId of component.partIds) {
                const part = step.parts.find((candidate) => candidate.partId === partId)
                if (part === undefined) {
                    return null
                }
                const name = labels.get(partId) ?? partId
                lines.push(
                    part.quantity.state === 'known'
                        ? `${part.quantity.value} × ${name}`
                        : `${name}: ${factText(part.quantity, String)}`,
                )
            }
            return { kind: 'lines', label: 'Parts', lines }
        }
        case 'orientation':
            return step.orientation.state === 'known' && step.orientation.value.partId === component.partId
                ? { kind: 'lines', label: 'Orientation', lines: [step.orientation.value.description] }
                : null
        case 'connection': {
            const connection = step.connection
            return connection.state === 'known' &&
                component.partIds.every((partId) => connection.value.partIds.includes(partId))
                ? { kind: 'lines', label: 'Connection', lines: [connection.value.description] }
                : null
        }
        case 'visible_checks': {
            const lines: string[] = []
            for (const checkId of component.checkIds) {
                const description = step.visibleChecks.find((check) => check.checkId === checkId)?.description
                if (description === undefined || description.state !== 'known') {
                    return null
                }
                lines.push(description.value)
            }
            return { kind: 'lines', label: 'Visible checks', lines }
        }
        case 'source_diagram': {
            const refs = component.sourceRefIndexes.map((index) => step.sourceRefs[index])
            return refs.every((ref) => ref !== undefined && session.pages.some((page) => page.pageId === ref.pageId))
                ? { kind: 'diagrams', refs: refs as SourceRef[] }
                : null
        }
        case 'recovery': {
            // A correction is offered only after this step's check refused it and a person reviewed the correction.
            if (!('decision' in result) || result.decision !== 'refuse' || step.correction?.reviewed !== true) {
                return null
            }
            const actions = step.correction.actions
            const lines: string[] = []
            for (const actionId of component.actionIds) {
                const action = actions.find((candidate) => candidate.actionId === actionId)
                if (action === undefined) {
                    return null
                }
                lines.push(action.instruction)
            }
            return { kind: 'lines', label: 'Correction', lines }
        }
    }
}

/** Null means "use the existing step summary". Only a fully valid, provenance-marked layout resolves. */
export function resolveStepLayout(
    session: ManualSession,
    index: number,
    result: LayoutResult | null,
): Resolved[] | null {
    const step = session.reviewedSteps[index]
    const parsed = layoutSchema.safeParse(result?.layout)
    if (result === null || step === undefined || !parsed.success) {
        return null
    }
    const { source, components } = parsed.data
    if (source === undefined || components.length === 0) {
        return null
    }
    const resolved = components.map((component) => resolveComponent(component, session, step, result))
    return resolved.every((item) => item !== null) ? (resolved as Resolved[]) : null
}

/**
 * The current step's facts, arranged by the response's closed layout when every reference resolves. The verdict,
 * reason and missing evidence are rendered elsewhere and the full instructions stay in the sheet. Anything that does
 * not resolve shows the unchanged step summary, so the area is never blank.
 */
export function StepLayout({
    session,
    index,
    result,
    pageUris,
}: {
    session: ManualSession
    index: number
    result: LayoutResult | null
    pageUris: WorkflowState['pageUris']
}): ReactElement | null {
    const resolved = resolveStepLayout(session, index, result)
    if (resolved === null) {
        return <StepSummary session={session} index={index} />
    }
    return (
        <Card tone="raised">
            {resolved.map((item, position) =>
                item.kind === 'diagrams' ? (
                    <SourceDiagrams key={position} refs={item.refs} session={session} pageUris={pageUris} />
                ) : (
                    <View key={position} style={styles.group}>
                        <Label>{item.label}</Label>
                        {item.lines.map((line, lineIndex) => (
                            <Body key={lineIndex}>{line}</Body>
                        ))}
                    </View>
                ),
            )}
        </Card>
    )
}

const styles = StyleSheet.create({
    group: { gap: space.xs },
})
