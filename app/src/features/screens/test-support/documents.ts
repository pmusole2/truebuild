import { createHash } from 'node:crypto'
import {
    INTENT_TARGETS,
    screenContextJson,
    TIP_TARGETS,
    SCREEN_LIMITS,
    createDemoManual,
    screenComponentPaths,
    screenDocumentSchema,
    type AppIntent,
    type ManualSession,
    type PublishedManualFact,
    type ScreenDocument,
    type ScreenDocumentSource,
    type ScreenIcon,
    type ScreenKind,
    type ScreenLeafNode,
    type ScreenMetadata,
    type ScreenNode,
} from '@truebuild/contracts'
import { contextInputsOf, type ScreenSpec } from '../screen-spec'

// Synthetic documents for tests only. Nothing here is model output; the fixture metadata says so.
export const hex = (character: string): string => character.repeat(64)

export const baseMetadata = (overrides: Partial<ScreenMetadata> = {}): ScreenMetadata => ({
    source: 'fallback',
    evidence: 'synthetic-fixture',
    stage: 'step-page',
    model: null,
    effort: null,
    fallbackReason: 'fixture',
    repaired: false,
    cacheHit: false,
    catalogVersion: 2,
    promptVersion: 1,
    generatedAt: '2026-01-01T00:00:00.000Z',
    timing: { timeToProviderMs: null, providerMs: null, parseValidateMs: null, totalMs: null },
    usage: { inputTokens: null, cachedTokens: null, outputTokens: null, reasoningTokens: null },
    droppedFacts: 0,
    forcedSafety: 0,
    ...overrides,
})

/** Recorded-looking numbers on a document that claims to be live. Test inputs only, never evidence of a real run. */
export const liveMetadata = (overrides: Partial<ScreenMetadata> = {}): ScreenMetadata =>
    baseMetadata({
        source: 'generated',
        evidence: 'live',
        model: 'muse-wonder-1.0',
        effort: 'max',
        fallbackReason: null,
        timing: { timeToProviderMs: 12, providerMs: 3400, parseValidateMs: 5, totalMs: 3420 },
        usage: { inputTokens: 1200, cachedTokens: 0, outputTokens: 900, reasoningTokens: 700 },
        ...overrides,
    })

/** SHA-256 hex with Node's crypto: the digest the store tests inject, and the key a faithful server would return. */
export const nodeDigest = async (text: string): Promise<string> => createHash('sha256').update(text).digest('hex')

/** The exact context key a document composed for this request carries. */
export function contextKeyOf(spec: ScreenSpec): string {
    return createHash('sha256')
        .update(screenContextJson(contextInputsOf(spec)))
        .digest('hex')
}

export const instruction = (
    text: string,
    emphasis: 'normal' | 'strong' | 'quiet' = 'strong',
): Extract<ScreenNode, { type: 'Instruction' }> => ({
    type: 'Instruction',
    text,
    emphasis,
    citations: [],
})

export type DocumentOptions = {
    readonly kind?: ScreenKind
    readonly session?: ManualSession | null
    readonly stepId?: string | null
    readonly captureId?: string | null
    readonly contextKey?: string
    readonly metadata?: ScreenMetadata
    readonly origins?: ScreenMetadata['origins']
    readonly title?: string
    readonly subtitle?: string | null
    readonly trailing?: AppIntent | null
    readonly body?: ScreenNode[]
    readonly primary?: { label: string; intent: AppIntent; icon?: ScreenIcon | null }
    readonly secondary?: { label: string; intent: AppIntent; icon?: ScreenIcon | null } | null
    readonly screenId?: string
    readonly sources?: ScreenDocumentSource[]
    readonly manualFacts?: PublishedManualFact[]
}

