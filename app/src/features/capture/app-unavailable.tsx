import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import { reloadAppAsync } from 'expo'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { APP_RELOAD_WAIT_COPY_V2, buildFallbackDocumentV2, screenDocumentV2Schema } from '@truebuild/contracts'
import { DocumentRoot } from '../documents/document-renderer'
import { DocumentRouteBoundary, useDocumentOwner } from '../documents/ownership'
import { sha256Hex } from '../documents/sha256'
import type { FrameBindings } from '../documents/types'
import { useJudge } from '../screens/judge-context'

const HOME_UNAVAILABLE = 'Home is unavailable until the app opens.'
const STARTUP_NOTICE = 'Couldn’t open TrueBuild. Try again.'
const RELOAD_NOTICE = 'Close and reopen TrueBuild.'

/** The initialization boundary has no controller yet; its only earned recovery capability is an explicit app reload. */
export function AppUnavailableScreen(): ReactElement {
    return (
        <DocumentRouteBoundary>
            <StartupRecoveryDocument />
        </DocumentRouteBoundary>
    )
}

function StartupRecoveryDocument(): ReactElement {
    const insets = useSafeAreaInsets()
    const { showBuilt } = useJudge()
    const [reloading, setReloading] = useState(false)
    const [reloadFailed, setReloadFailed] = useState(false)
    const inFlight = useRef(false)
    const mounted = useRef(true)
    useEffect(() => {
        mounted.current = true
        return (): void => {
            mounted.current = false
        }
    }, [])
    const document = useMemo(
        () =>
            screenDocumentV2Schema.parse(
                buildFallbackDocumentV2(
                    {
                        kind: 'error',
                        session: null,
                        stepId: null,
                        captureId: null,
                        result: null,
                        failure: 'provider_error',
                        uiState: { failure: { notice: true } },
                    },
                    { sha256Hex, now: () => new Date(), reason: 'provider_error', evidence: 'local-deterministic' },
                ),
            ),
        [],
    )
    useDocumentOwner(document, true, 'ready')
    const retry = (): void => {
        if (inFlight.current) return
        inFlight.current = true
        setReloading(true)
        void (async (): Promise<void> => {
            try {
                await reloadAppAsync()
            } catch {
                // Only the failure to reopen is known. Raw initialization/reload errors never become copy or logs.
                if (mounted.current) setReloadFailed(true)
            } finally {
                inFlight.current = false
                if (mounted.current) setReloading(false)
            }
        })()
    }
    const notice = `${reloadFailed ? RELOAD_NOTICE : STARTUP_NOTICE} ${HOME_UNAVAILABLE}`
    const bindings: FrameBindings = {
        resolve: (intent) =>
            intent.intent === 'retry' && intent.target === 'last-action'
                ? { enabled: !reloading, reason: null, run: retry }
                : { enabled: false, reason: HOME_UNAVAILABLE, run: (): void => undefined },
        live: null,
        session: undefined,
        pageUris: {},
        capture: null,
        marks: [],
        heroMode: 'inline',
        insetTop: insets.top,
        inspect: showBuilt,
        workInProgress: reloading,
        preparingDocument: reloading,
        waitCopy: APP_RELOAD_WAIT_COPY_V2,
        preparationLabel: APP_RELOAD_WAIT_COPY_V2.action,
        operationNotice: notice,
        resolveText: (ref) =>
            ref.kind === 'literal' ? ref.text : ref.kind === 'bound' && ref.key === 'operation-notice' ? notice : '',
    }
    return <DocumentRoot document={document} bindings={bindings} variant="ready" testID="app-unavailable-screen" />
}
