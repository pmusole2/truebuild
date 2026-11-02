import { useWindowDimensions } from 'react-native'

// From this system text scale up, fixed controls and chrome switch to their short forms so the text a person reads
// keeps the room. Text itself is never capped or shrunk; only the labels beside it get shorter.
export const LARGE_TEXT_SCALE = 2

export function isLargeText(fontScale: number): boolean {
    return fontScale >= LARGE_TEXT_SCALE
}

/** True at accessibility text sizes, measured from the live system scale (it is not assumed to stop at any ceiling). */
export function useLargeText(): boolean {
    return isLargeText(useWindowDimensions().fontScale)
}
