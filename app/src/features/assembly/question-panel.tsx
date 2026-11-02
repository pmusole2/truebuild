import type { ReactElement } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import type { ManualSession, QuestionTarget } from '@truebuild/contracts'
import { palette, space } from '../../components/theme'
import { ActionButton, Notice, Panel, SectionTitle, Tag, TextField } from '../../components/ui'
import { QUESTION_MAX_LENGTH, QUESTION_PRESETS, type QuestionState } from './question-state'

type QuestionPanelProps = {
    readonly session: ManualSession
    readonly state: QuestionState
    readonly parts: readonly { readonly partId: string; readonly label: string }[]
    readonly ready: boolean
    readonly disabledReason: string | null
    readonly onQuestionChange: (question: string) => void
    readonly onPartTarget: (partId: string) => void
    readonly onClearTarget: () => void
    readonly onAsk: () => void
}

const UNAVAILABLE_QUESTION: Record<string, string> = {
    unconfigured: 'Live questions are not configured on the connected backend. No model was called.',
    unauthorized: 'The backend rejected the shared key (x-truebuild-key). Check EXPO_PUBLIC_API_SECRET.',
    timeout: 'The question timed out. Nothing was answered; try again.',
    budget_exhausted: 'Too many builds right now, try again later.',
    invalid_input: 'This question cannot be sent for this step and photo. Check the wording and target.',
}

export function targetText(target: QuestionTarget | null, parts: QuestionPanelProps['parts']): string {
    if (target === null) {
        return 'No target chosen. Pick a part of this step.'
    }
    if (target.kind === 'part') {
        return `Target: part ${parts.find((part) => part.partId === target.partId)?.label ?? target.partId}`
    }
    return `Target: tapped spot at ${Math.round(target.x * 100)}%, ${Math.round(target.y * 100)}% of the photo`
}

export function QuestionPanel({
    session,
    state,
    parts,
    ready,
    disabledReason,
    onQuestionChange,
    onPartTarget,
    onClearTarget,
    onAsk,
}: QuestionPanelProps): ReactElement {
    const pending = state.pendingRequestId !== null
    const result = state.result

    return (
        <Panel>
            <SectionTitle>Ask about this step</SectionTitle>
            <Text style={styles.body}>
                Answers come from this step&apos;s cited pages and the frozen photo. A model answer is not verified
                until you confirm it against the manual.
            </Text>
            <Tag tone="unreviewed" text="Question about this photo" />
            <TextField
                label="Question about this step"
                value={state.question}
                onChangeText={onQuestionChange}
                placeholder="For example: which way should this part face?"
            />
            <Text style={styles.hint}>
                {state.question.length}/{QUESTION_MAX_LENGTH} characters
            </Text>
            <View style={styles.actions}>
                {QUESTION_PRESETS.map((preset) => (
                    <ActionButton
                        key={preset}
                        label={`Use preset: ${preset}`}
                        onPress={() => onQuestionChange(preset)}
                    />
                ))}
            </View>
            <Text style={styles.body}>{targetText(state.target, parts)}</Text>
            <View style={styles.actions}>
                {parts.map((part) => (
                    <ActionButton
                        key={part.partId}
                        label={`Ask about part ${part.label}`}
                        onPress={() => onPartTarget(part.partId)}
                    />
                ))}
                <ActionButton label="Clear target" disabled={state.target === null} onPress={onClearTarget} />
            </View>
            {disabledReason === null ? null : <Notice tone="caution" text={disabledReason} />}
            <ActionButton
                label={pending ? 'Asking…' : 'Ask question'}
                tone="primary"
                disabled={!ready || pending}
                onPress={onAsk}
            />
            {result === null ? null : result.status === 'ok' ? (
                <View style={styles.result}>
                    <Tag tone="unreviewed" text="Answer" />
                    <Text style={styles.answer}>{result.value.answer}</Text>
                    <Text style={styles.body}>
                        Cited:{' '}
                        {result.value.sourceRefs.length === 0
                            ? 'no page'
                            : [...new Set(result.value.sourceRefs.map((ref) => ref.pageId))]
                                  .map(
                                      (pageId) =>
                                          `page ${session.pages.findIndex((page) => page.pageId === pageId) + 1}`,
                                  )
                                  .join(', ')}
                    </Text>
                    {result.value.missingEvidence.map((item) => (
                        <Text key={item} style={styles.body}>
                            Missing: {item}
                        </Text>
                    ))}
                </View>
            ) : (
                <Notice
                    tone="error"
                    text={
                        UNAVAILABLE_QUESTION[result.code] ?? 'The question could not be answered. Nothing was answered.'
                    }
                />
            )}
        </Panel>
    )
}

const styles = StyleSheet.create({
    body: {
        color: palette.charcoal,
        fontSize: 15,
        lineHeight: 22,
    },
    hint: {
        color: palette.graphite,
        fontSize: 13,
    },
    actions: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: space.xs,
    },
    result: {
        gap: space.xs,
    },
    answer: {
        color: palette.charcoal,
        fontSize: 18,
        fontWeight: '700',
    },
})
