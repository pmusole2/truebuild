import type { AppIntent, ScreenKind } from '@truebuild/contracts'

/**
 * The stable test and coach identity of a composed bar action. A document words the action and picks its intent; the
 * identity follows what the action does on this screen, so automation and the coach keep finding "the add button" or
 * "the guide primary" whatever the label says. Undefined means the action has no existing identity.
 */
export function barTestId(kind: ScreenKind, role: 'primary' | 'secondary', intent: AppIntent): string | undefined {
    switch (kind) {
        case 'home':
            if (intent.intent === 'navigate' && intent.target === 'add') return 'home-add'
            if (intent.intent === 'navigate' && intent.target === 'guide') return 'keep-building'
            return undefined
        case 'add':
        case 'pages':
            if (intent.intent === 'capture') {
                return intent.target === 'take-photo'
                    ? 'take-page-photo'
                    : intent.target === 'choose-pages'
                      ? 'choose-pages'
                      : intent.target === 'add-page'
                        ? 'add-page'
                        : undefined
            }
            if (intent.intent === 'confirm' && intent.target === 'reading') return 'read-manual'
            return undefined
        case 'reading':
            return intent.intent === 'confirm' || intent.intent === 'retry' ? 'retry-reading' : undefined
        case 'quick-check':
            if (intent.intent === 'confirm' && (intent.target === 'facts' || intent.target === 'manual')) {
                return 'quick-check-start'
            }
            if (intent.intent === 'navigate' && intent.target === 'pages') return 'quick-check-clearer'
            return undefined
        case 'guide':
        case 'result':
        case 'questions':
        case 'answer':
        case 'recovery':
        case 'error':
            return role === 'primary' ? 'guide-primary' : undefined
        case 'completion':
            return role === 'primary' ? 'done-home' : undefined
        case 'more':
            return intent.intent === 'open-details' && intent.target === 'about-check' ? 'judge-entry' : undefined
    }
}
