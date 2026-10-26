import type { ReactElement } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import type { Fact, ManualPart, ManualStep } from '@truebuild/contracts'
import { palette, space } from '../components/theme'
import { Notice } from '../components/ui'

type PlanSummaryProps = {
    readonly parts: readonly ManualPart[]
    readonly steps: readonly ManualStep[]
    readonly unknowns: readonly string[]
}

function factText<T>(fact: Fact<T>, show: (value: T) => string): string {
    return fact.state === 'known' ? show(fact.value) : `UNKNOWN — ${fact.reason}`
}

function pagesOf(step: ManualStep): string {
    const ids = new Set(step.sourceRefs.map((ref) => ref.pageId))
    return ids.size === 0 ? 'no cited page' : `cited page ${[...ids].join(', ')}`
}

/**
 * Read-only facts behind a plan. Every critical fact is shown as stated or as UNKNOWN with its reason. Nothing here can
 * be edited, accepted or corrected; unknowns stay visible until the plan is replaced.
 */
export function PlanSummary({ parts, steps, unknowns }: PlanSummaryProps): ReactElement {
    return (
        <View style={styles.stack}>
            {unknowns.length === 0 ? null : (
                <View style={styles.stack}>
                    <Notice
                        tone="error"
                        text={`${unknowns.length} critical fact(s) unknown. Confirmation is blocked.`}
                    />
                    {unknowns.map((unknown) => (
                        <Text key={unknown} style={styles.unknown}>
                            {unknown}
                        </Text>
                    ))}
                </View>
            )}
            <Text style={styles.heading}>Parts</Text>
            {parts.map((part) => (
                <Text key={part.partId} style={styles.body}>
                    {part.partId}: {factText(part.name, (name) => name)}
                </Text>
            ))}
            {steps.map((step) => (
                <View key={step.stepId} style={styles.step}>
                    <Text style={styles.heading}>
                        {step.order}. {step.title}
                    </Text>
                    {step.parts.map((part) => (
                        <Text key={part.partId} style={styles.body}>
                            Quantity of {part.partId}: {factText(part.quantity, (value) => String(value))}
                        </Text>
                    ))}
                    <Text style={styles.body}>
                        Orientation: {factText(step.orientation, (value) => value.description)}
                    </Text>
                    <Text style={styles.body}>
                        Connection: {factText(step.connection, (value) => value.description)}
                    </Text>
                    {step.visibleChecks.map((check) => (
                        <Text key={check.checkId} style={styles.body}>
                            Visible check: {factText(check.description, (text) => text)}
                        </Text>
                    ))}
                    <Text style={styles.body}>{pagesOf(step)}</Text>
                </View>
            ))}
        </View>
    )
}

const styles = StyleSheet.create({
    stack: { gap: space.xs },
    step: { gap: space.xs, paddingVertical: space.xs, borderTopWidth: 1, borderColor: palette.rule },
    heading: { color: palette.charcoal, fontSize: 15, fontWeight: '600' },
    body: { color: palette.charcoal, fontSize: 14, lineHeight: 20 },
    unknown: { color: palette.signalInk, fontSize: 14, lineHeight: 20 },
})
