import { useState, type ReactElement } from 'react'
import { StyleSheet, View } from 'react-native'
import type { ManualSession } from '@truebuild/contracts'
import { AppButton } from '../../ui/button'
import { Card } from '../../ui/surface'
import { Body, Caption, Label } from '../../ui/text'
import { space } from '../../theme/tokens'
import { stepPartChoices } from '../assembly/question-state'
import { factText } from './step-facts'

/**
 * The user's own count of the current step's parts. Quantities come only from this step, so a part reused in another
 * step is never added up. Unknown quantities stay unknown. Nothing here is a model result or infers a shortage.
 */
function InventoryConfirmation({ session, stepIndex }: { session: ManualSession; stepIndex: number }): ReactElement {
    const [located, setLocated] = useState<Readonly<Record<string, number>>>({})
    const step = session.reviewedSteps[stepIndex]
    if (step === undefined) {
        return <Caption>No step to confirm.</Caption>
    }
    const labels = new Map(stepPartChoices(session, step).map((choice) => [choice.partId, choice.label]))
    const change = (partId: string, delta: number): void =>
        setLocated((counts) => ({ ...counts, [partId]: (counts[partId] ?? 0) + delta }))
    const allLocated =
        step.parts.length > 0 &&
        step.parts.every(
            (part) => part.quantity.state === 'known' && (located[part.partId] ?? 0) >= part.quantity.value,
        )
    return (
        <View style={styles.group}>
            <Label>USER CONFIRMATION</Label>
            <Caption>Your own count of this step’s parts. It is not a model check.</Caption>
            {step.parts.length === 0 ? (
                <Body tone="muted">No parts listed for this step. Nothing to confirm.</Body>
            ) : null}
            {step.parts.map((part) => {
                const name = labels.get(part.partId) ?? part.partId
                if (part.quantity.state !== 'known') {
                    return (
                        <View key={part.partId} style={styles.group}>
                            <Body>{name}</Body>
                            <Body tone="muted">{factText(part.quantity, String)}</Body>
                            <Caption>Quantity unknown, so it is not counted.</Caption>
                        </View>
                    )
                }
                const count = located[part.partId] ?? 0
                const remaining = Math.max(part.quantity.value - count, 0)
                return (
                    <View key={part.partId} style={styles.group}>
                        <Body>{name}</Body>
                        <Caption>{`Located by you: ${count} of ${part.quantity.value}`}</Caption>
                        {remaining > 0 ? <Body>{`Not yet located: ${remaining}, please confirm`}</Body> : null}
                        <View style={styles.row}>
                            <AppButton
                                label="Located one"
                                accessibilityLabel={`Mark one ${name} located`}
                                disabled={remaining === 0}
                                onPress={(): void => change(part.partId, 1)}
                            />
                            <AppButton
                                label="Undo"
                                variant="quiet"
                                accessibilityLabel={`Undo one ${name} located`}
                                disabled={count === 0}
                                onPress={(): void => change(part.partId, -1)}
                            />
                        </View>
                    </View>
                )
            })}
            {allLocated ? <Body tone="pass">All counted parts located by you</Body> : null}
        </View>
    )
}

/** Jump to a step through the existing controller. It selects a step only; it never states an outcome. */
function JudgeChoice({
    session,
    stepIndex,
    locked,
    onSelectStep,
}: {
    session: ManualSession
    stepIndex: number
    locked: boolean
    onSelectStep: (index: number) => void
}): ReactElement {
    const choices = session.reviewedSteps
        .map((step, index) => ({ step, index }))
        .filter(({ step }) => step.orientation.state === 'known')
    return (
        <View style={styles.group}>
            <Label>Judge&apos;s choice</Label>
            <Caption>Jump to a step with a known orientation. Your photo check stays the only verdict.</Caption>
            {choices.length === 0 ? <Body tone="muted">No steps with a known orientation yet.</Body> : null}
            {choices.map(({ step, index }) => {
                const title = `Step ${step.order}: ${step.title}`
                const current = index === stepIndex
                return (
                    <AppButton
                        key={step.stepId}
                        label={current ? `Current · ${title}` : title}
                        disabled={locked || current}
                        onPress={(): void => onSelectStep(index)}
                    />
                )
            })}
        </View>
    )
}

/** Persisted completions only, resolved against this session's steps. It says nothing about the live build. */
function EarlierProgress({
    session,
    completedStepIds,
}: {
    session: ManualSession
    completedStepIds: readonly string[]
}): ReactElement {
    const done = new Set(completedStepIds)
    const steps = session.reviewedSteps.filter((step) => done.has(step.stepId))
    return (
        <View style={styles.group}>
            <Label>Earlier progress</Label>
            <Caption>
                Steps you marked complete, saved on this device. This is not a live check of the current build.
            </Caption>
            {steps.length === 0 ? <Body tone="muted">No steps marked complete yet.</Body> : null}
            {steps.map((step) => (
                <Body key={step.stepId}>{`Marked complete: ${step.order}. ${step.title}`}</Body>
            ))}
        </View>
    )
}

export function DemoControls({
    session,
    stepIndex,
    completedStepIds,
    locked,
    onSelectStep,
}: {
    session: ManualSession
    stepIndex: number
    completedStepIds: readonly string[]
    // Pending work, read-only storage or an unreviewed manual: the step selection must not run.
    locked: boolean
    onSelectStep: (index: number) => void
}): ReactElement {
    // The key drops the ephemeral count whenever the manual, its revision or the step changes.
    const identity = `${session.manualId}:${session.revision}:${session.reviewedSteps[stepIndex]?.stepId ?? ''}`
    return (
        <Card>
            <InventoryConfirmation key={identity} session={session} stepIndex={stepIndex} />
            <JudgeChoice session={session} stepIndex={stepIndex} locked={locked} onSelectStep={onSelectStep} />
            <EarlierProgress session={session} completedStepIds={completedStepIds} />
        </Card>
    )
}

const styles = StyleSheet.create({
    group: { gap: space.xs },
    row: { flexDirection: 'row', gap: space.sm, flexWrap: 'wrap' },
})