export function makeDocument(options: DocumentOptions = {}): ScreenDocument {
    const session = options.session === undefined ? createDemoManual() : options.session
    const body = options.body ?? [instruction('Slide the panel onto the bracket.')]
    const secondary = options.secondary === undefined ? null : options.secondary
    const metadata = options.metadata ?? baseMetadata()
    const candidate = {
        version: 1,
        kind: options.kind ?? 'guide',
        screenId: options.screenId ?? hex('b'),
        bound: {
            manualId: session?.manualId ?? null,
            revision: session?.revision ?? null,
            stepId: options.stepId === undefined ? (session?.reviewedSteps[0]?.stepId ?? null) : options.stepId,
            captureId: options.captureId ?? null,
            contextKey: options.contextKey ?? hex('c'),
        },
        metadata,
        header: {
            type: 'ScreenHeader',
            title: options.title ?? 'Step 1',
            subtitle: options.subtitle ?? null,
            trailing: options.trailing ?? null,
        },
        body,
        ...(options.sources === undefined ? {} : { sources: options.sources }),
        ...(options.manualFacts === undefined ? {} : { manualFacts: options.manualFacts }),
        bar: {
            primary: {
                type: 'PrimaryAction',
                label: options.primary?.label ?? 'Take photo',
                icon: options.primary?.icon ?? 'camera',
                intent: options.primary?.intent ?? { intent: 'capture', target: 'take-photo' },
            },
            secondary:
                secondary === null
                    ? null
                    : {
                          type: 'SecondaryAction',
                          label: secondary.label,
                          icon: secondary.icon ?? null,
                          intent: secondary.intent,
                      },
        },
    }
    // Origins follow the document's own components, so a test document is internally consistent.
    const withOrigins = {
        ...candidate,
        metadata: {
            ...candidate.metadata,
            ...(options.origins === undefined
                ? {
                      origins: Object.fromEntries(
                          screenComponentPaths(candidate).map((path) => [
                              path,
                              metadata.source === 'generated' ? 'generated' : 'fallback',
                          ]),
                      ),
                  }
                : { origins: options.origins }),
        },
    }
    return screenDocumentSchema.parse(withOrigins)
}

/** The request a document answers, for store and client tests. */
export function specFor(document: ScreenDocument, session: ManualSession | null = createDemoManual()): ScreenSpec {
    return {
        kind: document.kind,
        session,
        stepId: document.bound.stepId,
        captureId: document.bound.captureId,
        result: null,
        failure: null,
    }
}

// --- seeded randomness, for the property-style catalog tests -----------------------------------------------------------

export function rng(seed: number): () => number {
    let state = seed >>> 0
    return (): number => {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0
        return state / 4294967296
    }
}

const WORDS = [
    'panel',
    'bracket',
    'screw',
    'slide',
    'align',
    'check',
    'groove',
    'inward',
    'press',
    'seat',
    'leg',
    'hold',
]
function sentence(random: () => number, max: number): string {
    const count = 1 + Math.floor(random() * Math.min(max, SCREEN_LIMITS.instructionWords))
    return Array.from({ length: count }, () => WORDS[Math.floor(random() * WORDS.length)]).join(' ')
}

function pick<T>(random: () => number, values: readonly T[]): T {
    return values[Math.floor(random() * values.length)] as T
}

export function randomIntent(random: () => number): AppIntent {
    const name = pick(random, Object.keys(INTENT_TARGETS) as (keyof typeof INTENT_TARGETS)[])
    return { intent: name, target: pick(random, INTENT_TARGETS[name]) } as AppIntent
}

