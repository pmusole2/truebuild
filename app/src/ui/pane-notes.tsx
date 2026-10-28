import type { ReactElement } from 'react'
import { StyleSheet, View } from 'react-native'
import { useTheme } from '../theme/theme'
import { lightColors, radius, space } from '../theme/tokens'
import { Icon } from './icons'
import { Body, Caption } from './text'

/**
 * One line of text under an image. A plain string is a caption. A typed line names something the overlay draws:
 * `move` is the instruction, `next` and `target` are the legend for the dashed and the solid outline.
 */
export type PaneNote = string | { readonly kind: 'next' | 'target' | 'move'; readonly text: string }

/**
 * Notes under a photo, kept in a clean row outside the picture so nothing sits over the part it names. The instruction
 * leads in larger type with an arrow and a bar; the legend rows follow in caption size, each with a swatch whose
 * outline is dashed for the next part and solid for the target, so the two differ by shape and not by colour alone.
 */
export function PaneNotes({ notes }: { readonly notes: readonly PaneNote[] | undefined }): ReactElement | null {
    const { colors } = useTheme()
    if (notes === undefined || notes.length === 0) {
        return null
    }
    const typed = (note: PaneNote): note is Exclude<PaneNote, string> => typeof note !== 'string'
    const lead = notes.filter((note) => typed(note) && note.kind === 'move')
    const rest = notes.filter((note) => !lead.includes(note))
    return (
        <View style={styles.notes}>
            {[...lead, ...rest].map((note) => {
                if (!typed(note)) {
                    return <Caption key={note}>{note}</Caption>
                }
                if (note.kind === 'move') {
                    return (
                        <View key={note.text} style={[styles.move, { borderLeftColor: colors.ink }]}>
                            <Icon name="arrowRight" size="sm" />
                            <View style={styles.text}>
                                <Body>{note.text}</Body>
                            </View>
                        </View>
                    )
                }
                return (
                    <View key={note.text} style={styles.legend}>
                        <View
                            accessibilityElementsHidden={true}
                            importantForAccessibility="no-hide-descendants"
                            // The swatch repeats the on-photo pairing: a light backing under the outline in the same colour.
                            style={styles.swatchBacking}
                        >
                            <View
                                testID={`pane-note-swatch-${note.kind}`}
                                style={[
                                    styles.swatch,
                                    note.kind === 'next'
                                        ? { borderStyle: 'dashed', borderColor: lightColors.accent }
                                        : { borderStyle: 'solid', borderColor: lightColors.pass },
                                ]}
                            />
                        </View>
                        <View style={styles.text}>
                            <Caption>{note.text}</Caption>
                        </View>
                    </View>
                )
            })}
        </View>
    )
}

const styles = StyleSheet.create({
    notes: { gap: space.xs },
    move: { flexDirection: 'row', alignItems: 'center', gap: space.xs, borderLeftWidth: 3, paddingLeft: space.xs },
    legend: { flexDirection: 'row', alignItems: 'center', gap: space.xs },
    text: { flex: 1, minWidth: 0 },
    swatchBacking: {
        width: 28,
        height: 16,
        padding: 2,
        borderRadius: radius.sm,
        backgroundColor: lightColors.inkInverse,
    },
    swatch: { flex: 1, borderWidth: 2, borderRadius: radius.sm },
})
