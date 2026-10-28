import type { ReactElement } from 'react'
import { View } from 'react-native'
import { stepEvidenceRequirements, type ManualSession, type SourceRef } from '@truebuild/contracts'
import { Stack } from '../../ui/surface'
import { Body, Caption, Heading } from '../../ui/text'
import { stepPartChoices } from '../assembly/question-state'
import { factText } from './fact-text'

const plainFact = (text: string): string => text.replace(/^Unknown: /u, 'The manual does not say. ')

/** Page numbers (1-based) cited by a list of references, in page order, without repeats. */
export function pageNumbers(session: ManualSession, refs: readonly SourceRef[]): number[] {
    return [
        ...new Set(
            refs
                .map((ref) => session.pages.findIndex((page) => page.pageId === ref.pageId) + 1)
                .filter((number) => number > 0),
        ),
    ].sort((a, b) => a - b)
}

/**
 * Everything the manual says about one step, in plain words. This is the full material that More shows; the default
 * surface carries only the step's name and its parts. Part ids are never shown: parts are named.
 */
export function StepDetails({
    session,
    index,
    showHeading = true,
}: {
    session: ManualSession
    index: number
    showHeading?: boolean
}): ReactElement {
    const step = session.reviewedSteps[index]
    if (step === undefined) {
        return <Body tone="muted">No steps have been read yet.</Body>
    }
    const required = stepEvidenceRequirements(step)
    const labels = new Map(stepPartChoices(session, step).map((choice) => [choice.partId, choice.label]))
    const pages = pageNumbers(session, step.sourceRefs)
    return (
        <Stack gap="xs">
            {showHeading ? <Heading>{`${step.order}. ${step.title}`}</Heading> : null}
            {step.parts.map((part) => {
                const name = labels.get(part.partId) ?? 'A part'
                const quantity =
                    part.quantity.state === 'known'
                        ? `${part.quantity.value} of these`
                        : plainFact(factText(part.quantity, String))
                const basis = part.quantityBasis
                const earlier =
                    basis?.kind === 'carried_over'
                        ? session.reviewedSteps.find((candidate) => candidate.stepId === basis.stepId)
                        : undefined
                const carried =
                    basis?.kind === 'carried_over'
                        ? ` Same count as step ${earlier?.order ?? 'before'}.`
                        : basis?.kind === 'user_supplied'
                          ? ' This one is supplied by you.'
                          : ''
                const basisPages = basis === null || basis === undefined ? [] : pageNumbers(session, basis.sourceRefs)
                return (
                    <View key={part.partId}>
                        <Body>{`${name}: ${quantity}.${carried}`}</Body>
                        {basisPages.length === 0 ? null : (
                            <Caption>{`Count from ${basisPages.length === 1 ? 'page' : 'pages'} ${basisPages.join(', ')}.`}</Caption>
                        )}
                    </View>
                )
            })}
            {required.orientation || step.orientation.state === 'known' ? (
                <Body>{`Which way it faces: ${plainFact(factText(step.orientation, (value) => value.description))}`}</Body>
            ) : null}
            {required.connection || step.connection.state === 'known' ? (
                <Body>{`How it joins: ${plainFact(factText(step.connection, (value) => value.description))}`}</Body>
            ) : null}
            {step.alternatives?.map((alternative) => (
                <View key={alternative.alternativeId}>
                    <Body>{`${alternative.alternativeId === step.selectedAlternativeId ? 'Chosen way' : 'Another way'}: ${alternative.title}. ${alternative.description}`}</Body>
                    <Caption>{`From ${pageNumbers(session, alternative.sourceRefs).length === 1 ? 'page' : 'pages'} ${pageNumbers(session, alternative.sourceRefs).join(', ')} of your manual.`}</Caption>
                </View>
            ))}
            {step.visibleChecks.map((check, position) => (
                <Body
                    key={check.checkId}
                >{`${position + 1}. Look for: ${plainFact(factText(check.description, String))}`}</Body>
            ))}
            {step.correction?.actions.map((action) => (
                <Body key={action.actionId}>{`If it is wrong: ${action.instruction}`}</Body>
            ))}
            {pages.length === 0 ? null : (
                <Caption>{`From ${pages.length === 1 ? 'page' : 'pages'} ${pages.join(', ')} of your manual.`}</Caption>
            )}
        </Stack>
    )
}
