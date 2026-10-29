import type { AppIntent, INTENT_TARGETS, ScreenKind, TIP_TARGETS } from '@truebuild/contracts'

import type { GroundingContext } from './context'
import { normalize } from './text'

/**
 * Nonfactual interface copy, separate from manual facts. A model may choose among these wordings; it can never put a
 * factual claim in a label, heading or tip, because the registry is closed. Factual text must instead be a complete
 * evidence unit of the manual or result (see `context.ts`). The first entry of each list is the canonical wording the
 * server substitutes when a model's wording is not listed.
 */
type TargetOf<I extends AppIntent['intent']> = (typeof INTENT_TARGETS)[I][number]
type Labels = { [I in AppIntent['intent']]: { [T in TargetOf<I>]: readonly string[] } }

export const ACTION_LABELS: Labels = {
    navigate: {
        home: ['Home', 'Back to home'],
        add: ['Add a manual', 'Add manual'],
        pages: ['Your pages', 'Back to pages', 'Pages'],
        reading: ['Reading'],
        'quick-check': ['Quick check'],
        guide: ['Continue building', 'Back to step', 'Continue', 'Back to the guide'],
        done: ['Finish', 'Done'],
        more: ['More'],
        back: ['Back', 'Close'],
    },
    capture: {
        'take-photo': ['Take photo', 'Take a photo', 'Photo'],
        'choose-pages': ['Choose photos', 'Choose pages'],
        'add-page': ['Add page', 'Add a page'],
        retake: ['Retake photo', 'Take another photo', 'Retake'],
    },
    check: { 'current-step': ['Check this step', 'Check my work', 'Check'] },
    ask: {
        'about-step': ['Ask about this step', 'Ask', 'Ask another', 'Ask a question'],
        'about-part': ['Ask about this part'],
    },
    confirm: {
        reading: ['Read manual', 'Read the manual'],
        facts: ['Looks right', 'Yes, looks right'],
        step: ['Next step', 'Go to the next step'],
        manual: ['Finish manual'],
        'camera-permission': ['Allow camera'],
    },
    retry: {
        'last-action': ['Try again', 'Retry'],
        reading: ['Read again', 'Read the manual again'],
        check: ['Check again'],
        question: ['Ask again'],
        screen: ['Try again', 'Refresh'],
        camera: ['Try camera again'],
    },
    'open-details': {
        step: ['Step details', 'Details'],
        result: ['Details', 'Why?'],
        sources: ['See the manual', 'Manual pages'],
        'about-check': ['About this check'],
        'device-settings': ['Open settings', 'Open device settings'],
    },
    'show-tips': { screen: ['Show tips', 'Tips', 'Show tips again'] },
}

function labelsFor(intent: AppIntent): readonly string[] {
    const table = ACTION_LABELS[intent.intent] as Readonly<Record<string, readonly string[]>>
    return table[intent.target] ?? []
}

export function canonicalLabel(intent: AppIntent): string {
    return labelsFor(intent)[0] ?? 'Continue'
}

/** The model's wording if the registry lists it for this action, else the canonical wording. */
export function actionLabel(label: string, intent: AppIntent): { label: string; replaced: boolean } {
    const wanted = normalize(label)
    const listed = labelsFor(intent).find((candidate) => normalize(candidate) === wanted)
    return listed === undefined ? { label: canonicalLabel(intent), replaced: true } : { label: listed, replaced: false }
}

/** Closed wording for the full-screen blocks. A model wording that is not listed is replaced by the first entry. */
export const EMPTY_LIBRARY_TEXT = ['No manuals yet.', 'Add a manual to start building.'] as const
export const FACT_PROMPTS = {
    orientation: ['Which way does this part face?', 'How should this part sit?'],
    checks: ['What should you see when this step is done?', 'What should be visible?'],
} as const
export const FACT_EDITOR_LABELS = {
    orientation: ['Orientation', 'Which way it faces'],
    checks: ['What to look for', 'Visible check'],
} as const
export const FACT_SAVE_LABELS = ['Save', 'Looks right'] as const
export const FACT_CANCEL_LABELS = ['Cancel', 'Not now'] as const
export const QUESTION_PROMPTS = ['Ask anything about this step.', 'What would you like to know?'] as const
export const QUESTION_SUBMIT_LABELS = ['Ask', 'Send', 'Ask about this step'] as const
export const SOURCE_LABELS = ['Manual pages', 'See the manual', 'Sources'] as const
export const CAMERA_CUES = ['Keep the whole step in view', 'Hold steady', 'Fill the frame with your work'] as const
export const CAMERA_PILLS = ['Step in view', 'Ready'] as const

/** The model's wording if the registry lists it, else the first (canonical) entry. */
export function listedCopy(wanted: string, registry: readonly string[]): { text: string; replaced: boolean } {
    const listed = registry.find((candidate) => normalize(candidate) === normalize(wanted))
    return listed === undefined ? { text: registry[0] ?? wanted, replaced: true } : { text: listed, replaced: false }
}

