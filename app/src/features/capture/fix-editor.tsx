import { useState, type ReactElement } from 'react'
import { StyleSheet, View } from 'react-native'
import type { ManualBinding, ManualSession } from '@truebuild/contracts'
import { AppButton } from '../../ui/button'
import { SegmentedControl, TextField } from '../../ui/fields'
import { Body, Caption } from '../../ui/text'
import { space } from '../../theme/tokens'
import { plainWords } from './plain-copy'
import type { Question } from './quick-check-model'
import { PlainNotice } from './screen-layout'
import type { WorkflowScreenProps } from './workflow-types'

/**
 * The one scoped editor, opened by Let me fix it (or placed in the Quick check body by a composed screen). Its draft
 * lives only while it is mounted: Cancel and closing discard it, a refused save keeps it, and only Save writes
 * (through the unchanged `acceptStepFacts`). The same logic serves the native sheet and the composed block.
 */
export function FixEditor({
    question,
    session,
    state,
    controller,
    busy,
    onDone,
    nativeID,
    labels,
}: {
    question: Question
    session: ManualSession
    state: WorkflowScreenProps['state']
    controller: WorkflowScreenProps['controller']
    busy: boolean
    onDone: () => void
    /** Render-origin marker for the root when a composed screen placed this editor. */
    nativeID?: string
    /** Words a composed screen chose; the field names stay the app's own. */
    labels?: { readonly label?: string; readonly save?: string; readonly cancel?: string }
}): ReactElement {
    const { step } = question
    const binding: ManualBinding = { kind: 'manual', manualId: session.manualId, revision: session.revision }
    const names = new Map(
        session.parts.map((part) => [part.partId, part.name.state === 'known' ? part.name.value : 'A part']),
    )
    const parts = step.parts.map((part) => ({ value: part.partId, label: names.get(part.partId) ?? 'A part' }))
    const [partId, setPartId] = useState<string | null>(parts.length === 1 ? parts[0]!.value : null)
    const [text, setText] = useState('')
    const [error, setError] = useState<string | undefined>(undefined)
    const accept = async (
        resolution: Parameters<WorkflowScreenProps['controller']['acceptStepFacts']>[2],
    ): Promise<void> => {
        if (await controller.acceptStepFacts(binding, step.stepId, resolution)) {
            onDone()
        }
    }
    const save = async (): Promise<void> => {
        if (question.kind === 'orientation') {
            const description = text.trim()
            if (description.length === 0) {
                setError('Write a few words first.')
                return
            }
            if (partId === null) {
                setError('Choose the part first.')
                return
            }
            setError(undefined)
            await accept({ orientation: { partId, description } })
            return
        }
        const visibleChecks = text
            .split('\n')
            .map((line) => line.trim())
            .filter((line) => line.length > 0)
        if (visibleChecks.length === 0) {
            setError('Write at least one thing, one per line.')
            return
        }
        setError(undefined)
        await accept({ visibleChecks })
    }
    return (
        <View testID="quick-check-editor" nativeID={nativeID} style={styles.editor}>
            <PlainNotice state={state} controller={controller} />
            <Body>
                {question.kind === 'orientation'
                    ? `Which way should the part face in step ${step.order}?`
                    : `What should you see when step ${step.order} is done?`}
            </Body>
            {question.reason === null ? null : <Caption>{`The manual says: ${plainWords(question.reason)}`}</Caption>}
            {question.kind === 'orientation' && parts.length > 1 ? (
                <SegmentedControl label="Which part" options={parts} value={partId ?? ''} onChange={setPartId} />
            ) : null}
            {question.kind === 'orientation' && parts.length === 1 ? (
                <Caption>{`Part: ${parts[0]!.label}`}</Caption>
            ) : null}
            <TextField
                label={
                    labels?.label ??
                    (question.kind === 'orientation' ? 'What the picture shows' : 'What you should see, one per line')
                }
                value={text}
                onChangeText={setText}
                multiline={question.kind === 'checks'}
                placeholder={question.kind === 'orientation' ? 'e.g. the groove faces inward' : 'One thing per line'}
                error={error}
                editable={!busy}
            />
            <AppButton
                label={labels?.save ?? 'Save'}
                accessibilityLabel="Save"
                testID="quick-check-save"
                variant="accent"
                disabled={busy || (question.kind === 'orientation' && parts.length === 0)}
                onPress={(): void => {
                    void save()
                }}
            />
            <AppButton
                label={labels?.cancel ?? 'Cancel'}
                accessibilityLabel="Cancel"
                testID="quick-check-cancel"
                variant="quiet"
                onPress={onDone}
            />
        </View>
    )
}

const styles = StyleSheet.create({
    editor: { gap: space.md },
})
