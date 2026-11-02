import { useEffect, useRef, type ReactElement, type ReactNode } from 'react'
import { useFeedback, type HapticKind } from './feedback'

/**
 * One best-effort notification for a new result. The sentence itself appears at once: the only result motion is the
 * Guide's single icon reveal, so the text never rises or fades in competition with it. Metadata and preference changes
 * stay quiet.
 */
export function ResultReveal({
    identity,
    feedback,
    children,
}: {
    readonly identity: string
    readonly feedback: HapticKind
    readonly children: ReactNode
}): ReactElement {
    const { haptic } = useFeedback()
    const seen = useRef<string | null>(null)
    useEffect(() => {
        if (seen.current === identity) return
        seen.current = identity
        haptic(feedback)
    }, [identity, feedback, haptic])
    return <>{children}</>
}
