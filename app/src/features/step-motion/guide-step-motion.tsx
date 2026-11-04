import { useEffect, useMemo, useState, type ReactElement, type ReactNode } from 'react'
import type { ManualSession, StepMotionScene } from '@truebuild/contracts'
import { ModelApiClient } from '../../api/model-client'
import { API_BASE_URL, API_SECRET, DEMO_MODE, GENERATIVE_UI } from '../../config'
import type { KeyValueStorage } from '../capture/library'
import { aiConsent } from '../consent/consent-runtime'
import { motionRequestForStep, StepMotionRegistry, stepMotionCacheKey } from './step-motion-registry'
import { StepMotionHint, type StepMotionAvailability } from './step-motion-hint'

const storage: KeyValueStorage = {
    getItem: async (key) => (await import('../capture/device-storage')).deviceStorage.getItem(key),
    setItem: async (key, value) => (await import('../capture/device-storage')).deviceStorage.setItem(key, value),
    removeItem: async (key) => (await import('../capture/device-storage')).deviceStorage.removeItem(key),
    getAllKeys: async () => (await import('../capture/device-storage')).deviceStorage.getAllKeys(),
}
let runtime: StepMotionRegistry | undefined
function registry(): StepMotionRegistry {
    if (runtime === undefined) {
        const client = new ModelApiClient({ baseUrl: API_BASE_URL, secret: API_SECRET })
        runtime = new StepMotionRegistry(
            storage,
            (request, pages) => client.stepMotion(request, pages),
            async () => {
                await aiConsent.restore()
                return aiConsent.getSnapshot().choice === 'accepted'
            },
        )
    }
    return runtime
}

/** Mounted only for the visible Guide step; the rest of a manual never queues a motion request. */
export function GuideStepMotion({
    session,
    stepId,
    pageUris,
    active,
    readOnly,
    fallback,
    stepLabel,
    pageImageStatus,
    onAvailabilityChange,
}: {
    session: ManualSession | undefined
    stepId: string | null
    pageUris: Readonly<Record<string, string>>
    active: boolean
    readOnly: boolean
    fallback?: ReactNode
    stepLabel?: string
    pageImageStatus?: 'pending' | 'ready' | 'unavailable'
    onAvailabilityChange?: (status: StepMotionAvailability) => void
}): ReactElement | null {
    const request = useMemo(
        () =>
            session === undefined || stepId === null
                ? null
                : motionRequestForStep(session, stepId, `motion-${Date.now().toString(36)}`),
        [session, stepId],
    )
    const identity = request === null ? null : stepMotionCacheKey(request)
    const [result, setResult] = useState<{ identity: string; scene: StepMotionScene | null } | null>(null)
    const [loading, setLoading] = useState(false)
    const pageUri = request === null ? undefined : pageUris[request.page.pageId]
    const enabled = active && !readOnly && DEMO_MODE === 'model' && GENERATIVE_UI !== 'off'
    const possible = enabled && identity !== null
    // A page image still resolving keeps the loader; only a settled page state lets the manual image take the frame.
    const awaitingPage =
        possible && pageUri === undefined && pageImageStatus !== 'ready' && pageImageStatus !== 'unavailable'
    useEffect(() => {
        if (!enabled || request === null || identity === null || pageUri === undefined) {
            setLoading(false)
            return
        }
        let current = true
        setLoading(true)
        void registry()
            .load(request, { [request.page.pageId]: pageUri })
            .then((scene) => {
                if (current) {
                    setResult({ identity, scene })
                    setLoading(false)
                }
            })
        return (): void => {
            current = false
        }
    }, [enabled, request, identity, pageUri])
    const canPresent = possible && pageUri !== undefined
    const scene = canPresent && result?.identity === identity ? result.scene : null
    return (
        <StepMotionHint
            key={identity}
            scene={scene}
            loading={awaitingPage || (canPresent && (loading || result?.identity !== identity))}
            fallback={fallback}
            stepLabel={stepLabel}
            onAvailabilityChange={onAvailabilityChange}
            active={active}
            readingLanguage={session?.readingLanguage ?? 'en'}
        />
    )
}
