import { useState, type ReactElement, type ReactNode } from 'react'
import { StyleSheet, useWindowDimensions, View, type LayoutChangeEvent } from 'react-native'
import type { ManualSession, SourceRef } from '@truebuild/contracts'
import { LARGE_TEXT_SCALE, SIDE_BY_SIDE_MIN_WIDTH, ViewDiagramAction } from '../../ui/comparison'
import { PaneNotes, type PaneNote } from '../../ui/pane-notes'
import { space } from '../../theme/tokens'
import type { WorkflowState } from './controller'
import { SourceDiagram } from './step-facts'

/**
 * The frozen photo and the first cited manual page, side by side, so a pass, cannot-verify or answer shows its evidence
 * in one view instead of pushing the page below the fold. The photo keeps its own caption, tap, highlight and pulse; the
 * page keeps its caption, label and cited area. Where two panes would be squeezed (large system text or a narrow window)
 * the pair stacks, photo first, exactly as before. Further cited pages are drawn by the caller beneath the pair.
 */
export function EvidencePair({
    photo,
    notes,
    reference,
    session,
    pageUris,
    onViewDiagram,
}: {
    // Draws the photo. It receives the guidance notes to show under the photo itself, or undefined when the pair is
    // side by side and the notes are drawn once, full width, beneath both panes instead.
    photo: (notes: readonly PaneNote[] | undefined) => ReactNode
    notes?: readonly PaneNote[]
    reference: SourceRef
    session: ManualSession
    pageUris: WorkflowState['pageUris']
    // Opens the full-width instructions and diagram. Offered under the pair only while the two panes are side by side.
    onViewDiagram?: () => void
}): ReactElement {
    const [width, setWidth] = useState<number | null>(null)
    const { fontScale } = useWindowDimensions()
    const sideBySide = width !== null && width >= SIDE_BY_SIDE_MIN_WIDTH && fontScale < LARGE_TEXT_SCALE
    const onLayout = (event: LayoutChangeEvent): void => setWidth(event.nativeEvent.layout.width)
    return (
        <View style={styles.pair}>
            <View testID="evidence-pair" onLayout={onLayout} style={[styles.pair, sideBySide && styles.pairRow]}>
                <View style={sideBySide ? styles.half : undefined}>{photo(sideBySide ? undefined : notes)}</View>
                <SourceDiagram
                    reference={reference}
                    index={0}
                    session={session}
                    pageUris={pageUris}
                    sideBySide={sideBySide}
                    fit={sideBySide ? 'media' : 'frame'}
                />
            </View>
            {sideBySide ? <PaneNotes notes={notes} /> : null}
            {sideBySide && onViewDiagram !== undefined ? <ViewDiagramAction onPress={onViewDiagram} /> : null}
        </View>
    )
}

const styles = StyleSheet.create({
    pair: { gap: space.md },
    pairRow: { flexDirection: 'row', alignItems: 'flex-start', gap: space.sm },
    half: { flex: 1, minWidth: 150 },
})
