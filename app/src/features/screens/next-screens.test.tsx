import type { WorkflowState } from '../capture/controller'
import type { LibraryEntry } from '../capture/library'
import { entry as flowEntry } from './test-support/route-harness'
import { specKey } from './screen-spec'
import { nextScreenSpecs } from './slots'

const idle: WorkflowState = {
    route: 'library',
    entries: [],
    selectedId: null,
    pending: null,
    notice: null,
    loading: false,
    storageReadOnly: false,
    cameraIntent: null,
    capture: null,
    check: null,
    answer: null,
    question: '',
    target: null,
    pageUris: {},
}
const withEntries = (entries: LibraryEntry[], rest: Partial<WorkflowState> = {}): WorkflowState => ({
    ...idle,
    entries,
    ...rest,
})
const kinds = (specs: ReturnType<typeof nextScreenSpecs>): string[] => specs.map((spec) => spec.kind)

describe('the screens predicted from facts the app already holds', () => {
    it('Home predicts the stop of a sole build and nothing for several, a loading or a read-only library', () => {
        const unread = flowEntry('unread', 'unparsed')
        const reviewed = flowEntry('reviewed', 'reviewed', 3)
        const finished = { ...flowEntry('finished', 'reviewed', 2), completedStepIds: ['step-1', 'step-2'] }
        expect(kinds(nextScreenSpecs('home', withEntries([unread]), undefined))).toEqual(['pages'])
        expect(kinds(nextScreenSpecs('home', withEntries([reviewed]), undefined))).toEqual(['guide'])
        expect(kinds(nextScreenSpecs('home', withEntries([finished]), undefined))).toEqual(['completion'])
        expect(nextScreenSpecs('home', withEntries([reviewed, unread]), undefined)).toEqual([])
        expect(nextScreenSpecs('home', withEntries([reviewed], { loading: true }), undefined)).toEqual([])
        expect(nextScreenSpecs('home', withEntries([reviewed], { storageReadOnly: true }), undefined)).toEqual([])
    })

    it('does not guess the quick check, which needs the question being asked', () => {
        const raw = flowEntry('raw', 'unreviewed', 3)
        expect(nextScreenSpecs('home', withEntries([raw]), undefined)).toEqual([])
    })

    it('Add predicts reading only for pages that are there, not yet read, with nothing running', () => {
        const unread = flowEntry('unread', 'unparsed')
        const reviewed = flowEntry('reviewed', 'reviewed', 3)
        expect(kinds(nextScreenSpecs('pages', withEntries([unread]), unread))).toEqual(['reading'])
        expect(nextScreenSpecs('pages', withEntries([reviewed]), reviewed)).toEqual([])
        expect(nextScreenSpecs('pages', withEntries([unread], { pending: 'Reading…' }), unread)).toEqual([])
        expect(nextScreenSpecs('pages', withEntries([]), undefined)).toEqual([])
    })

    it('Guide leaves the next step to the precompute and predicts done only when the last mark is the one missing', () => {
        const middle = flowEntry('reviewed', 'reviewed', 3)
        expect(nextScreenSpecs('guide', withEntries([middle]), middle)).toEqual([])
        const lastOpen = { ...flowEntry('reviewed', 'reviewed', 3), stepIndex: 2, completedStepIds: ['step-1'] }
        expect(nextScreenSpecs('guide', withEntries([lastOpen]), lastOpen)).toEqual([])
        const last = { ...lastOpen, completedStepIds: ['step-1', 'step-2'] }
        const [done] = nextScreenSpecs('guide', withEntries([last]), last)
        expect(done?.kind).toBe('completion')
        expect(done?.completedStepIds).toEqual(['step-1', 'step-2', 'step-3'])
    })

    it('never shares a key across another revision or page content', () => {
        const base = flowEntry('reviewed', 'reviewed', 3)
        const last = { ...base, stepIndex: 2, completedStepIds: ['step-1', 'step-2'] }
        const [first] = nextScreenSpecs('guide', withEntries([last]), last)
        const revised = { ...last, session: { ...last.session, revision: last.session.revision + 1 } }
        const [second] = nextScreenSpecs('guide', withEntries([revised]), revised)
        const rePaged = {
            ...last,
            session: {
                ...last.session,
                pages: last.session.pages.map((page) => ({ ...page, contentHash: 'b'.repeat(64) })),
            },
        }
        const [third] = nextScreenSpecs('guide', withEntries([rePaged]), rePaged)
        expect(new Set([first, second, third].map((spec) => specKey(spec!))).size).toBe(3)
    })
})
