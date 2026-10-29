import type { CoachCandidate } from './coach-types'

// The final wording of every tip. Sentences stay at twelve words or fewer, and nothing here may promise a control the
// screen does not have: there is no Yes in Quick check and no Done in Pages.
export const MAX_TIPS_PER_SCREEN = 4

const control = (id: string, heading: string, sentence: string): CoachCandidate => ({
    id,
    kind: 'control',
    heading,
    sentence,
})
const surface = (id: string, heading: string, sentence: string): CoachCandidate => ({
    id,
    kind: 'surface',
    heading,
    sentence,
})

export const MORE_TIP_ID = 'header-more'

export type HomeFacts = {
    // The primary is the Add manual action.
    readonly add: boolean
    // The primary resumes the sole manual.
    readonly resume: boolean
    readonly more: boolean
}

export function homeCandidates(facts: HomeFacts): readonly CoachCandidate[] {
    return [
        facts.add ? control('home-add', 'Start here', 'Tap here to add your paper manual.') : null,
        facts.resume ? control('keep-building', 'Keep going', 'Tap here to pick up where you left off.') : null,
        facts.more ? control(MORE_TIP_ID, 'More help', 'Tap More for help and settings.') : null,
    ].filter((tip) => tip !== null)
}

export type PagesFacts = {
    readonly pages: number
    // Not busy, not full, and not read-only.
    readonly open: boolean
    // Read my manual can be tapped.
    readonly canRead: boolean
}

export function pagesCandidates(facts: PagesFacts): readonly CoachCandidate[] {
    if (facts.pages === 0) {
        return facts.open
            ? [
                  control('take-page-photo', 'First page', 'Take a photo of each page.'),
                  control('choose-pages', 'Already have photos?', 'You can also pick photos you already took.'),
              ]
            : []
    }
    return [
        facts.canRead
            ? control('read-manual', 'When you are ready', 'When every page is here, tap Read my manual.')
            : null,
        facts.open ? control('add-page', 'Missed a page?', 'Tap here to add one more page.') : null,
    ].filter((tip) => tip !== null)
}

export type QuickCheckFacts = { readonly state: 'asking' | 'blocked' | 'ready' | 'none' }

export function quickCheckCandidates({ state }: QuickCheckFacts): readonly CoachCandidate[] {
    switch (state) {
        case 'asking':
            return [
                control('quick-check-fix', 'Your turn', 'Not sure? Write what the picture shows.'),
                control('quick-check-skip', 'No rush', 'You can skip and come back later.'),
            ]
        case 'blocked':
            return [control('quick-check-clearer', 'One more photo', 'Add a clearer photo to continue.')]
        case 'ready':
            return [control('quick-check-start', 'Ready', 'Tap Start building when you are ready.')]
        case 'none':
            return []
    }
}

/** The Guide primary's tip comes from the label that is actually on the button. Null means do not coach it. */
export function guidePrimarySentence(label: string | null): string | null {
    if (label === null) return null
    if (/^Go to step \d+$/u.test(label)) return 'Tap here to go to the step that is not done.'
    switch (label) {
        case 'Take photo':
            return 'Take a photo to check your work.'
        case 'Take another photo':
            return 'Take another photo to check again.'
        case 'Next step':
            return 'Tap Next step when this looks right.'
        case 'Finish':
            return 'Tap Finish when this looks right.'
        case 'Answer questions':
            return 'Answer the quick questions to continue.'
        case 'Add clearer photos':
            return 'Add clearer photos to continue.'
        default:
            return null
    }
}

export type GuideFacts = {
    readonly hero: boolean
    // The live label of an enabled primary; null when it is busy, disabled or absent.
    readonly primaryLabel: string | null
    readonly swipe: boolean
    readonly more: boolean
}

export function guideCandidates(facts: GuideFacts): readonly CoachCandidate[] {
    const primary = guidePrimarySentence(facts.primaryLabel)
    return [
        facts.hero ? surface('guide-hero', 'The picture', 'This picture shows what to build.') : null,
        primary === null ? null : control('guide-primary', 'The big button', primary),
        facts.swipe ? surface('guide-hero-frame', 'Other steps', 'Swipe sideways to see other steps.') : null,
        facts.more ? control(MORE_TIP_ID, 'Everything else', 'Tap More for the full step and help.') : null,
    ].filter((tip) => tip !== null)
}

export type CameraFacts = { readonly intent: 'page' | 'part' | null }

export function cameraCandidates({ intent }: CameraFacts): readonly CoachCandidate[] {
    if (intent === null) return []
    return [
        control(
            'camera-shutter',
            'Take the photo',
            intent === 'page' ? 'Tap here when one page fills the frame.' : 'Tap here when the part fills the frame.',
        ),
    ]
}

/** The accessible name a tip gives to its target proxy when the real control supplied none. */
export const TARGET_HINT = 'Double-tap to use it.'
