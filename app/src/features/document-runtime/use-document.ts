import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import {
    variantsOfV2,
    type ScreenContextInputsV2,
    type ScreenDocumentV2,
    type ScreenVariantV2,
    type VariantState,
} from '@truebuild/contracts'
import { useOptionalWorkflow } from '../capture/workflow-context'
import { capturePlacement } from '../documents/capture-placement'
import { DocumentStore, documentKey, localDocument, type DocumentRuntimeEntry } from './store'
import { isResultLayoutDocument } from './result-layout-runtime'
import { isQuestionLayoutDocument } from './question-layout-runtime'

// Keep the initial skeleton brief. After 15 seconds the shell reports progress while the original request continues;
// a UI grace period is not a provider timeout and must never freeze out a valid page that arrives afterwards.
export const DOCUMENT_FOCUS_GRACE_MS = 15_000

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
    // Verdict/answer truth and its photo are already visible in the local complete document. A compatible deeper
    // composition may arrive later for this exact keyed capture/result without remounting the loaded native photo.
    const shellFirst = inputs.kind === 'quick-check' || inputs.kind === 'result'
    const immediateShell = useMemo<DocumentRuntimeEntry>(
        () => ({ status: 'ready', document: localDocument(inputs, 'busy'), issue: null }),
        [key],
    )
    const progressiveResult =
        (inputs.kind === 'result' || inputs.kind === 'answer') && inputs.captureId !== null && inputs.result !== null
    const entry = store.peek(inputs)
    // A hidden busy Guide can mount before its READY donor arrives; collect that donor without another model call.
    const activityVersion = inputs.kind === 'guide' && inputs.uiState?.busy != null ? version : 0
    const preview = useMemo(() => store.preview(inputs), [store, key, activityVersion])
    // The Question is an editable form. Its complete authored tree stays stable across current capture/activity keys;
    // a cached provider layout must not replace the loaded photo, editor or caret. The cache itself remains untouched.
    const questionPresentation: DocumentRuntimeEntry | undefined = isQuestionLayoutDocument(preview.document)
        ? { ...preview, issue: entry?.issue ?? preview.issue }
        : undefined
    // Every context of one held capture, including a prewarmed activity key or a fresh mount, must begin on the
    // shared authored photo spine. A cached exact response is still eligible when its placement is compatible.
    // Keep the original cache/receipt intact: only this mounted presentation chooses the current witnessed layout.
    const presentation =
        progressiveResult &&
        entry !== undefined &&
        isResultLayoutDocument(preview.document) &&
        capturePlacement(entry.document) !== capturePlacement(preview.document)
            ? { ...entry, document: preview.document }
            : entry
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
    const availablePrior = useMemo<DocumentRuntimeEntry | undefined>(
        () =>
            prior?.exactGeneration === 'pending' && entry === undefined && cacheIssue !== null
                ? { ...prior, exactGeneration: 'unavailable', issue: cacheIssue }
                : prior,
        [prior, entry, cacheIssue],
    )
    // Keep the shown generated document when a late response would remount its photo. Cached incompatible responses
    // remain intact; the authored-spine selection above applies on later mounts too. Retention never crosses keys.
    const preserveGenerated =
        !shellFirst &&
        (options.focused === true || progressiveResult) &&
        prior?.document.metadata.source === 'generated' &&
        (entry?.status !== 'ready' || entry.document.screenId !== prior.document.screenId) &&
        (!progressiveResult ||
            (prior.exactGeneration === undefined && !isResultLayoutDocument(prior.document)) ||
            (entry?.status === 'ready' && capturePlacement(prior.document) !== capturePlacement(entry.document)))
    const current =
        questionPresentation ?? (preserveGenerated ? prior : (presentation ?? availablePrior ?? evicted ?? preview))
    const [progressKey, setProgressKey] = useState<string | null>(null)
    const grace = useRef({ key, elapsed: 0 })
    useEffect(() => {
        // Background preparation belongs to prepareFlow/warmup. A hidden route must not restart cancelled work on blur.
        // Non-ready states are deterministic app composition, never a reason for another model request.
        if (options.focused === true && (options.state === undefined || options.state === 'ready'))
            store.request(inputs)
    }, [store, key, options.focused, options.state])
    useEffect(() => (): void => local.dispose(), [local])
    useEffect(() => {
        if (grace.current.key !== key) {
            grace.current = { key, elapsed: 0 }
            setProgressKey(null)
        }
        if (
            shellFirst ||
            progressiveResult ||
            options.focused !== true ||
            current.status === 'ready' ||
            progressKey === key
        )
            return
        const started = performance.now()
        const timer = setTimeout(
            (): void => setProgressKey(key),
            Math.max(0, DOCUMENT_FOCUS_GRACE_MS - grace.current.elapsed),
        )
        return (): void => {
            clearTimeout(timer)
            grace.current.elapsed += Math.max(0, performance.now() - started)
        }
    }, [key, options.focused, current.status, current.document, progressKey, progressiveResult, shellFirst])
    // Quick-check facts and delivered verdicts never wait for layout composition. The complete deterministic READY
    // shell remains until this exact context has a validated generated document; rejected layouts stay background.
    // Explicit fixture campaigns keep their recorded held-photo spine while the verdict itself is pending.
    // Live preview never resolves a recording and always starts on the deterministic shell above.
    const fixtureResult =
        preview.document.metadata.evidence === 'synthetic-fixture' && isResultLayoutDocument(preview.document)
    const displayed =
        shellFirst && !fixtureResult
            ? presentation?.status === 'ready' && presentation.document.metadata.source === 'generated'
                ? presentation
                : immediateShell
            : current
    useEffect(() => {
        if (!shellFirst || options.focused !== true) return
        console.info(
            JSON.stringify({
                event: 'document_background_composition',
                kind: inputs.kind,
                contextKey: displayed.document.bound.contextKey,
                outcome:
                    displayed.document.metadata.source === 'generated'
                        ? 'swapped'
                        : entry?.status === 'ready'
                          ? 'kept_shell'
                          : 'shell',
                model: entry?.document.metadata.model ?? null,
                effort: entry?.document.metadata.effort ?? null,
                fallbackReason: entry?.status === 'ready' ? entry.document.metadata.fallbackReason : null,
            }),
        )
    }, [shellFirst, options.focused, key, displayed.document, entry?.status, entry?.document])
    // Mounted presentation owns its committed props after cache eviction; no unseen cached payload is retained here.
    useEffect(() => {
        if (displayed.status === 'ready') retained.current = { key, entry: displayed }
        else if (retained.current?.key !== key) retained.current = null
    }, [key, displayed])
    const requested =
        options.state !== undefined && options.state !== 'ready'
            ? options.state
            : !shellFirst && displayed.status === 'pending' && inputs.kind !== 'result' && inputs.kind !== 'answer'
              ? progressKey === key
                  ? 'busy'
                  : 'pending'
              : displayed.document.metadata.fallbackReason === 'timeout' && !progressiveResult && !shellFirst
                ? 'error'
                : 'ready'
    const active = activeDocumentVariant(displayed.document, requested)
    // Fail closed without an explicit focus witness; covered/back-stack previews cannot mint check context.
    useEffect(() => {
        if (displayed.status === 'ready' && active.activeState === 'ready')
            store.noteShown(displayed.document, options.focused === true, inputs)
    }, [store, displayed.document, displayed.status, active.activeState, options.focused, version])
    const retry = useCallback((): void => {
        grace.current = { key, elapsed: 0 }
        setProgressKey(null)
        store.retry(inputs)
        store.request(inputs)
    }, [store, key])
    return { document: displayed.document, ...active, status: displayed.status, issue: displayed.issue, retry }
}
