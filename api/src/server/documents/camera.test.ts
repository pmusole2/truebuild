import { createHash } from 'node:crypto'

import {
    COACH_COPY_V2,
    buildFallbackProposalV2,
    type AppIntent,
    type ScreenNodeV2,
    type ScreenProposalV2,
    type ScreenUiStateV2,
} from '@truebuild/contracts'
import { screensV2GenerateRequest } from '@truebuild/contracts/model'
import { describe, expect, it, vi } from 'vitest'

import { createApp } from '../../app'
import { demoSession, documentInputs, fullUi } from '../../test-support/document-inputs'
import { ACTION_LABELS } from '../screens/ui-copy'
import { createRuntimeFromEnvironment } from '../model-runtime'
import { buildDocumentContext, labelsFor } from './context'
import { checkProposal } from './ground'

// The camera permission and failure closure, server side: the label registry, the gate every model document passes and
// what the model is shown. The contract side is packages/contracts/src/document-v2-camera.test.ts.

const sha256Hex = (text: string): string => createHash('sha256').update(text).digest('hex')
type Camera = NonNullable<ScreenUiStateV2['camera']>
const cameraUi = (camera: Camera): ScreenUiStateV2 => ({ ...fullUi, camera })
const contextOf = (camera: Camera): ReturnType<typeof buildDocumentContext> =>
    buildDocumentContext(documentInputs('camera', demoSession(), cameraUi(camera)))
const GRANTED: Camera = { mode: 'build-photo', permission: 'granted' }
const ASK: Camera = { mode: 'build-photo', permission: 'undetermined' }
const SETTINGS: Camera = { mode: 'build-photo', permission: 'denied', canAskAgain: false }
const FAILED: Camera = { mode: 'build-photo', permission: 'granted', failed: true }

const issuesOf = (context: ReturnType<typeof buildDocumentContext>, proposal?: ScreenProposalV2): string[] =>
    checkProposal(proposal ?? buildFallbackProposalV2(context.material), context)

const cameraView: ScreenNodeV2 = {
    type: 'CameraView',
    mode: 'build-photo',
    cue: 'Keep the whole step in view',
    pill: null,
    tipTarget: null,
}
const withBody = (proposal: ScreenProposalV2, extra: ScreenNodeV2): ScreenProposalV2 => ({
    ...proposal,
    body: { type: 'Stack', gap: 'md', align: 'stretch', children: [proposal.body, extra] },
})
const barWith = (proposal: ScreenProposalV2, label: string, intent: AppIntent): ScreenProposalV2 => ({
    ...proposal,
    bar: { ...proposal.bar, primary: { type: 'PrimaryAction', label, icon: null, intent } },
})

describe('the label registry names the three camera actions', () => {
    it('lists exactly the authored wording', () => {
        expect(labelsFor({ intent: 'confirm', target: 'camera-permission' })).toEqual(['Allow camera'])
        expect(labelsFor({ intent: 'open-details', target: 'device-settings' })).toEqual([
            'Open settings',
            'Open device settings',
        ])
        expect(labelsFor({ intent: 'retry', target: 'camera' })).toEqual(['Try camera again'])
        expect(Object.keys(ACTION_LABELS)).toHaveLength(8)
    })
})

describe('the gate accepts the complete composition of every camera access', () => {
    it('rejects a shutter coach when no camera or shutter is available', () => {
        const context = buildDocumentContext(documentInputs('camera', demoSession(), cameraUi(SETTINGS)))
        const proposal = buildFallbackProposalV2(context.material)
        proposal.overlays = [
            {
                kind: 'tooltip',
                anchor: 'camera-shutter',
                content: {
                    type: 'CoachMark',
                    targetId: 'camera-shutter',
                    ...COACH_COPY_V2['camera-shutter']!,
                    placement: 'auto',
                },
            },
        ]
        expect(checkProposal(proposal, context).some((issue) => issue.endsWith(':coach_unavailable'))).toBe(true)
    })
    it.each([
        ['granted', GRANTED],
        ['undetermined', ASK],
        ['denied and can ask again', { mode: 'build-photo', permission: 'denied', canAskAgain: true } as Camera],
        ['denied for good', SETTINGS],
        ['failed', FAILED],
        ['the manual-page camera, undetermined', { mode: 'manual-page', permission: 'undetermined' } as Camera],
    ])('%s', (_name, camera) => {
        expect(issuesOf(contextOf(camera))).toEqual([])
    })
})