export const DETAILS_LABELS = ['More', 'More detail', 'Details', 'More fixes', 'What is missing'] as const
export const CHOICE_PROMPTS = ['What next?', 'Choose one', 'Choose'] as const
export const MORE_LABEL = 'More'

export function headerTitles(context: GroundingContext): string[] {
    const step = context.step
    switch (context.kind) {
        case 'home':
            return ['Your manuals', 'Home']
        case 'add':
            return ['Add a manual']
        case 'pages':
            return ['Your pages', 'Pages']
        case 'reading':
            return ['Reading your manual']
        case 'quick-check':
            return ['Quick check']
        case 'guide':
            return step ? [`Step ${step.order}`, `Step ${step.order} of ${context.stepCount}`] : ['This step']
        case 'result':
            return context.decision === 'pass'
                ? ['Looks right']
                : context.decision === 'refuse'
                  ? ['Not quite right']
                  : ['Cannot tell yet']
        case 'questions':
            return ['Ask about this step']
        case 'answer':
            return ['Answer']
        case 'more':
            return ['More', 'Settings and help']
        case 'completion':
            return context.completion === 'witnessed' ? ['All steps done'] : ['Your build']
        case 'error':
            return ['Something went wrong']
        case 'recovery':
            return ['Fix this step']
    }
}

const FAILURE_TEXT: Readonly<Record<string, string>> = {
    unconfigured: 'Smart help is not set up here yet. You can keep going without it.',
    unauthorized: 'This device could not connect. Check the app settings and try again.',
    invalid_input: 'Something about that request did not look right. Try again.',
    timeout: 'That took too long. Try again in a moment.',
    provider_error: 'Smart help is unavailable right now. Try again in a moment.',
    invalid_output: 'We could not use the answer we got. Try again.',
}

export function failureText(failure: string | null): string {
    return FAILURE_TEXT[failure ?? 'provider_error'] ?? FAILURE_TEXT.provider_error ?? ''
}

/** Nonfactual instruction copy per screen kind. Manual facts are never in this list. */
export function instructionCopy(context: GroundingContext): string[] {
    const { session } = context
    const kind: ScreenKind = context.kind
    switch (kind) {
        case 'home':
            return [session ? 'Pick up where you left off.' : 'Add a manual to start building.']
        case 'add':
            return ['Photograph each page of your manual, one at a time.']
        case 'pages': {
            const count = session?.pages.length ?? 0
            return [
                count > 0 ? `${count} ${count === 1 ? 'page is' : 'pages are'} ready to read.` : 'Add a page to begin.',
            ]
        }
        case 'reading':
            return ['Reading each page. This can take a minute.']
        case 'quick-check':
            return ['Check what we read before you start building.']
        case 'questions':
            return ['Ask anything about this step.']
        case 'more':
            return ['Settings and help.']
        case 'completion':
            return context.completion === 'witnessed'
                ? [`You finished all ${context.stepCount} steps.`]
                : ['Check each step, then finish.']
        case 'error':
            return [failureText(context.failure)]
        case 'recovery':
            return ['Compare with the diagram, then try again.']
        case 'guide':
        case 'result':
        case 'answer':
            return []
    }
}

/** Coach-mark copy per existing target. A tip is accepted only with exactly this wording. */
export const TIP_COPY: Readonly<Record<(typeof TIP_TARGETS)[number], { heading: string; text: string }>> = {
    'home-add': { heading: 'Add a manual', text: 'Start here to add the manual you are building from.' },
    'keep-building': { heading: 'Keep building', text: 'Pick up your current manual from here.' },
    'header-more': { heading: 'More', text: 'Settings and help are here.' },
    'take-page-photo': { heading: 'Take a page photo', text: 'Photograph one manual page at a time.' },
    'choose-pages': { heading: 'Choose photos', text: 'Pick page photos you already have.' },
    'read-manual': { heading: 'Read the manual', text: 'When every page is added, read the manual.' },
    'add-page': { heading: 'Add a page', text: 'Add another page if one is missing.' },
    'quick-check-fix': { heading: 'Fix a detail', text: 'Change anything that was read wrongly.' },
    'quick-check-skip': { heading: 'Skip', text: 'Skip a detail you do not need to check.' },
    'quick-check-clearer': { heading: 'Clearer photo', text: 'A clearer page photo can improve the reading.' },
    'quick-check-start': { heading: 'Start building', text: 'Start when the details look right.' },
    'guide-hero': { heading: 'The diagram', text: 'Compare the diagram with what you are building.' },
    'guide-primary': { heading: 'Check your work', text: 'Take a photo of your work to check this step.' },
    'guide-hero-frame': { heading: 'Frame the photo', text: 'Keep the whole step in view.' },
    'camera-shutter': { heading: 'Take the photo', text: 'Tap to take the photo.' },
}
