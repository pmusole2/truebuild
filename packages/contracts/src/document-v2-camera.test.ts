import { createHash } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import {
    INTENT_TARGETS,
    SCREEN_KINDS_V2,
    appIntentSchema,
    cameraAccessV2,
    buildFallbackDocumentV2,
    cameraSpineV2,
    createDemoManual,
    documentMaterialV2,
    intentAllowedV2,
    nodeIntentsV2,
    screenContextJsonV2,
    screenDocumentV2Schema,
    screenUiStateV2Schema,
    variantsOfV2,
    verifyDocumentAgainstInputsV2,
    visitVariantNodesV2,
    type AppIntent,
    type ScreenContextInputsV2,
    type ScreenDocumentV2,
    type ScreenKindV2,
    type ScreenNodeV2,
    type ScreenVariantV2,
    type ScreenUiStateV2,
} from './index'

// The camera permission and failure closure: a camera document places the raw camera only when the permission is granted
// and the camera has not failed, and otherwise authors the way forward (ask, open settings or retry) as closed intents.

const sha256Hex = (text: string): string => createHash('sha256').update(text).digest('hex')
const deps = { sha256Hex, now: (): Date => new Date('2026-02-03T04:05:06.000Z') }

type Camera = NonNullable<ScreenUiStateV2['camera']>
const camera = (patch: Partial<Camera> = {}): Camera => ({ mode: 'build-photo', permission: 'granted', ...patch })
const inputsOf = (state: Camera | null, kind: ScreenKindV2 = 'camera'): ScreenContextInputsV2 => ({
    kind,
    session: createDemoManual(),
    stepId: 'step-1',
    captureId: null,
    result: null,
    failure: null,
    uiState: { camera: state },
})
const fallbackFor = (inputs: ScreenContextInputsV2): ScreenDocumentV2 =>
    buildFallbackDocumentV2(inputs, { ...deps, reason: 'disabled', evidence: 'local-deterministic' })

const nodesOf = (document: ScreenDocumentV2, name: string): ScreenNodeV2[] => {
    const out: ScreenNodeV2[] = []
    for (const entry of variantsOfV2(document)) {
        if (entry.name === name) visitVariantNodesV2(entry.variant, entry.prefix, ({ node }) => out.push(node))
    }
    return out
}
const hasCameraView = (document: ScreenDocumentV2): boolean =>
    variantsOfV2(document).some((entry) => nodesOf(document, entry.name).some((node) => node.type === 'CameraView'))
const intentOf = (to: AppIntent): string => `${to.intent}/${to.target}`
const barOf = (document: ScreenDocumentV2, name: 'ready' | 'error' | 'recovery'): string[] => {
    const bar = variantsOfV2(document).find((entry) => entry.name === name)!.variant.bar
    return [intentOf(bar.primary.intent), ...(bar.secondary ? [intentOf(bar.secondary.intent)] : [])]
}
const labelOf = (document: ScreenDocumentV2, name: 'ready' | 'error' | 'recovery'): string =>
    variantsOfV2(document).find((entry) => entry.name === name)!.variant.bar.primary.label
const boundKeys = (document: ScreenDocumentV2, name: string): string[] =>
    nodesOf(document, name).flatMap((node) =>
        node.type === 'Text' && node.content.kind === 'bound' ? [node.content.key] : [],
    )

describe('the typed camera state and its finite targets', () => {
    it('adds actual failed and canAskAgain as optional fields and keeps the old shape valid', () => {
        const parse = (value: unknown): boolean => screenUiStateV2Schema.safeParse({ camera: value }).success
        expect(parse({ mode: 'build-photo', permission: 'granted' })).toBe(true)
        expect(parse({ mode: 'manual-page', permission: 'denied', failed: false, canAskAgain: false })).toBe(true)
        expect(parse({ mode: 'build-photo', permission: 'undetermined', canAskAgain: null })).toBe(true)
        expect(parse({ mode: 'build-photo', permission: 'granted', failed: 'yes' })).toBe(false)
        expect(parse({ mode: 'build-photo', permission: 'granted', extra: true })).toBe(false)
    })

    it('adds exactly three targets under the existing eight intents (no ninth intent)', () => {
        expect(Object.keys(INTENT_TARGETS)).toHaveLength(8)
        expect(INTENT_TARGETS.confirm).toContain('camera-permission')
        expect(INTENT_TARGETS.retry).toContain('camera')
        expect(INTENT_TARGETS['open-details']).toContain('device-settings')
        for (const to of [
            { intent: 'confirm', target: 'camera-permission' },
            { intent: 'retry', target: 'camera' },
            { intent: 'open-details', target: 'device-settings' },
        ]) {
            expect(appIntentSchema.safeParse(to).success).toBe(true)
        }
        expect(appIntentSchema.safeParse({ intent: 'request', target: 'camera-permission' }).success).toBe(false)
    })
})

