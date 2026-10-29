// Preserve the accepted native Back strip and step-swipe thresholds.
export const EDGE_RESERVE = 28
export const STEP_SWIPE_DISTANCE = 56
export function startsAtSystemEdge(startX: number, width: number, rtl: boolean): boolean {
    return rtl ? startX > width - EDGE_RESERVE : startX < EDGE_RESERVE
}

/** Android can start system Back from either side; iOS reserves only its native leading strip. */
export function startsAtStepSystemEdge(startX: number, width: number, rtl: boolean, platform: string): boolean {
    return platform === 'android'
        ? startX < EDGE_RESERVE || startX > width - EDGE_RESERVE
        : platform === 'ios' && startsAtSystemEdge(startX, width, rtl)
}