describe('the gate refuses a camera document that disagrees with the witnessed state', () => {
    it.each([
        ['undetermined', ASK],
        ['denied for good', SETTINGS],
        ['failed', FAILED],
    ])('rejects a raw CameraView while the camera is %s', (_name, camera) => {
        const context = contextOf(camera)
        const issues = issuesOf(context, withBody(buildFallbackProposalV2(context.material), cameraView))
        expect(issues.join()).toContain('camera_unavailable')
    })

    it('rejects the permission, settings and retry actions without their witness', () => {
        const granted = contextOf(GRANTED)
        const proposal = buildFallbackProposalV2(granted.material)
        const forged: [string, AppIntent, string][] = [
            ['Allow camera', { intent: 'confirm', target: 'camera-permission' }, 'granted'],
            ['Open settings', { intent: 'open-details', target: 'device-settings' }, 'granted'],
            ['Try camera again', { intent: 'retry', target: 'camera' }, 'granted'],
        ]
        for (const [label, intent] of forged) {
            expect(issuesOf(granted, barWith(proposal, label, intent)).join(), label).toContain('intent_not_allowed')
        }
        // The settings button is wrong while the system prompt can still be shown, and the prompt while it cannot.
        const ask = contextOf(ASK)
        expect(
            issuesOf(
                ask,
                barWith(buildFallbackProposalV2(ask.material), 'Open settings', {
                    intent: 'open-details',
                    target: 'device-settings',
                }),
            ).join(),
        ).toContain('intent_not_allowed')
        const settings = contextOf(SETTINGS)
        expect(
            issuesOf(
                settings,
                barWith(buildFallbackProposalV2(settings.material), 'Allow camera', {
                    intent: 'confirm',
                    target: 'camera-permission',
                }),
            ).join(),
        ).toContain('intent_not_allowed')
    })

    it('rejects the shutter when the camera cannot run, and a missing way forward', () => {
        const ask = contextOf(ASK)
        const proposal = buildFallbackProposalV2(ask.material)
        const shutter = barWith(proposal, 'Take photo', { intent: 'capture', target: 'take-photo' })
        expect(issuesOf(ask, shutter).join()).toContain('intent_not_allowed')
        expect(issuesOf(ask, shutter).join()).toContain('required_action_is_missing')
    })

    it('rejects a failed camera whose error variant does not lead with the camera retry', () => {
        const context = contextOf(FAILED)
        const proposal = buildFallbackProposalV2(context.material)
        const home: AppIntent = { intent: 'navigate', target: 'home' }
        const forged: ScreenProposalV2 = {
            ...proposal,
            states: {
                ...proposal.states,
                error: {
                    ...proposal.states.error!,
                    bar: {
                        primary: { type: 'PrimaryAction', label: 'Home', icon: null, intent: home },
                        secondary: null,
                    },
                },
            },
        }
        expect(issuesOf(context, forged).join()).toContain('camera_retry_missing')
    })

    it('does not accept an allow-camera label on the settings action', () => {
        const settings = contextOf(SETTINGS)
        const forged = barWith(buildFallbackProposalV2(settings.material), 'Allow camera', {
            intent: 'open-details',
            target: 'device-settings',
        })
        expect(issuesOf(settings, forged).join()).toContain('label_not_listed')
    })
})

describe('other kinds cannot request the camera actions', () => {
    it('rejects them on a guide, a result and a recovery whatever the camera state', () => {
        for (const kind of ['guide', 'result', 'recovery', 'add'] as const) {
            const context = buildDocumentContext(documentInputs(kind, demoSession(), cameraUi(SETTINGS)))
            const proposal = buildFallbackProposalV2(context.material)
            for (const [label, intent] of [
                ['Allow camera', { intent: 'confirm', target: 'camera-permission' }],
                ['Open settings', { intent: 'open-details', target: 'device-settings' }],
                ['Try camera again', { intent: 'retry', target: 'camera' }],
            ] as [string, AppIntent][]) {
                expect(issuesOf(context, barWith(proposal, label, intent)).join(), `${kind} ${label}`).toContain(
                    'intent_not_allowed',
                )
            }
        }
    })
})