describe('camera access is derived from the witnessed state, never faked', () => {
    it.each([
        ['granted', camera(), 'ready'],
        ['granted and failed', camera({ failed: true }), 'retry'],
        ['undetermined', camera({ permission: 'undetermined' }), 'allow'],
        ['denied but can ask again', camera({ permission: 'denied', canAskAgain: true }), 'allow'],
        ['denied, unknown', camera({ permission: 'denied', canAskAgain: null }), 'allow'],
        ['denied, cannot ask again', camera({ permission: 'denied', canAskAgain: false }), 'settings'],
        ['not granted and failed (the permission wins)', camera({ permission: 'denied', failed: true }), 'allow'],
        ['absent', null, 'allow'],
    ] as [string, Camera | null, string][])('%s -> %s', (_name, state, access) => {
        expect(cameraAccessV2(state)).toBe(access)
    })

    it('normalizes the context key: defaults and irrelevant fields share one key, a witness changes it', () => {
        const key = (state: Camera | null): string => screenContextJsonV2(inputsOf(state))
        expect(key(camera())).toBe(key(camera({ failed: false, canAskAgain: null })))
        expect(key(camera())).toBe(key(camera({ canAskAgain: true })))
        expect(key(camera({ permission: 'denied' }))).toBe(key(camera({ permission: 'denied', canAskAgain: true })))
        expect(key(camera({ permission: 'denied', failed: true }))).toBe(key(camera({ permission: 'denied' })))
        expect(key(camera())).not.toBe(key(camera({ failed: true })))
        expect(key(camera({ permission: 'denied' }))).not.toBe(
            key(camera({ permission: 'denied', canAskAgain: false })),
        )
        expect(key(camera())).not.toBe(key(camera({ permission: 'denied' })))
    })
})

describe('the camera document per access', () => {
    it('granted and working: the raw camera and the shutter, nothing about permission', () => {
        const document = fallbackFor(inputsOf(camera()))
        expect(screenDocumentV2Schema.safeParse(document).success).toBe(true)
        expect(verifyDocumentAgainstInputsV2(document, inputsOf(camera()), sha256Hex)).toEqual([])
        expect(document.requirements.nodes).toContain('CameraView')
        expect(nodesOf(document, 'ready').some((node) => node.type === 'CameraView')).toBe(true)
        expect(barOf(document, 'ready')[0]).toBe('capture/take-photo')
        const all = variantsOfV2(document).flatMap((entry) => nodesOf(document, entry.name).flatMap(nodeIntentsV2))
        expect(all.map(intentOf)).not.toContain('confirm/camera-permission')
        expect(all.map(intentOf)).not.toContain('open-details/device-settings')
        expect(all.map(intentOf)).not.toContain('retry/camera')
    })

    it.each([
        ['undetermined', camera({ permission: 'undetermined' })],
        ['denied and can ask again', camera({ permission: 'denied', canAskAgain: true })],
        ['absent', null],
        ['the manual-page camera', camera({ mode: 'manual-page', permission: 'undetermined' })],
    ] as [string, Camera | null][])('%s: no raw camera, privacy help, primary "Allow camera"', (_name, state) => {
        const inputs = inputsOf(state)
        const document = fallbackFor(inputs)
        expect(screenDocumentV2Schema.safeParse(document).success).toBe(true)
        expect(verifyDocumentAgainstInputsV2(document, inputs, sha256Hex)).toEqual([])
        expect(hasCameraView(document)).toBe(false)
        expect(document.requirements.nodes).not.toContain('CameraView')
        expect(document.requirements.actions).toContainEqual({ intent: 'confirm', target: 'camera-permission' })
        expect(barOf(document, 'ready')[0]).toBe('confirm/camera-permission')
        expect(labelOf(document, 'ready')).toBe('Allow camera')
        expect(boundKeys(document, 'ready')).toContain('privacy-camera')
        expect(barOf(document, 'ready')).not.toContain('capture/take-photo')
        expect(document.overlays).toEqual([])
    })

    it('denied and cannot ask again: primary "Open settings" (open-details/device-settings), never the prompt', () => {
        const inputs = inputsOf(camera({ permission: 'denied', canAskAgain: false }))
        const document = fallbackFor(inputs)
        expect(screenDocumentV2Schema.safeParse(document).success).toBe(true)
        expect(verifyDocumentAgainstInputsV2(document, inputs, sha256Hex)).toEqual([])
        expect(hasCameraView(document)).toBe(false)
        expect(barOf(document, 'ready')[0]).toBe('open-details/device-settings')
        expect(labelOf(document, 'ready')).toBe('Open settings')
        expect(boundKeys(document, 'ready')).toContain('privacy-camera')
        const all = variantsOfV2(document).flatMap((entry) => nodesOf(document, entry.name).flatMap(nodeIntentsV2))
        expect(all.map(intentOf)).not.toContain('confirm/camera-permission')
    })

    it('failed camera: no raw camera, ready and the error/recovery variants lead with "Try camera again"', () => {
        const inputs = inputsOf(camera({ failed: true }))
        const document = fallbackFor(inputs)
        expect(screenDocumentV2Schema.safeParse(document).success).toBe(true)
        expect(verifyDocumentAgainstInputsV2(document, inputs, sha256Hex)).toEqual([])
        expect(hasCameraView(document)).toBe(false)
        expect(document.requirements.nodes).not.toContain('CameraView')
        for (const name of ['ready', 'error', 'recovery'] as const) {
            expect(barOf(document, name)[0]).toBe('retry/camera')
            expect(labelOf(document, name)).toBe('Try camera again')
        }
        expect(document.requirements.actions).toContainEqual({ intent: 'retry', target: 'camera' })
    })

    it('a working camera keeps its error variant free of the camera retry (only a witnessed failure owns it)', () => {
        const document = fallbackFor(inputsOf(camera()))
        expect(barOf(document, 'error')).not.toContain('retry/camera')
        expect(hasCameraView(document)).toBe(true)
        expect(
            nodesOf(document, 'error')
                .concat(nodesOf(document, 'recovery'))
                .some((node) => node.type === 'CameraView'),
        ).toBe(false)
    })

    it('keeps the step safety facts and citations complete in every variant of every access', () => {
        for (const state of [
            camera(),
            camera({ failed: true }),
            camera({ permission: 'denied', canAskAgain: false }),
            camera({ permission: 'undetermined' }),
        ]) {
            const document = fallbackFor(inputsOf(state))
            expect(document.requirements.facts.length).toBeGreaterThan(0)
            // The schema itself rejects a variant that omits a required fact or citation.
            expect(screenDocumentV2Schema.safeParse(document).success).toBe(true)
        }
    })
})

