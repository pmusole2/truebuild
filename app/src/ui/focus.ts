import { useState } from 'react'
import { Platform, type ViewStyle } from 'react-native'
import type { Colors } from '../theme/tokens'

// Keyboard focus on web is shown as a visible ring. It is reported on focus, so a pointer click also rings: the browser
// gives no reliable keyboard-only signal to inline styles. Native platforms keep their system focus treatment.
export function useFocusRing(): {
    readonly focused: boolean
    readonly focusHandlers: { readonly onFocus: () => void; readonly onBlur: () => void }
} {
    const [focused, setFocused] = useState(false)
    return {
        focused,
        focusHandlers: {
            onFocus: (): void => setFocused(true),
            onBlur: (): void => setFocused(false),
        },
    }
}

export function focusRingStyle(focused: boolean, colors: Colors): ViewStyle {
    if (!focused || Platform.OS !== 'web') {
        return {}
    }
    return { boxShadow: `0 0 0 2px ${colors.surface}, 0 0 0 4px ${colors.focus}` }
}
