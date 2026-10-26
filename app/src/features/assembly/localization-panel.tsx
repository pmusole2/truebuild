import type { ReactElement } from 'react'
import { StyleSheet, Text } from 'react-native'
import { palette } from '../../components/theme'
import { ActionButton, Notice, Panel, SectionTitle, Tag, TextField } from '../../components/ui'
import type { LocalizationState } from './localization-state'

type LocalizationPanelProps = {
    readonly state: LocalizationState
    readonly ready: boolean
    readonly disabledReason: string | null
    readonly onPromptChange: (prompt: string) => void
    readonly onLocate: () => void
}

const UNAVAILABLE_LOCATE: Record<string, string> = {
    unconfigured: 'Locating parts is not configured on the connected backend. No model was called.',
    unauthorized: 'The owner token was rejected. Reconnect on the connection screen.',
    timeout: 'Locating timed out. Nothing was shown; try again.',
    budget_exhausted: 'The check budget is used up. Nothing was located.',
    invalid_input:
        'Use a short noun phrase such as “side panel”. Words like “and”, “or”, “not” or questions are refused.',
}

// Copy is explicit that this is one frozen photo: no tracking, no continuous or live updates.
export function localizationStatusText(state: LocalizationState): string {
    switch (state.status) {
        case 'idle':
            return 'Finds the named part in this one frozen photo. It does not track anything across frames.'
        case 'pending':
            return 'Finding the part in the frozen photo…'
        case 'completed':
            return `Found ${state.boxes.length} region${state.boxes.length === 1 ? '' : 's'} in this frozen photo.`
        case 'empty':
            return 'No region was found for that part in this frozen photo.'
        case 'unavailable':
            return UNAVAILABLE_LOCATE[state.code ?? ''] ?? 'Could not locate the part. Nothing was shown.'
    }
}

export function LocalizationPanel({
    state,
    ready,
    disabledReason,
    onPromptChange,
    onLocate,
}: LocalizationPanelProps): ReactElement {
    const pending = state.pendingRequestId !== null
    return (
        <Panel>
            <SectionTitle>Find a part in the photo</SectionTitle>
            <Tag tone="unreviewed" text="Live model · one frozen photo" />
            <TextField
                label="Part to find in the photo"
                value={state.prompt}
                onChangeText={onPromptChange}
                placeholder="For example: side panel"
            />
            {disabledReason === null ? null : <Notice tone="caution" text={disabledReason} />}
            <ActionButton
                label={pending ? 'Finding…' : 'Find part in photo'}
                tone="primary"
                disabled={!ready || pending}
                onPress={onLocate}
            />
            <Text style={styles.status}>{localizationStatusText(state)}</Text>
            {state.status === 'unavailable' ? null : (
                <Text style={styles.status}>
                    Boxes are drawn on the frozen photo above. Nothing is tracked after the photo is taken.
                </Text>
            )}
        </Panel>
    )
}

const styles = StyleSheet.create({
    status: {
        color: palette.charcoal,
        fontSize: 15,
        lineHeight: 22,
    },
})
