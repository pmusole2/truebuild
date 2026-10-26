import type { ManualSession, SourceRef } from '@truebuild/contracts'
import { useState, type ReactElement } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { palette, space } from '../../components/theme'
import { ActionButton, TextField } from '../../components/ui'

// 1-based positions in the manual's current page order, so a citation follows its stable page after reordering.
export function citedPageNumbers(session: ManualSession, refs: readonly SourceRef[]): number[] {
    const numbers = new Set<number>()

    for (const ref of refs) {
        const index = session.pages.findIndex((page) => page.pageId === ref.pageId)

        if (index >= 0) {
            numbers.add(index + 1)
        }
    }

    return [...numbers].sort((left, right) => left - right)
}

export function pageNumberOf(session: ManualSession, pageId: string): number | undefined {
    const index = session.pages.findIndex((page) => page.pageId === pageId)

    return index >= 0 ? index + 1 : undefined
}

// User-facing part name. An unnamed part is shown by its position in the manual, never by its internal identifier.
export function partDisplayName(session: ManualSession, partId: string): string {
    const index = session.parts.findIndex((part) => part.partId === partId)
    const part = index >= 0 ? session.parts[index] : undefined

    if (part?.name.state === 'known') {
        return part.name.value
    }

    return index >= 0 ? `Unnamed part ${index + 1}` : 'Unnamed part'
}

function citationText(pages: readonly number[]): string {
    return pages.length === 1 ? `page ${pages[0]}` : `pages ${pages.join(', ')}`
}

type FactDraftProps = {
    readonly label: string
    // Null means the fact is currently unknown; the parent remounts this editor after every revision.
    readonly value: string | null
    readonly onSave: (text: string) => void
    readonly onMarkUnknown: () => void
    readonly placeholder?: string
    readonly keyboardType?: 'default' | 'number-pad'
    // 1-based manual page numbers the stored fact cites, and the page the next save will cite.
    readonly sourcePages?: readonly number[]
    readonly selectedPage?: number
    readonly testID?: string
}

export function FactDraft({
    label,
    value,
    onSave,
    onMarkUnknown,
    placeholder,
    keyboardType = 'default',
    sourcePages,
    selectedPage,
    testID,
}: FactDraftProps): ReactElement {
    const [draft, setDraft] = useState<string>(value ?? '')
    const canSave = draft.trim().length > 0
    let status: string
    if (value === null) {
        status = 'Unknown — not confirmed from the manual pages.'
    } else if (sourcePages && sourcePages.length > 0) {
        status = `Known — cited to ${citationText(sourcePages)}.`
        if (selectedPage !== undefined && !sourcePages.includes(selectedPage)) {
            status += ` Next save will cite page ${selectedPage}.`
        }
    } else {
        status = 'Known — cited to the manual pages.'
    }

    return (
        <View style={styles.container} testID={testID}>
            <TextField
                label={label}
                value={draft}
                onChangeText={setDraft}
                placeholder={placeholder}
                keyboardType={keyboardType}
                onSubmitEditing={() => {
                    if (canSave) {
                        onSave(draft)
                    }
                }}
            />
            <Text style={styles.status}>{status}</Text>
            <View style={styles.actions}>
                <ActionButton label="Save fact" tone="primary" disabled={!canSave} onPress={() => onSave(draft)} />
                <ActionButton label="Mark unknown" disabled={value === null} onPress={onMarkUnknown} />
            </View>
        </View>
    )
}

const styles = StyleSheet.create({
    container: {
        gap: space.xs,
    },
    status: {
        color: palette.graphite,
        fontSize: 13,
    },
    actions: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: space.xs,
    },
})

type TextDraftProps = {
    readonly label: string
    readonly initialValue: string
    readonly actionLabel: string
    readonly onSubmit: (text: string) => void
    readonly placeholder?: string
}

// Plain text entry for titles and new items. Parents remount it after each revision so a successful add clears it.
export function TextDraft({ label, initialValue, actionLabel, onSubmit, placeholder }: TextDraftProps): ReactElement {
    const [draft, setDraft] = useState<string>(initialValue)
    const canSubmit = draft.trim().length > 0
    return (
        <View style={styles.container}>
            <TextField
                label={label}
                value={draft}
                onChangeText={setDraft}
                placeholder={placeholder}
                onSubmitEditing={() => {
                    if (canSubmit) {
                        onSubmit(draft)
                    }
                }}
            />
            <View style={styles.actions}>
                <ActionButton
                    label={actionLabel}
                    tone="primary"
                    disabled={!canSubmit}
                    onPress={() => onSubmit(draft)}
                />
            </View>
        </View>
    )
}
