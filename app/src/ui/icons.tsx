import type { ReactElement } from 'react'
import Svg, { Path } from 'react-native-svg'
import { useTheme } from '../theme/theme'
import { iconSize } from '../theme/tokens'

// One 24-unit stroke grid for every glyph. Icons are decorative: the label beside or on the control carries meaning.
const GLYPHS = {
    alert: ['M12 4.2 21 19.6H3z', 'M12 10v4.4', 'M12 17.2v.01'],
    camera: ['M4 8.2h3.2l1.7-2.4h6.2l1.7 2.4H20v10.8H4z', 'M12 16.2a2.9 2.9 0 1 0 0-5.8 2.9 2.9 0 0 0 0 5.8z'],
    check: ['M5 12.6 9.9 17.4 19 7.2'],
    chevronLeft: ['M15 5.5 8.5 12l6.5 6.5'],
    chevronRight: ['M9 5.5 15.5 12 9 18.5'],
    close: ['M6.5 6.5l11 11', 'M17.5 6.5l-11 11'],
    help: [
        'M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17z',
        'M9.4 9.4a2.7 2.7 0 1 1 3.7 2.5c-.7.3-1.1.9-1.1 1.6v.5',
        'M12 17.6v.01',
    ],
    image: [
        'M4 5h16v14H4z',
        'M4 16.5 9 11.5l3.6 3.6 2.4-2.4 5 4.8',
        'M9.1 8.6a1.1 1.1 0 1 0 0 2.2 1.1 1.1 0 0 0 0-2.2z',
    ],
    info: ['M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17z', 'M12 11v5.2', 'M12 7.9v.01'],
    plus: ['M12 5.5v13', 'M5.5 12h13'],
    refresh: ['M19.2 12a7.2 7.2 0 1 1-2.1-5.1', 'M19.5 4.5v4.2h-4.2'],
    search: ['M10.8 4.8a6 6 0 1 0 0 12 6 6 0 0 0 0-12z', 'M15.3 15.3l4.3 4.3'],
    settings: ['M4 7h9', 'M17 7h3', 'M4 17h3', 'M11 17h9', 'M13 4.5v5', 'M7 14.5v5'],
} as const satisfies Record<string, readonly string[]>

export type IconName = keyof typeof GLYPHS

export type IconSize = keyof typeof iconSize

export function Icon({
    name,
    size = 'md',
    color,
}: {
    readonly name: IconName
    readonly size?: IconSize
    readonly color?: string
}): ReactElement {
    const { colors } = useTheme()
    const dimension = iconSize[size]
    return (
        <Svg width={dimension} height={dimension} viewBox="0 0 24 24" fill="none" aria-hidden={true}>
            {GLYPHS[name].map((path) => (
                <Path
                    key={path}
                    d={path}
                    stroke={color ?? colors.ink}
                    strokeWidth={1.8}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                />
            ))}
        </Svg>
    )
}
