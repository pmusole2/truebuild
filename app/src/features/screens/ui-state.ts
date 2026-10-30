import type { ScreenKind, ScreenUiState } from '@truebuild/contracts'
import { reviewedSession, type WorkflowState } from '../capture/controller'
import type { LibraryEntry } from '../capture/library'
import { stopFor } from '../capture/plain-copy'
import { otherBlockers } from '../capture/quick-check-model'
import type { QuickProgress } from './quick-progress'
import { manualDisplayTitle } from '../documents/manual-title'

const MAX_TITLE = 200
const MAX_REASON = 500
const MAX_QUESTION_PARTS = 12

/** The reading languages the Add screen offers; the codes are the ones the reader already accepts. */
export const READING_LANGUAGE_CODES = ['en', 'es', 'fr', 'de', 'pt-BR'] as const

const clip = (text: string, max: number): string => Array.from(text).slice(0, max).join('')

/**
 * The part of the app's state a composition may bind to: ids, counts and presence only. Nothing the person typed,
 * no photo, no one-use ticket and no raw extraction leaves the device through here.
 */
export function homeUiState(entries: readonly LibraryEntry[]): ScreenUiState {
    const recent = [...entries].sort((a, b) => b.session.updatedAt.localeCompare(a.session.updatedAt))
    return {
        library: {
            entries: recent.slice(0, 100).map((entry) => ({
                manualId: entry.session.manualId,
                title: clip(manualDisplayTitle(entry.session), MAX_TITLE),
                updatedAt: entry.session.updatedAt,
                stopStepId:
                    stopFor(entry) === 'guide' ? (entry.session.reviewedSteps[entry.stepIndex]?.stepId ?? null) : null,
                completed: Math.min(entry.completedStepIds.length, 200),
                total: Math.min(entry.session.reviewedSteps.length, 200),
                firstPageId: entry.session.pages[0]?.pageId ?? null,
            })),
            soleManualId: recent.length === 1 ? (recent[0]?.session.manualId ?? null) : null,
        },
    }
}

export function pagesUiState(entry: LibraryEntry): ScreenUiState {
    const { pages } = entry.session
    return {
        pages: {
            items: pages.slice(0, 20).map((page) => ({ pageId: page.pageId, width: page.width, height: page.height })),
            maxPages: 20,
            canRead: pages.length >= 1,
            languageOptions: [...READING_LANGUAGE_CODES],
        },
    }
}

export function reviewUiState(entry: LibraryEntry, quick: QuickProgress | undefined): ScreenUiState {
    const { session } = entry
    const current = quick?.current
    const asking = current !== undefined && current.step.sourceRefs.length > 0
    const names = new Map(
        session.parts.map((part) => [part.partId, part.name.state === 'known' ? part.name.value : 'A part']),
    )
    return {
        review: {
            currentQuestion: asking
                ? {
                      questionId: current.id,
                      kind: current.kind,
                      stepId: current.step.stepId,
                      stepOrder: current.step.order,
                      reason:
                          current.reason === null || current.reason.trim() === ''
                              ? null
                              : clip(current.reason.trim(), MAX_REASON),
                      parts: current.step.parts.slice(0, MAX_QUESTION_PARTS).map((part) => ({
                          partId: part.partId,
                          label: clip(names.get(part.partId) ?? 'A part', MAX_TITLE),
                      })),
                  }
                : null,
            blockers: Math.min(otherBlockers(session).length, 200),
            canConfirm: reviewedSession(session) !== null,
        },
    }
}

/**
 * The held photo. A composed screen is bound to which photo is held, not to what the person is typing or which part
 * they tapped: those change on every keystroke and would recompose the screen under their hands, so they are sent
 * as "not part of this composition" (no target, no draft). The Ask composer reads the live draft from the controller.
 */
export function captureUiState(state: WorkflowState): ScreenUiState {
    const { capture } = state
    return {
        capture:
            capture === null
                ? null
                : {
                      captureId: capture.binding.captureId,
                      reusable: capture.reusable,
                      target: null,
                      questionDraftPresent: false,
                  },
    }
}

export function moreUiState(options: { readonly tips: boolean }): ScreenUiState {
    return {
        sections: ['how-it-works', 'settings', ...(options.tips ? (['tips'] as const) : []), 'about-this-check'],
    }
}

/** True for the kinds whose composition binds to a held capture. */
export const CAPTURE_STATE_KINDS: ReadonlySet<ScreenKind> = new Set(['questions', 'result', 'answer', 'recovery'])
