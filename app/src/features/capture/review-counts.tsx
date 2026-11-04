import { useState, type ReactElement } from 'react'
import { isQuantityNotStated, type ManualSession, type ManualStep } from '@truebuild/contracts'
import { AppButton } from '../../ui/button'
import { TextField } from '../../ui/fields'
import { Stack } from '../../ui/surface'
import { Body, Heading } from '../../ui/text'
import type { WorkflowScreenProps } from './workflow-types'

/** The production More sheet keeps unstated counts visible and editable without making them required. */
export function ReviewCounts({
    session,
    controller,
    busy,
}: {
    session: ManualSession
    controller: WorkflowScreenProps['controller']
    busy: boolean
}): ReactElement | null {
    const steps = session.reviewedSteps.filter((step) => step.parts.some(isQuantityNotStated))
    if (steps.length === 0) return null
    return (
        <Stack gap="sm">
            <Heading>Optional counts</Heading>
            {steps.map((step) => (
                <Stack key={step.stepId} gap="xs">
                    <Body>{`Step ${step.order}`}</Body>
                    {step.parts.filter(isQuantityNotStated).map((part) => {
                        const record = session.parts.find((item) => item.partId === part.partId)
                        const name = record?.name.state === 'known' ? record.name.value : 'A part'
                        return (
                            <Stack key={`${session.revision}:${part.partId}`} gap="xs">
                                <Body>{`${name}: count not stated in the manual.`}</Body>
                                <OptionalCount
                                    session={session}
                                    step={step}
                                    partId={part.partId}
                                    controller={controller}
                                    busy={busy}
                                />
                            </Stack>
                        )
                    })}
                </Stack>
            ))}
        </Stack>
    )
}

/** A local reviewed count is optional; the original extraction is preserved by acceptStepFacts. */
export function OptionalCount({
    session,
    step,
    partId,
    controller,
    busy,
}: {
    session: ManualSession
    step: ManualStep
    partId: string
    controller: WorkflowScreenProps['controller']
    busy: boolean
}): ReactElement {
    const [text, setText] = useState('')
    const [error, setError] = useState<string | undefined>()
    const part = session.parts.find((item) => item.partId === partId)
    const name = part?.name.state === 'known' ? part.name.value : 'this part'
    return (
        <Stack gap="xs">
            <TextField
                label={`Count for ${name} (optional)`}
                value={text}
                onChangeText={setText}
                keyboardType="number-pad"
                editable={!busy}
                error={error}
            />
            <AppButton
                label={`Save count for ${name}`}
                variant="quiet"
                disabled={busy || text.trim() === ''}
                onPress={(): void => {
                    const value = Number(text)
                    if (!/^\d+$/u.test(text.trim()) || !Number.isSafeInteger(value) || value < 1) {
                        setError('Enter a positive whole number.')
                        return
                    }
                    setError(undefined)
                    void controller.acceptStepFacts(
                        { kind: 'manual', manualId: session.manualId, revision: session.revision },
                        step.stepId,
                        { quantity: { partId, value } },
                    )
                }}
            />
        </Stack>
    )
}
