import type { CheckResult, ManualSession, ManualStep } from '@truebuild/contracts'
import { stepPartChoices } from '../assembly/question-state'
import { MEDIA_MESSAGES } from '../../media/media-errors'
import { factText } from './fact-text'
import type { WorkflowState } from './controller'
import type { LibraryEntry } from './library'

// Plain, short wording for every default surface. Controller notices and pending text keep their meaning (including
// the recovery they offer) but never leak internal vocabulary. Raw controller strings are only matched here, never shown.

/** The first `count` sentences of a model- or manual-written text. The rest stays available in More. */
export function firstSentences(text: string, count: number): string {
    const parts = text.trim().split(/(?<=[.!?])\s+/u)
    return parts.slice(0, count).join(' ')
}

// Wording the default surface never shows (design spec 8.1). Model-written sentences are plain-worded with exactly
// these swaps and nothing else changes; the meaning is the model's own. The full original wording stays in the
// judge entry's model notes.
const WORD_RULES: readonly (readonly [RegExp, string])[] = [
    [/\b(?:cannot|can(?:'|\u2019)?t|unable to) verify\b/giu, "can't tell"],
    [/\bunresolved\b/giu, 'unclear'],
    [/\bfrozen photo\b/giu, 'your photo'],
    [/\b(?:cited|source) pages?\b/giu, 'manual pages'],
    [/\bsourceRefs\b/gu, 'pictures'],
    [/\bquantity basis\b/giu, 'count'],
    [/\bcarried over\b/giu, 'kept'],
    [/\bpart ids?\b/giu, 'part'],
    [/\b(?:reviewed|extracted|step) facts\b/giu, 'details'],
    [/\bgrounded\b/giu, 'based on the picture'],
    [/\bsynthetic\b|\bsimulated\b|\bdemo data\b/giu, 'sample'],
]

/** Model- or manual-written text with the words the default surface never shows swapped for plain ones. */
export function plainWords(text: string): string {
    return WORD_RULES.reduce(
        (current, [pattern, replacement]) =>
            // A swap at the start of a sentence keeps its capital letter.
            current.replace(pattern, (match) =>
                /^\p{Lu}/u.test(match) ? `${replacement.charAt(0).toUpperCase()}${replacement.slice(1)}` : replacement,
            ),
        text,
    )
}

/** Progress notices the header already says (Step N of M). The default Guide never repeats them as a second sentence. */
export function isProgressNotice(notice: string): boolean {
    return /^Progress saved as your own completion|^Step facts saved|^Review every fact against/u.test(notice)
}

/** What a request in flight is doing, in words a person would use. Null when nothing is in flight. */
export function plainPending(pending: string | null): string | null {
    if (pending === null) {
        return null
    }
    if (pending.startsWith('Reading')) {
        return 'Reading your manual. This can take a minute.'
    }
    if (pending.startsWith('Checking') || pending.startsWith('Freezing')) {
        return 'Checking your photo…'
    }
    if (pending.startsWith('Second opinion')) {
        return 'Taking a second look…'
    }
    if (pending.startsWith('Asking')) {
        return 'Asking…'
    }
    if (pending.startsWith('Saving') || pending.startsWith('Preparing') || pending.startsWith('Choosing')) {
        return 'Saving…'
    }
    return 'Working…'
}

const NOTICE_RULES: readonly (readonly [RegExp, string])[] = [
    [/^Cancelled\./u, 'Stopped, so nothing more will be shown.'],
    [/^Finishing the local save/u, 'Still saving. Please wait a moment.'],
    [
        /^Local library images could not be read|^Local images could not be read/u,
        'We could not open your saved photos. They are still on this phone. Try again.',
    ],
    [/^Could not save on this device/u, 'We could not save on this phone. Your earlier work is safe. Try again.'],
    [/^Local library is read-only/u, 'Saving is paused until your saved builds open again.'],
    [/^Saved photo restored/u, 'Your last photo is shown for reference. Take a new one to check again.'],
    [/^Saved photo is view-only/u, 'Take a new photo before asking.'],
    [
        /^Review and confirm the extracted facts first/u,
        'Answer the quick questions first, then you can check your work.',
    ],
    [/^Review every fact against/u, 'We read your manual. Help us check a few things.'],
    [/^Step facts saved/u, 'Saved. Thanks.'],
    [/^Progress saved as your own completion/u, 'Marked as done. Take a new photo for the next step.'],
    [/^Choose up to \d+ pages/u, 'You can keep up to 20 pages. A retake replaces one page.'],
    [/^Enter a language code/u, 'Pick a reading language.'],
    [/^Manual reading timed out/u, 'Reading took too long. Try again.'],
    [/^Manual reading unavailable/u, 'We could not read those pages. Check your connection and try again.'],
    [/^Camera photo preparation timed out/u, 'The photo took too long. Take a new photo.'],
    [/^Cannot use this camera photo/u, 'We could not use that photo. Check the camera and take a new one.'],
    [/^Cannot verify: photo preparation/u, 'The photo took too long. Take a new photo to try again.'],
    [/^Cannot verify:/u, 'We could not check this step with those pages. Try a clearer photo.'],
    [/^Unavailable \(/u, 'We could not reach the checker. Check your connection and try again.'],
    [/^Question unavailable/u, 'We could not ask that. Check your connection and take a new photo.'],
    [/^Critical facts are missing/u, 'Some details are still missing. Add clearer photos and read your manual again.'],
    [/^This draft belongs to an older/u, 'That changed in the meantime. Open the step and try again.'],
    [/^This step is no longer available/u, 'That step is no longer available. Open your build and try again.'],
    [/^Only an unresolved orientation/u, 'That detail is already filled in.'],
    [
        /^This step has no diagram citation/u,
        'This step has no picture from your manual. Add clearer photos and read again.',
    ],
    [/^Enter /u, 'Write a few words first.'],
    [
        /^Step facts are invalid|^Choose an existing part/u,
        'That does not fit this step. Check the part and keep it under 500 letters.',
    ],
    [/^Read up to \d+ pages/u, 'We can read 8 pages at a time. Remove a few pages and try again.'],
]

const PHOTO_RECOVERY: ReadonlyMap<string, string> = new Map([
    [MEDIA_MESSAGES.permission, 'Photos are blocked. Allow Photos in Settings or take a photo.'],
    [MEDIA_MESSAGES.unsupported, 'Use a JPEG, PNG or WebP photo.'],
    [MEDIA_MESSAGES.unreadable, 'This photo will not open. Save it again as JPEG, PNG or WebP.'],
    [MEDIA_MESSAGES.oversize, 'This photo is too large. Choose a smaller photo.'],
    [MEDIA_MESSAGES.pixels, 'This photo is too large. Choose a smaller photo.'],
    [MEDIA_MESSAGES.generic, 'We could not use that photo. Nothing was sent.'],
])

/** A controller notice in plain words. Unknown notices fall back to a calm generic line rather than internal text. */
export function plainNotice(notice: string): string {
    const photoRecovery = PHOTO_RECOVERY.get(notice)
    if (photoRecovery !== undefined) {
        return photoRecovery
    }
    for (const [pattern, text] of NOTICE_RULES) {
        if (pattern.test(notice)) {
            return text
        }
    }
    return 'Something went wrong. Please try again.'
}

/** A notice that describes a problem rather than progress. Decided on the original text so recovery stays visible. */
export function isProblemNotice(notice: string): boolean {
    if (PHOTO_RECOVERY.has(notice)) {
        return true
    }
    return /unavailable|timed out|could not|not allowed|cannot|not confirmed|nothing was|read-only|invalid|no longer|older manual/iu.test(
        notice,
    )
}

/** The names of this step's parts with known quantities, for the one supporting line under the instruction. */
export function partsLine(session: ManualSession, step: ManualStep): string | null {
    if (step.parts.length === 0) {
        return null
    }
    const labels = new Map(stepPartChoices(session, step).map((choice) => [choice.partId, choice.label]))
    const items = step.parts.map((part) => {
        const name = labels.get(part.partId) ?? 'a part'
        return part.quantity.state === 'known' ? `${name} ×${part.quantity.value}` : name
    })
    return `You need: ${items.join(', ')}`
}

export type GuideSentence = {
    readonly kind:
        'ready' | 'checking' | 'pass' | 'refuse' | 'cannot' | 'answer' | 'blocked' | 'reference' | 'unfinished'
    readonly text: string
}

/** The one sentence under the hero. Check and answer text is shown exactly as returned, never invented. */
export function guideSentence(args: {
    readonly state: Pick<WorkflowState, 'check' | 'answer' | 'pending' | 'capture' | 'storageReadOnly'>
    readonly step: ManualStep | undefined
    readonly blocked: boolean
    // The 1-based position of the first step not yet marked done, when the last step is marked and the person is back on it with nothing to check.
    readonly unfinished?: number | undefined
}): GuideSentence {
    const { state, step, blocked, unfinished } = args
    if (state.pending !== null && state.pending.startsWith('Asking')) {
        return { kind: 'checking', text: 'Asking…' }
    }
    if (state.answer !== null) {
        return { kind: 'answer', text: firstSentences(plainWords(state.answer.answer), 2) }
    }
    const check: CheckResult | null = state.check
    if (check !== null) {
        const reason = firstSentences(plainWords(check.reason), 1)
        if (check.decision === 'pass') {
            return { kind: 'pass', text: `Looks right. ${reason}`.trim() }
        }
        if (check.decision === 'refuse') {
            return { kind: 'refuse', text: `Not yet. ${reason}`.trim() }
        }
        return { kind: 'cannot', text: `We can't tell from this photo. ${reason}`.trim() }
    }
    if (state.pending !== null) {
        return { kind: 'checking', text: plainPending(state.pending) ?? 'Working…' }
    }
    if (blocked) {
        return { kind: 'blocked', text: 'Answer the quick questions first so we can check your work.' }
    }
    if (unfinished !== undefined) {
        return { kind: 'unfinished', text: `Step ${unfinished} is not marked done yet.` }
    }
    if (state.capture !== null) {
        return { kind: 'reference', text: 'Your last photo. Take a new one to check this step.' }
    }
    return { kind: 'ready', text: step?.title ?? 'Pick up where you left off.' }
}

/** True when every step has been marked complete by the person. Says nothing about checks. */
export function allStepsMarked(entry: LibraryEntry): boolean {
    const steps = entry.session.reviewedSteps
    return steps.length > 0 && steps.every((step) => entry.completedStepIds.includes(step.stepId))
}

/** The furthest stop on the happy path for a manual: Add, Quick check, Guide or Done. */
export type Stop = 'pages' | 'overview' | 'guide' | 'done'
export function stopFor(entry: LibraryEntry): Stop {
    const { session } = entry
    if (session.reviewStatus === 'reviewed') {
        return allStepsMarked(entry) ? 'done' : 'guide'
    }
    return session.rawExtraction === null ? 'pages' : 'overview'
}

/** Plain progress line for a manual card: where the person is, without statistics. */
export function progressLine(entry: LibraryEntry): string {
    const { session } = entry
    const total = session.reviewedSteps.length
    switch (stopFor(entry)) {
        case 'done':
            return 'All steps done'
        case 'guide':
            return `Step ${Math.min(entry.stepIndex + 1, total)} of ${total}`
        case 'overview':
            return 'A few questions left'
        case 'pages':
            return session.pages.length === 0 ? 'No photos yet' : 'Ready to read'
    }
}

/** One fact line for More: the manual's own words, with the reason it gave when it did not know. */
export function factLine(label: string, fact: Parameters<typeof factText>[0]): string {
    return `${label}: ${factText(fact, String).replace(/^Unknown: /u, 'The manual does not say. ')}`
}