describe('what the model is shown', () => {
    const dynamic = (camera: Camera): { document: Record<string, unknown> } =>
        contextOf(camera).view.dynamic as { document: Record<string, unknown> }
    const allowedKeys = (camera: Camera): string[] =>
        (dynamic(camera).document.allowedIntents as AppIntent[]).map((intent) => `${intent.intent}/${intent.target}`)

    it('lists the one camera action the state earns, and the shutter only for a camera that runs', () => {
        expect(allowedKeys(GRANTED)).toContain('capture/take-photo')
        expect(allowedKeys(GRANTED)).not.toContain('confirm/camera-permission')
        expect(allowedKeys(ASK)).toContain('confirm/camera-permission')
        expect(allowedKeys(ASK)).not.toContain('capture/take-photo')
        expect(allowedKeys(SETTINGS)).toContain('open-details/device-settings')
        expect(allowedKeys(SETTINGS)).not.toContain('confirm/camera-permission')
        expect(allowedKeys(FAILED)).toContain('retry/camera')
        expect(allowedKeys(FAILED)).not.toContain('capture/take-photo')
    })

    it('shows the normalized camera state and offers no camera tips for a camera that cannot show', () => {
        expect(dynamic(SETTINGS).document.ui).toEqual({
            camera: { mode: 'build-photo', permission: 'denied', failed: false, canAskAgain: false },
            busy: null,
        })
        expect(Object.keys(dynamic(GRANTED).document.coachCopy as object)).toEqual([
            'camera-shutter',
            'guide-hero-frame',
        ])
        for (const camera of [ASK, SETTINGS, FAILED]) {
            expect(dynamic(camera).document.coachCopy).toEqual({})
        }
    })

    it('makes the privacy sentence available as bound text on the camera screen only', () => {
        expect(dynamic(ASK).document.boundKeys as string[]).toContain('privacy-camera')
        const guide = buildDocumentContext(documentInputs('guide', demoSession(), cameraUi(GRANTED)))
        expect((guide.view.dynamic as { document: { boundKeys: string[] } }).document.boundKeys).not.toContain(
            'privacy-camera',
        )
    })
})

describe('POST /api/screens/v2 for a camera that cannot be shown (fixture runtime)', () => {
    const KEY = 'synthetic-local-test-value'
    async function generate(camera: Camera): Promise<Record<string, unknown>> {
        vi.spyOn(console, 'info').mockImplementation((): void => {})
        const runtime = createRuntimeFromEnvironment({ PROVIDER_MODE: 'fixture', API_SHARED_SECRET: KEY })
        const app = createApp({ runtime, onDuration: () => {} })
        const inputs = documentInputs('camera', demoSession(), cameraUi(camera))
        const body = new FormData()
        body.set('metadata', JSON.stringify(screensV2GenerateRequest('camera-1', inputs, sha256Hex)))
        const response = await app.request('/api/screens/v2', {
            method: 'POST',
            headers: { 'x-truebuild-key': KEY },
            body,
        })
        return (await response.json()) as Record<string, unknown>
    }
    const serialized = (value: unknown): string => JSON.stringify(value)

    it('publishes a document without a raw camera and with the permission action', async () => {
        const body = await generate(SETTINGS)
        expect(body, serialized(body)).toMatchObject({ status: 'ok' })
        const text = serialized(body)
        expect(text).not.toContain('"type":"CameraView"')
        expect(text).toContain('"target":"device-settings"')
        expect(text).toContain('Open settings')
    })

    it('publishes the raw camera for a camera that runs', async () => {
        const body = await generate(GRANTED)
        expect(body, serialized(body)).toMatchObject({ status: 'ok' })
        expect(serialized(body)).toContain('"type":"CameraView"')
    })
})