describe('the new targets are scoped to the camera screen and its witnesses', () => {
    const allow: AppIntent = { intent: 'confirm', target: 'camera-permission' }
    const settings: AppIntent = { intent: 'open-details', target: 'device-settings' }
    const retry: AppIntent = { intent: 'retry', target: 'camera' }
    const allowed = (to: AppIntent, state: Camera | null, kind: ScreenKindV2 = 'camera'): boolean =>
        intentAllowedV2(to, documentMaterialV2(inputsOf(state, kind)))

    it('allows each only for the camera with the witness that earns it', () => {
        const cases: [string, Camera | null, boolean, boolean, boolean][] = [
            ['granted', camera(), false, false, false],
            ['failed', camera({ failed: true }), false, false, true],
            ['undetermined', camera({ permission: 'undetermined' }), true, false, false],
            ['denied, can ask', camera({ permission: 'denied', canAskAgain: true }), true, false, false],
            ['denied, cannot ask', camera({ permission: 'denied', canAskAgain: false }), false, true, false],
            ['absent', null, true, false, false],
        ]
        for (const [name, state, wantAllow, wantSettings, wantRetry] of cases) {
            expect(allowed(allow, state), `allow ${name}`).toBe(wantAllow)
            expect(allowed(settings, state), `settings ${name}`).toBe(wantSettings)
            expect(allowed(retry, state), `retry ${name}`).toBe(wantRetry)
        }
    })

    it('no other kind can request them, whatever camera state the caller sends', () => {
        const witnesses = [
            camera({ permission: 'denied', canAskAgain: false }),
            camera({ permission: 'undetermined' }),
            camera({ failed: true }),
        ]
        for (const kind of SCREEN_KINDS_V2.filter((candidate) => candidate !== 'camera')) {
            for (const state of witnesses) {
                for (const to of [allow, settings, retry]) {
                    expect(allowed(to, state, kind), `${kind} ${intentOf(to)}`).toBe(false)
                }
            }
        }
    })

    it('a camera never offers the shutter without a working camera', () => {
        const shutter: AppIntent = { intent: 'capture', target: 'take-photo' }
        expect(allowed(shutter, camera())).toBe(true)
        expect(allowed(shutter, camera({ failed: true }))).toBe(false)
        expect(allowed(shutter, camera({ permission: 'denied' }))).toBe(false)
        expect(allowed(shutter, null)).toBe(false)
    })
})

