import type { ManualPart, ManualSession } from '@truebuild/contracts'
import type { ReactElement } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { palette, space } from '../../components/theme'
import { ActionButton, Panel, SectionTitle } from '../../components/ui'
import { FactDraft, TextDraft, citedPageNumbers, pageNumberOf, partDisplayName } from './fact-draft'
import type { ManualEdit } from './manual-edits'

type PartsEditorProps = {
    readonly session: ManualSession
    readonly citePageId: string
    readonly onEdit: (edit: ManualEdit) => void
}

function partNameValue(part: ManualPart): string | null {
    return part.name.state === 'known' ? part.name.value : null
}

export function PartsEditor({ session, citePageId, onEdit }: PartsEditorProps): ReactElement {
    const selectedPageNumber = pageNumberOf(session, citePageId)

    return (
        <Panel>
            <SectionTitle>Parts</SectionTitle>
            <Text style={styles.hint}>
                Parts come from the imported pages. Steps can only require parts listed here.
            </Text>
            {session.parts.length === 0 ? <Text style={styles.empty}>No parts yet.</Text> : null}
            {session.parts.map((part) => {
                const name = partDisplayName(session, part.partId)

                return (
                    <View key={part.partId} style={styles.row}>
                        <FactDraft
                            testID={`fact-part-name-${part.partId}`}
                            label={`Name of ${name}`}
                            value={partNameValue(part)}
                            sourcePages={
                                part.name.state === 'known'
                                    ? citedPageNumbers(session, part.name.sourceRefs)
                                    : undefined
                            }
                            selectedPage={selectedPageNumber}
                            onSave={(text) =>
                                onEdit({
                                    kind: 'set-part-name',
                                    partId: part.partId,
                                    name: { state: 'known', text, pageId: citePageId },
                                })
                            }
                            onMarkUnknown={() =>
                                onEdit({ kind: 'set-part-name', partId: part.partId, name: { state: 'unknown' } })
                            }
                        />
                        <ActionButton
                            label={`Remove ${name}`}
                            tone="danger"
                            onPress={() => onEdit({ kind: 'remove-part', partId: part.partId })}
                        />
                    </View>
                )
            })}
            <TextDraft
                key={`add-part-${session.revision}`}
                label="New part name"
                initialValue=""
                actionLabel="Add part"
                placeholder="For example: side panel"
                onSubmit={(text) =>
                    onEdit({
                        kind: 'add-part',
                        name: { state: 'known', text, pageId: citePageId },
                    })
                }
            />
        </Panel>
    )
}

const styles = StyleSheet.create({
    hint: {
        color: palette.graphite,
        fontSize: 13,
        lineHeight: 18,
    },
    empty: {
        color: palette.graphite,
        fontStyle: 'italic',
    },
    row: {
        gap: space.xs,
        paddingBottom: space.sm,
        borderBottomWidth: 1,
        borderBottomColor: palette.rule,
    },
})
