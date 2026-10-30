import { useCallback, useMemo, useState } from 'react'
import type { ManualSession } from '@truebuild/contracts'
import { editableQuestions, type Question } from '../capture/quick-check-model'

export type QuickProgress = {
    readonly questions: readonly Question[]
    readonly current: Question | undefined
    // The current question's place among all the questions this read started with; 0 when none is showing.
    readonly position: number
    readonly total: number
    readonly skipped: readonly string[]
    readonly skip: (id: string) => void
    readonly unskip: () => void
    // "Question 2 of 5", for the fixed header; undefined when no question is on screen.
    readonly label: string | undefined
}

/**
 * Where the person is in the questions. It is held above the screen so that accepting a fact (which makes a new
 * revision of the manual) keeps the count: after question 1 of 2 comes question 2 of 2. A different manual or a new read
 * of different pages starts the count again.
 */
export function useQuickProgress(session: ManualSession | undefined): QuickProgress {
    const questions = useMemo(() => (session === undefined ? [] : editableQuestions(session)), [session])
    const key =
        session === undefined
            ? ''
            : `${session.manualId}:${session.pages.map((page) => page.pageId).join(',')}:${session.rawExtraction === null ? 'unread' : 'read'}`
    const [progress, setProgress] = useState<{ key: string; total: number; skipped: readonly string[] }>({
        key,
        total: questions.length,
        skipped: [],
    })
    let live = progress
    if (progress.key !== key) {
        live = { key, total: questions.length, skipped: [] }
        setProgress(live)
    }
    const total = Math.max(live.total, questions.length)
    const asking = questions.filter((question) => !live.skipped.includes(question.id))
    const current = asking[0]
    const position = current === undefined ? 0 : total - questions.length + questions.indexOf(current) + 1
    const skip = useCallback(
        (id: string): void => setProgress((now) => ({ ...now, skipped: [...now.skipped, id] })),
        [],
    )
    const unskip = useCallback((): void => setProgress((now) => ({ ...now, skipped: [] })), [])
    const showing = current !== undefined && current.step.sourceRefs.length > 0
    return {
        questions,
        current,
        position,
        total,
        skipped: live.skipped,
        skip,
        unskip,
        label: showing ? `Question ${position} of ${total}` : undefined,
    }
}
