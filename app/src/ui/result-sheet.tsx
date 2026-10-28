import type { ReactElement, ReactNode } from 'react'
import { StyleSheet, View } from 'react-native'
import { radius, space } from '../theme/tokens'
import { Icon } from './icons'
import { useTheme } from '../theme/theme'
import { VerdictTag, type Verdict } from './status'
import { Body, Callout, Caption } from './text'
import { Card, Stack } from './surface'

// The result of one step check. Pass, refuse and cannot-verify differ in tag, icon, colour and wording, and the
// reason is always shown in full, so no verdict is conveyed by colour alone.
export function ResultSheet({
    verdict,
    reason,
    missing = [],
    provenance,
    citedPage,
    actions,
    testID,
}: {
    readonly verdict: Verdict
    readonly reason: string
    readonly missing?: readonly string[]
    // A plain statement of what the result is, such as a simulated or unanalysed result. Shown above the verdict.
    readonly provenance?: string
    // The cited manual page for a refusal, or a notice explaining that it is not held in this session.
    readonly citedPage?: ReactNode
    readonly actions?: ReactNode
    readonly testID?: string
}): ReactElement {
    const { colors } = useTheme()
    return (
        <View accessibilityLiveRegion="polite" testID={testID} style={styles.wrap}>
            <Card tone="result">
                <Stack gap="sm">
                    {provenance === undefined ? null : <Caption>{provenance}</Caption>}
                    <VerdictTag verdict={verdict} />
                    <Body>{reason}</Body>
                    {missing.length === 0 ? null : (
                        <View style={styles.missing}>
                            {missing.map((item) => (
                                <View key={item} style={styles.missingItem}>
                                    <Icon name="help" size="sm" color={colors.caution} />
                                    <View style={styles.missingText}>
                                        <Callout>{`Missing: ${item}`}</Callout>
                                    </View>
                                </View>
                            ))}
                        </View>
                    )}
                    {citedPage}
                    {actions}
                </Stack>
            </Card>
        </View>
    )
}

const styles = StyleSheet.create({
    wrap: {
        borderRadius: radius.lg,
        overflow: 'hidden',
        gap: space.xs,
    },
    missing: { gap: space.xs },
    missingItem: { flexDirection: 'row', alignItems: 'flex-start', gap: space.xs },
    missingText: { flex: 1 },
})
