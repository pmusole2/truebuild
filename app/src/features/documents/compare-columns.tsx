import type { ReactElement } from 'react'
import { ScrollView, StyleSheet, useWindowDimensions, View } from 'react-native'
import { Card, Stack } from '../../ui/surface'
import { Caption, Heading } from '../../ui/text'
import { space } from '../../theme/tokens'
import { DocumentBody } from './document-renderer'
import type { FrameBindings, FrameDocument } from './types'

/** Two panes sit side by side from this width; narrower, they stack in one labelled scroll. */
export const COMPARE_SIDE_BY_SIDE_WIDTH = 900
export const COMPARE_NARROW_WIDTH = 440

export type ComparePaneInput = {
    readonly manualId: string
    /** Real manual title from app state. Panes are told apart by title and first-page hero before any body text. */
    readonly title: string
    readonly note: string
    readonly document: FrameDocument
    readonly bindings: FrameBindings
}

/**
 * Native wide/narrow compare. Wide (>=900pt): a row of independent panes. Narrow: panes stack in one scroll,
 * each headed by its real title and hero, and the stacking is labelled — never claimed "side by side".
 * Pane subtrees are document content: no capability-internals exclusion ever removes them.
 */
export function CompareColumns({ panes }: { readonly panes: readonly ComparePaneInput[] }): ReactElement {
    const { width } = useWindowDimensions()
    const wide = width >= COMPARE_SIDE_BY_SIDE_WIDTH
    const content = (
        <View testID="compare-panes" style={[styles.panes, wide ? styles.row : styles.column]}>
            {panes.map((pane) => (
                <View
                    key={pane.manualId}
                    testID={`compare-pane-${pane.manualId}`}
                    style={wide ? styles.pane : undefined}
                >
                    <Card tone="raised">
                        <Stack gap="sm">
                            <Heading>{pane.title}</Heading>
                            <Caption>{pane.note}</Caption>
                            <DocumentBody document={pane.document} bindings={pane.bindings} />
                            <Caption>{`Main button: ${pane.document.bar.primary.label}`}</Caption>
                        </Stack>
                    </Card>
                </View>
            ))}
        </View>
    )
    if (wide) return content
    return (
        <ScrollView testID="compare-narrow" contentContainerStyle={styles.narrow}>
            <Caption>Narrow layout: panes are stacked, not side by side.</Caption>
            {content}
        </ScrollView>
    )
}

const styles = StyleSheet.create({
    panes: { gap: space.md },
    row: { flexDirection: 'row' },
    column: { flexDirection: 'column' },
    pane: { flex: 1 },
    narrow: { gap: space.md },
})
