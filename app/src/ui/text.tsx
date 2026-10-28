import type { ReactElement, ReactNode } from 'react'
import { Text } from 'react-native'
import { useTheme } from '../theme/theme'
import { typeProps, type TypeRole } from '../theme/typography'
import type { Colors } from '../theme/tokens'

// `onAccent` is the label ink for text drawn on a filled accent surface (a selected segment or chip).
export type TextTone = 'default' | 'muted' | 'inverse' | 'onAccent' | 'accent' | 'pass' | 'refuse' | 'caution'

const TONE_TOKEN: Readonly<Record<TextTone, keyof Colors>> = {
    default: 'ink',
    muted: 'inkMuted',
    inverse: 'inkInverse',
    onAccent: 'accentFillInk',
    accent: 'accentInk',
    pass: 'pass',
    refuse: 'refuse',
    caution: 'caution',
}

type TypeProps = {
    readonly children: ReactNode
    readonly tone?: TextTone
    readonly numberOfLines?: number
}

function Typeset({
    role,
    tone = 'default',
    header = false,
    children,
    numberOfLines,
}: TypeProps & { readonly role: TypeRole; readonly header?: boolean }): ReactElement {
    const { colors } = useTheme()
    const type = typeProps(role)
    return (
        <Text
            accessibilityRole={header ? 'header' : undefined}
            maxFontSizeMultiplier={type.maxFontSizeMultiplier}
            numberOfLines={numberOfLines}
            style={[type.style, { color: colors[TONE_TOKEN[tone]] }]}
        >
            {children}
        </Text>
    )
}

// Headings announce as headers to assistive tech. Body and caption text stay plain text and scale with Dynamic Type.
export function Title(props: TypeProps): ReactElement {
    return <Typeset role="title" header {...props} />
}

export function Heading(props: TypeProps): ReactElement {
    return <Typeset role="heading" header {...props} />
}

export function Body(props: TypeProps): ReactElement {
    return <Typeset role="body" {...props} />
}

export function Callout(props: TypeProps): ReactElement {
    return <Typeset role="callout" {...props} />
}

export function Caption(props: TypeProps): ReactElement {
    return <Typeset role="caption" tone="muted" {...props} />
}

export function Label(props: TypeProps): ReactElement {
    return <Typeset role="label" tone="muted" {...props} />
}
