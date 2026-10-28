import type { ReactElement } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { useTheme } from '../theme/theme'
import { typeProps } from '../theme/typography'
import { radius, space, type ColorToken } from '../theme/tokens'
import { Icon, type IconName } from './icons'

// Verdicts always carry an icon and a text label. Colour is never the only signal.
export type Verdict = 'pass' | 'refuse' | 'cannot_verify'

export type StatusTone = 'neutral' | 'simulated' | 'accent' | 'pass' | 'refuse' | 'caution'

const TONE: Readonly<Record<StatusTone, { surface: ColorToken; border: ColorToken; text: ColorToken }>> = {
    neutral: { surface: 'surfaceSunken', border: 'border', text: 'ink' },
    // A labelled marker, not a verdict: raised and outlined, so it never outshines Pass, Refuse or Cannot verify.
    simulated: { surface: 'surfaceRaised', border: 'borderStrong', text: 'ink' },
    accent: { surface: 'accent', border: 'accent', text: 'accentFillInk' },
    pass: { surface: 'passSurface', border: 'pass', text: 'pass' },
    refuse: { surface: 'refuseSurface', border: 'refuse', text: 'refuse' },
    caution: { surface: 'cautionSurface', border: 'caution', text: 'caution' },
}

export function StatusTag({
    label,
    tone = 'neutral',
    icon,
}: {
    readonly label: string
    readonly tone?: StatusTone
    readonly icon?: IconName
}): ReactElement {
    const { colors } = useTheme()
    const tokens = TONE[tone]
    const type = typeProps('label')
    const iconColor = colors[tokens.text]
    return (
        <View style={[styles.tag, { backgroundColor: colors[tokens.surface] }]}>
            {icon === undefined ? null : <Icon name={icon} size="sm" color={iconColor} />}
            <Text
                maxFontSizeMultiplier={type.maxFontSizeMultiplier}
                style={[type.style, styles.tagText, { color: iconColor }]}
            >
                {label}
            </Text>
        </View>
    )
}

const VERDICT: Readonly<Record<Verdict, { label: string; tone: StatusTone; icon: IconName }>> = {
    pass: { label: 'Looks right', tone: 'pass', icon: 'check' },
    refuse: { label: 'Not yet', tone: 'refuse', icon: 'close' },
    cannot_verify: { label: 'Can’t tell', tone: 'caution', icon: 'help' },
}

export function VerdictTag({ verdict }: { readonly verdict: Verdict }): ReactElement {
    const { label, tone, icon } = VERDICT[verdict]
    return <StatusTag label={label} tone={tone} icon={icon} />
}

export type NoticeTone = 'info' | 'caution' | 'error'

const NOTICE_INK: Readonly<Record<NoticeTone, ColorToken>> = {
    info: 'ink',
    caution: 'caution',
    error: 'refuse',
}

/**
 * Inline message. Errors announce as alerts; other notices are read in place so they do not interrupt the user.
 */
export function Notice({ text, tone = 'info' }: { readonly text: string; readonly tone?: NoticeTone }): ReactElement {
    const { colors } = useTheme()
    const type = typeProps('callout')
    return (
        <View
            accessible={true}
            accessibilityRole={tone === 'error' ? 'alert' : undefined}
            style={[styles.notice, { backgroundColor: colors.surfaceRaised }]}
        >
            <Icon name={tone === 'info' ? 'info' : 'alert'} size="sm" color={colors[NOTICE_INK[tone]]} />
            <Text
                maxFontSizeMultiplier={type.maxFontSizeMultiplier}
                style={[type.style, styles.noticeText, { color: colors.ink }]}
            >
                {text}
            </Text>
        </View>
    )
}

const styles = StyleSheet.create({
    tag: {
        alignSelf: 'flex-start',
        flexDirection: 'row',
        alignItems: 'center',
        gap: space.xs,
        borderRadius: radius.pill,
        minHeight: 28,
        paddingHorizontal: space.sm,
        paddingVertical: space.xxs,
    },
    tagText: {
        flexShrink: 1,
    },
    notice: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: space.xs,
        borderRadius: radius.md,
        borderCurve: 'continuous',
        padding: space.sm,
    },
    noticeText: { flex: 1 },
})
