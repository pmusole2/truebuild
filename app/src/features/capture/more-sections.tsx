import { useState, type ReactElement, type ReactNode } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import type { CheckResult, QuestionResult } from '@truebuild/contracts'
import { API_BASE_URL, developmentHost } from '../../config'
import { Stack } from '../../ui/surface'
import { Body, Caption, Heading } from '../../ui/text'
import { useTheme } from '../../theme/theme'
import { touchTarget } from '../../theme/tokens'
import { HideTipsForTestingRow } from '../onboarding/tips-rows'
import { ModelProvenance } from './step-facts'
import { BuiltToggleRow, CompareManualsRow, StagesPanel } from '../screens/attribution'
import type { CheckStages } from './controller'
import { secondOpinionLine } from './provenance-copy'
import type { ScreenSlot } from '../screens/use-screen-slot'

const VERBS = [
    ['Scan', 'Photograph the pages of your paper manual.'],
    ['Look', 'We read the pages and show you each step.'],
    ['Next', 'Do one step, take one photo, hear how it went.'],
    ['Ask', 'Stuck? Photograph the part and ask in your own words.'],
] as const

/** The four things the app does, in the order a person meets them. */
export function HowItWorks(): ReactElement {
    return (
        <Stack gap="sm">
            <Heading>How it works</Heading>
            {VERBS.map(([verb, text]) => (
                <Body key={verb}>{`${verb}. ${text}`}</Body>
            ))}
        </Stack>
    )
}

/**
 * The discreet judge entry: the one place where how a result was produced may show, and where the judge and demo
 * controls live. It needs More and one more tap, is never in the bottom bar, and is the only place model names and
 * notes render.
 */
export function AboutThisCheck({
    result,
    children,
    stages,
    resultSlot,
    check,
    onCompare,
}: {
    result?: Pick<CheckResult | QuestionResult, 'model' | 'modelNotes'> &
        Partial<Pick<CheckResult, 'secondOpinion' | 'evidence'>>
    // Judge and demo controls. They render only once the entry is open, so no technical control shows before it.
    children?: ReactNode
    // The same photo's stages after the verdict, and the composed result screen's state, for the judge layer only.
    stages?: CheckStages | null
    resultSlot?: ScreenSlot
    check?: Pick<CheckResult, 'model' | 'decision'> | null
    onCompare?: () => void
}): ReactElement {
    const { colors } = useTheme()
    const [open, setOpen] = useState(false)
    return (
        <Stack gap="xs">
            <Pressable
                testID="judge-entry"
                accessibilityRole="button"
                accessibilityLabel="About this check"
                accessibilityState={{ expanded: open }}
                onPress={(): void => setOpen(!open)}
                style={styles.entry}
            >
                <Text style={[styles.entryText, { color: colors.inkMuted }]}>About this check</Text>
            </Pressable>
            {open ? (
                <View testID="judge-details" style={styles.details}>
                    {result === undefined ? (
                        <Caption>No check has been made yet.</Caption>
                    ) : (
                        <ModelProvenance result={result} />
                    )}
                    {result === undefined || secondOpinionLine(result) === null ? null : (
                        <Caption>{secondOpinionLine(result)}</Caption>
                    )}
                    <StagesPanel check={check ?? null} stages={stages} resultSlot={resultSlot} />
                    <BuiltToggleRow />
                    <CompareManualsRow onOpen={onCompare} />
                    {children}
                    <HideTipsForTestingRow />
                    {__DEV__ ? (
                        <View testID="development-api-host">
                            <Caption>{`Meta · ${developmentHost(API_BASE_URL)}`}</Caption>
                        </View>
                    ) : null}
                </View>
            ) : null}
        </Stack>
    )
}

const styles = StyleSheet.create({
    entry: { minHeight: touchTarget, justifyContent: 'center' },
    entryText: { fontSize: 13, lineHeight: 18 },
    details: { gap: 8 },
})
