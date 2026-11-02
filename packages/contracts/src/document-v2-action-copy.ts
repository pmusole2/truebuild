import type { AppIntent, INTENT_TARGETS } from './screen'

type TargetOf<I extends AppIntent['intent']> = (typeof INTENT_TARGETS)[I][number]
type Labels = { [I in AppIntent['intent']]: { [T in TargetOf<I>]: readonly string[] } }

export const ACTION_LABELS_V2: Labels = {
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
