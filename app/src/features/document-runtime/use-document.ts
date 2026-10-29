import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import {
    variantsOfV2,
    type ScreenContextInputsV2,
    type ScreenDocumentV2,
    type ScreenVariantV2,
    type VariantState,
} from '@truebuild/contracts'
import { useOptionalWorkflow } from '../capture/workflow-context'
import { DocumentStore, documentKey, localDocument, type DocumentRuntimeEntry } from './store'

export const DOCUMENT_FOCUS_GRACE_MS = 8_000

export interface DocumentReading {
    readonly document: ScreenDocumentV2
    readonly variant: ScreenVariantV2
    readonly activeState: 'ready' | VariantState
    readonly status: DocumentRuntimeEntry['status']
    readonly issue: string | null
    readonly retry: () => void
}

export function activeDocumentVariant(
    document: ScreenDocumentV2,
    state: 'ready' | VariantState,
): { variant: ScreenVariantV2; activeState: 'ready' | VariantState } {
    const variants = variantsOfV2(document)
    const selected = variants.find((candidate) => candidate.name === state) ?? variants[0]!
    return { variant: selected.variant, activeState: selected.name }
}

/** Always returns the actual complete v2 document and its active full variant. No v1 slot/frame conversion. */
export function useDocument(
    inputs: ScreenContextInputsV2,
    options: { readonly state?: 'ready' | VariantState; readonly focused?: boolean } = {},
): DocumentReading {
    const workflow = useOptionalWorkflow()
    const [local] = useState((): DocumentStore => new DocumentStore({ mode: 'off', id: (): string => 'local' }))
    const store = workflow?.documents ?? local
    const version = useSyncExternalStore(store.subscribe, store.getVersion, store.getVersion)
    const key = documentKey(inputs)
    // Verdict/answer truth and its photo are already visible in the local complete document. The deeper composition
    // may arrive later for this exact keyed capture/result; it must not make the person leave and reopen that result.
    const progressiveResult =
        (inputs.kind === 'result' || inputs.kind === 'answer') && inputs.captureId !== null && inputs.result !== null
    const entry = store.peek(inputs)
    const preview = useMemo(() => store.preview(inputs), [store, key])
    const cacheIssue = entry === undefined ? store.cacheIssue(inputs) : null
    const evicted = useMemo<DocumentRuntimeEntry | null>(
        () =>
            cacheIssue === null
                ? null
                : { status: 'ready', document: localDocument(inputs, 'busy'), issue: cacheIssue },
        [key, cacheIssue],
    )
    const retained = useRef<{ key: string; entry: DocumentRuntimeEntry } | null>(null)
    const prior = retained.current?.key === key ? retained.current.entry : undefined
    const preserveGenerated =
        options.focused === true &&
        prior?.document.metadata.source === 'generated' &&
        (entry?.status !== 'ready' || entry.document.screenId !== prior.document.screenId)
    const current = preserveGenerated ? prior : (entry ?? prior ?? evicted ?? preview)
    const [frozen, setFrozen] = useState<{ key: string; entry: DocumentRuntimeEntry } | null>(null)
    const grace = useRef({ key, elapsed: 0 })
    useEffect(() => {
        // An evicted background preview stays terminal until focus or an explicit Retry.
        if (options.focused === true || store.cacheIssue(inputs) === null) store.request(inputs)
    }, [store, key, options.focused])
    useEffect(() => (): void => local.dispose(), [local])
    useEffect(() => {
        if (grace.current.key !== key) {
            grace.current = { key, elapsed: 0 }
            setFrozen(null)
        }
        if (progressiveResult) return
        if (options.focused !== true) {
            // A late cached document is eligible when the screen next becomes visible, never under active editing.
            if (current.status === 'ready') setFrozen(null)
            return
        }
        if (
            (current.status === 'ready' &&
                (current.document.metadata.source === 'generated' ||
                    current.document.metadata.fallbackReason === 'disabled')) ||
            frozen?.key === key
        )
            return
        const started = performance.now()
        const timer = setTimeout(
            (): void => {
                const cached = store.peek(inputs)
                if (cached?.status === 'ready' && cached.document.metadata.source === 'generated') return
                setFrozen({
                    key,
                    entry:
                        cached?.status === 'ready'
                            ? cached
                            : current.status === 'ready'
                              ? current
                              : { status: 'ready', document: localDocument(inputs, 'timeout'), issue: 'timeout' },
                })
            },
            Math.max(0, DOCUMENT_FOCUS_GRACE_MS - grace.current.elapsed),
        )
        return (): void => {
            clearTimeout(timer)
            grace.current.elapsed += Math.max(0, performance.now() - started)
        }
    }, [store, key, options.focused, current.status, current.document, frozen, progressiveResult])
    const displayed = !progressiveResult && frozen?.key === key ? frozen.entry : current
    // Mounted presentation owns its committed props after cache eviction; no unseen cached payload is retained here.
    useEffect(() => {
        if (displayed.status === 'ready') retained.current = { key, entry: displayed }
        else if (retained.current?.key !== key) retained.current = null
    }, [key, displayed])
    const requested =
        options.state !== undefined && options.state !== 'ready'
            ? options.state
            : displayed.status === 'pending' && inputs.kind !== 'result' && inputs.kind !== 'answer'
              ? 'pending'
              : 'ready'
    const active = activeDocumentVariant(displayed.document, requested)
    // Fail closed without an explicit focus witness; covered/back-stack previews cannot mint check context.
    useEffect(() => {
        if (displayed.status === 'ready' && active.activeState === 'ready')
            store.noteShown(displayed.document, options.focused === true, inputs)
    }, [store, displayed.document, displayed.status, active.activeState, options.focused, version])
    const retry = useCallback((): void => {
        grace.current = { key, elapsed: 0 }
        setFrozen(null)
        store.retry(inputs)
        store.request(inputs)
    }, [store, key])
    return { document: displayed.document, ...active, status: displayed.status, issue: displayed.issue, retry }
}