/** A valid leaf block of a random type, using only values the catalog allows. */
export function randomLeaf(random: () => number, captureId: string | null = null): ScreenLeafNode {
    const choice = Math.floor(random() * 12)
    switch (choice) {
        case 0:
            return instruction(sentence(random, 12), pick(random, ['normal', 'strong', 'quiet'] as const))
        case 1:
            return {
                type: 'PartList',
                showQuantities: random() > 0.5,
                items: [{ partId: 'side-panel', label: 'Side panel', quantity: 2 }],
            }
        case 2:
            return { type: 'QuantityChip', partId: 'side-panel', label: 'Panels', quantity: 2 }
        case 3:
            return {
                type: 'Warning',
                text: sentence(random, 10),
                tone: pick(random, ['caution', 'critical'] as const),
                citations: [],
            }
        case 4:
            return { type: 'StepProgress', current: 1, total: 3, label: random() > 0.5 ? 'Step 1 of 3' : null }
        case 5:
            return {
                type: 'ChoiceList',
                prompt: random() > 0.5 ? sentence(random, 5) : null,
                options: [
                    { label: 'Take photo', intent: { intent: 'capture', target: 'take-photo' } },
                    { label: 'Ask', intent: { intent: 'ask', target: 'about-step' } },
                ],
            }
        case 6:
            return {
                type: 'ConfirmFact',
                text: sentence(random, 10),
                confirm: { intent: 'confirm', target: 'facts' },
                dismiss: random() > 0.5 ? { intent: 'open-details', target: 'step' } : null,
                citations: [],
            }
        case 7:
            return captureId === null
                ? { type: 'Instruction', text: sentence(random, 8), emphasis: 'strong', citations: [] }
                : { type: 'PhotoWithRegions', captureId, observed: null, regions: [] }
        case 8:
            return {
                type: 'AnswerCard',
                text: sentence(random, 18),
                caveat: random() > 0.5 ? sentence(random, 6) : null,
                citations: [],
            }
        case 11:
            return {
                type: 'ActionLink',
                label: sentence(random, 4),
                icon: random() > 0.5 ? 'help' : null,
                intent: randomIntent(random),
                emphasis: pick(random, ['normal', 'strong', 'quiet'] as const),
            }
        case 9:
            return {
                type: 'Tip',
                targetId: pick(random, TIP_TARGETS),
                heading: sentence(random, 3),
                text: sentence(random, 9),
            }
        default:
            return {
                type: 'Skeleton',
                variant: pick(random, ['lines', 'card', 'hero'] as const),
                lines: 1 + Math.floor(random() * 5),
            }
    }
}

/** A valid body of up to the catalog's limits, with groups and disclosures holding leaves only. */
export function randomBody(random: () => number, captureId: string | null = null): ScreenNode[] {
    const count = 1 + Math.floor(random() * 6)
    const body: ScreenNode[] = []
    for (let index = 0; index < count; index++) {
        const wrap = random()
        if (wrap < 0.15) {
            body.push({
                type: 'Group',
                layout: pick(random, ['stack', 'row'] as const),
                children: [randomLeaf(random, captureId), randomLeaf(random, captureId)],
            })
        } else if (wrap < 0.3) {
            body.push({
                type: 'DetailsDisclosure',
                label: sentence(random, 3),
                initiallyOpen: random() > 0.5,
                children: [randomLeaf(random, captureId)],
            })
        } else if (wrap < 0.45) {
            body.push(randomHeavy(random))
        } else {
            body.push(randomLeaf(random, captureId))
        }
    }
    return body
}

/** A valid top-level-only block of the full-screen catalog; the live data it binds to may be absent (it then draws nothing). */
export function randomHeavy(random: () => number): ScreenNode {
    switch (Math.floor(random() * 7)) {
        case 0:
            return {
                type: 'ManualLibrary',
                entries: random() > 0.5 ? 'recent' : { manualIds: ['no-such-manual'] },
                layout: pick(random, ['cards', 'rows'] as const),
                showProgress: random() > 0.5,
                emptyText: random() > 0.5 ? sentence(random, 6) : null,
            }
        case 1:
            return {
                type: 'PageGallery',
                pages: 'session',
                layout: pick(random, ['list', 'grid'] as const),
                showNumbers: random() > 0.5,
                action: random() > 0.5 ? randomIntent(random) : null,
            }
        case 2:
            return {
                type: 'FactPrompt',
                questionRef: 'current',
                prompt: sentence(random, 8),
                detail: random() > 0.5 ? sentence(random, 8) : null,
                citations: [],
            }
        case 3:
            return {
                type: 'FactEditor',
                questionRef: 'current',
                kind: pick(random, ['orientation', 'checks'] as const),
                label: sentence(random, 4),
                saveLabel: 'Save',
                cancelLabel: 'Cancel',
            }
        case 4:
            return {
                type: 'QuestionComposer',
                captureRef: 'current',
                prompt: random() > 0.5 ? sentence(random, 6) : null,
                partScope: pick(random, ['step-parts', 'none'] as const),
                submitLabel: 'Ask',
            }
        case 5:
            return {
                type: 'CameraGuidance',
                cue: sentence(random, 5),
                pill: random() > 0.5 ? sentence(random, 3) : null,
                tipTarget: random() > 0.5 ? 'camera-shutter' : null,
            }
        default:
            return { type: 'ManualDirections', factIds: ['orientation', 'safety:none'], emphasis: 'normal' }
    }
}
