import type { ReactElement } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import Svg, { Line, Polygon, Rect } from 'react-native-svg'
import { palette, space } from '../components/theme'

type ManualDiagramProps = {
    readonly title: string
    readonly simulated: boolean
}

/**
 * Synthetic step diagram for the sample manual. It is labelled as synthetic and is never presented as a page of a
 * real manual. A photographed manual page is shown instead when the app holds one (model mode).
 */
export function ManualDiagram({ title, simulated }: ManualDiagramProps): ReactElement {
    return (
        <View style={styles.wrap}>
            <Svg width="100%" height={160} viewBox="0 0 240 160">
                <Rect x={60} y={20} width={24} height={120} fill={palette.paperDeep} stroke={palette.charcoal} strokeWidth={2} />
                <Line x1={84} y1={50} x2={84} y2={110} stroke={palette.signal} strokeWidth={3} />
                <Polygon points="100,80 130,70 130,90" fill={palette.signal} />
                <Rect x={140} y={40} width={80} height={12} fill={palette.paperDeep} stroke={palette.charcoal} strokeWidth={1} />
            </Svg>
            <Text style={styles.caption}>
                {simulated ? 'Synthetic diagram for the sample manual: ' : 'Manual diagram: '}
                {title}
            </Text>
            {simulated ? (
                <Text style={styles.note}>Not from a real manual. Compare with the physical manual page.</Text>
            ) : null}
        </View>
    )
}

const styles = StyleSheet.create({
    wrap: { gap: space.xs, padding: space.sm, borderWidth: 1, borderColor: palette.rule, backgroundColor: palette.paperRaised },
    caption: { color: palette.charcoal, fontSize: 14 },
    note: { color: palette.cautionInk, fontSize: 13 },
})
