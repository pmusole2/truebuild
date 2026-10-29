import type { ReactElement, ReactNode } from 'react'
import { Text, type StyleProp, type TextStyle } from 'react-native'
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
    // Render-origin marker for a text composed from a screen document; see features/screens/render-origin.
    readonly nativeID?: string
    readonly style?: StyleProp<TextStyle>
}

function Typeset({
    role,
    tone = 'default',
    header = false,
    children,
    numberOfLines,
    nativeID,
    style,
}: TypeProps & { readonly role: TypeRole; readonly header?: boolean }): ReactElement {
    const { colors } = useTheme()
    const type = typeProps(role)
    return (
        <Text
            nativeID={nativeID}
            accessibilityRole={header ? 'header' : undefined}
            maxFontSizeMultiplier={type.maxFontSizeMultiplier}
            numberOfLines={numberOfLines}
            style={[type.style, { color: colors[TONE_TOKEN[tone]] }, style]}
        >
            {children}
        </Text>
    )
}

// Headings announce as headers to assistive tech. Body and caption text stay plain text and scale with Dynamic Type.
export function Title(props: TypeProps): ReactElement {
    return <Typeset role="title" header {...props} />
}

export function LargeTitle(props: TypeProps): ReactElement {
    return <Typeset role="largeTitle" header {...props} />
}

/** The one sentence a person acts on. Wraps freely; the screen scrolls only this text when it overflows. */
export function Instruction(props: TypeProps): ReactElement {
    return <Typeset role="instruction" {...props} />
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
