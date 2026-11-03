import type { ManualSession } from './index'

/** The saved title is a placeholder, not a description: nothing, or the app's own "Untitled …" default. */
const PLACEHOLDER_TITLE = /^untitled(?:\s+(?:manual|build))?$/iu

/**
 * The words that name a manual on every screen (the `manual-title` bound text and the library entries). The saved
 * title wins. A blank or "Untitled" title is replaced by a stable description derived only from the manual's own
 * words: the first step's title (reviewed steps, else the raw extraction), else up to two known part names, else the
 * page count. It never names a manufacturer, product or model: only what the manual's pages were read to say.
 */
export function manualDisplayTitleV2(
    session: Pick<ManualSession, 'title' | 'reviewedSteps' | 'rawExtraction' | 'parts' | 'pages'>,
): string {
    const saved = session.title.trim()
    if (saved !== '' && !PLACEHOLDER_TITLE.test(saved)) return saved
    const steps = session.reviewedSteps.length > 0 ? session.reviewedSteps : (session.rawExtraction?.steps ?? [])
    const first = steps.map((step) => step.title.trim()).find((title) => title !== '' && !PLACEHOLDER_TITLE.test(title))
    if (first !== undefined) return first
    const known = (session.parts.length > 0 ? session.parts : (session.rawExtraction?.parts ?? []))
        .flatMap((part) => (part.name.state === 'known' ? [part.name.value.trim()] : []))
        .filter((name) => name !== '')
        .slice(0, 2)
    return known.length > 0 ? known.join(' · ') : `${session.pages.length} page manual`
}

/** Product title for opening status only: never substitute a step, part name or page count. */
export function manualOpeningTitleV2(session: Pick<ManualSession, 'title'>): string | null {
    const title = session.title.trim()
    if (title === '' || PLACEHOLDER_TITLE.test(title)) return null
    const points = Array.from(title)
    return points.length > 40 ? `${points.slice(0, 39).join('')}…` : title
}