describe('a request-bound client refuses a document that places a camera it cannot have', () => {
    it('rejects a CameraView when the permission is not granted or the camera failed', () => {
        const granted = fallbackFor(inputsOf(camera()))
        for (const state of [camera({ permission: 'denied' }), camera({ failed: true }), null]) {
            const issues = verifyDocumentAgainstInputsV2(granted, inputsOf(state))
            expect(issues).toContain('camera_unavailable')
        }
        expect(verifyDocumentAgainstInputsV2(granted, inputsOf(camera()))).toEqual([])
    })

    it('rejects a failed camera whose error or recovery variant does not lead with the camera retry', () => {
        const inputs = inputsOf(camera({ failed: true }))
        const document = fallbackFor(inputs)
        const forged: ScreenDocumentV2 = {
            ...document,
            states: {
                ...document.states,
                error: {
                    ...document.states.error!,
                    bar: {
                        primary: {
                            type: 'PrimaryAction',
                            label: 'Home',
                            icon: null,
                            intent: { intent: 'navigate', target: 'home' },
                        },
                        secondary: null,
                    },
                },
            },
        }
        expect(verifyDocumentAgainstInputsV2(forged, inputs)).toContain('camera_retry_missing')
    })
})

describe('a working camera carries two framing and clarity tips that stay put while it waits', () => {
    const TIPS = {
        'build-photo': [
            'Step back so the whole step fits in the frame.',
            'Use good light and hold steady for a sharp photo.',
        ],
        'manual-page': ['Keep all four corners in view.', 'Check that the words are clear.'],
    } as const
    type VariantName = 'ready' | 'busy' | 'pending' | 'error' | 'recovery'
    const variantOf = (document: ScreenDocumentV2, name: VariantName): ScreenVariantV2 =>
        variantsOfV2(document).find((entry) => entry.name === name)!.variant
    const tipCards = (document: ScreenDocumentV2, name: VariantName): ScreenNodeV2[] => {
        const cards: ScreenNodeV2[] = []
        visitVariantNodesV2(variantOf(document, name), '', ({ node }) => {
            if (node.type === 'Card') cards.push(node)
        })
        return cards
    }
    const tipTexts = (node: ScreenNodeV2): string[] =>
        node.type === 'Text' && node.content.kind === 'literal'
            ? [node.content.text]
            : 'children' in node
              ? node.children.flatMap(tipTexts)
              : []

    it.each(['build-photo', 'manual-page'] as const)(
        '%s: one card of exactly two listed tips right under the camera, the same in ready, busy and pending',
        (mode) => {
            const document = fallbackFor(inputsOf(camera({ mode })))
            const spines = new Set<string | null>()
            for (const name of ['ready', 'busy', 'pending'] as const) {
                const variant = variantOf(document, name)
                spines.add(cameraSpineV2(variant))
                const stack = (variant.body as Extract<ScreenNodeV2, { type: 'Scroll' }>).children[0] as Extract<
                    ScreenNodeV2,
                    { type: 'Stack' }
                >
                expect(stack.children[0]!.type, name).toBe('CameraView')
                const card = stack.children[1] as Extract<ScreenNodeV2, { type: 'Card' }>
                expect(card.type, name).toBe('Card')
                expect(tipTexts(card), name).toEqual([...TIPS[mode]])
                expect(tipCards(document, name).filter((entry) => entry === card)).toHaveLength(1)
            }
            // The camera stays mounted: one spine in ready, busy and pending.
            expect(spines.size).toBe(1)
            // Each waiting variant keeps its single primary action and no second one.
            for (const name of ['busy', 'pending'] as const) expect(variantOf(document, name).bar.secondary).toBeNull()
            expect(verifyDocumentAgainstInputsV2(document, inputsOf(camera({ mode })))).toEqual([])
            expect(screenDocumentV2Schema.safeParse(document).success).toBe(true)
        },
    )

    it.each([
        ['denied', camera({ permission: 'denied', canAskAgain: false })],
        ['undetermined', camera({ permission: 'undetermined' })],
        ['failed', camera({ failed: true })],
    ])('a %s camera shows its access copy and no tips, in any variant', (_name, state) => {
        const document = fallbackFor(inputsOf(state))
        const literals = variantsOfV2(document).flatMap((entry) => {
            const found: string[] = []
            visitVariantNodesV2(entry.variant, entry.prefix, ({ node }) => {
                if (node.type === 'Text' && node.content.kind === 'literal') found.push(node.content.text)
            })
            return found
        })
        for (const tip of [...TIPS['build-photo'], ...TIPS['manual-page']]) expect(literals).not.toContain(tip)
    })

    it("tips are listed per mode: the other mode's wording is refused", () => {
        const document = fallbackFor(inputsOf(camera({ mode: 'build-photo' })))
        const forged = JSON.parse(JSON.stringify(document).replaceAll(TIPS['build-photo'][0], TIPS['manual-page'][0]))
        expect(verifyDocumentAgainstInputsV2(forged, inputsOf(camera({ mode: 'build-photo' }))).length).toBeGreaterThan(
            0,
        )
    })
})
