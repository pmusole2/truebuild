import {
    COACH_COPY_V2,
    CONFIRM_LABELS_V2,
    INTENT_TARGETS,
    allowedLiteralsV2,
    availableBoundKeysV2 as availableBoundKeys,
    coachTargetsForV2,
    documentMaterialV2,
    intentAllowedV2,
    manualDisplayTitleV2,
    requiredStatesV2,
    resultOfKindV2,
    screenContentJsonV2,
    screenContextJsonV2,
    screenContextPartsV2,
    screenFacts,
    screenStageV2,
    sourceResolverV2,
    variantRequirementsV2,
    type AppIntent,
    type DocumentMaterialV2,
    type ScreenBound,
    type ScreenContextInputsV2,
} from '@truebuild/contracts'

import { ACTION_LABELS } from '../screens/ui-copy'
import { sha256 } from '../screens/context'

export { sha256 }

/** Interface wording a state variant or a header control may use besides the per-intent labels. */
export const GENERIC_LABELS = ['Working…', 'Saving…', 'Please wait', 'Try again', 'Home', 'Back', 'More'] as const
export const CAMERA_CUES_V2 = [
    'Keep the whole step in view',
    'Hold steady',
    'Fill the frame with your work',
    'Fill the frame with the page',
] as const
export const CAMERA_PILLS_V2 = ['Step in view', 'Ready'] as const

export interface DocumentContext {
    inputs: ScreenContextInputsV2
    material: DocumentMaterialV2
    bound: ScreenBound
    /** Hash of the grounded content, independent of manual id, revision and review state (the cache key part). */
    contentKey: string
    stage: 'screens' | 'step-pages'
    /** Exactly what the provider is shown. */
    view: { stable: Record<string, unknown>; dynamic: Record<string, unknown> }
}

export { availableBoundKeysV2 as availableBoundKeys } from '@truebuild/contracts'

function allowedIntents(material: DocumentMaterialV2): AppIntent[] {
    return Object.entries(INTENT_TARGETS).flatMap(([intent, targets]) =>
        targets
            .map((target) => ({ intent, target }) as AppIntent)
            .filter((candidate) => intentAllowedV2(candidate, material)),
    )
}

/** The two confirmation labels of the reading cancellation: each belongs to one intent, in the `confirming` variant only. */
export function confirmLabelsFor(intent: AppIntent): readonly string[] {
    if (intent.intent !== 'navigate') return []
    return intent.target === 'pages'
        ? [CONFIRM_LABELS_V2.stop]
        : intent.target === 'reading'
          ? [CONFIRM_LABELS_V2.keep]
          : []
}

/** The wording the server accepts for an action with this intent. */
export function labelsFor(intent: AppIntent): readonly string[] {
    const table = ACTION_LABELS[intent.intent] as Readonly<Record<string, readonly string[]>>
    return table[intent.target] ?? []
}

export function buildDocumentContext(inputs: ScreenContextInputsV2): DocumentContext {
    const material = documentMaterialV2(inputs)
    const { identity } = screenContextPartsV2(inputs)
    // The grounding reads the inputs as the document uses them (a global More has no manual, photo or result).
    const used = material.inputs
    const facts = screenFacts(used.session)
    const bound: ScreenBound = {
        manualId: identity.manualId,
        revision: identity.revision,
        stepId: identity.stepId,
        captureId: identity.captureId,
        contextKey: sha256(screenContextJsonV2(inputs)),
    }
    const step = material.step
    const partNames = new Map(
        (facts?.parts ?? []).flatMap((part) => (part.name.state === 'known' ? [[part.partId, part.name.value]] : [])),
    )
    const allowed = allowedIntents(material)
    const quantities = new Map(
        (step?.parts ?? []).flatMap((part) =>
            part.quantity.state === 'known' ? [[part.partId, part.quantity.value]] : [],
        ),
    )
    const result = used.result
    const companion = resultOfKindV2(used, 'question')
    const resolve = sourceResolverV2(material.sources)
    const ready = variantRequirementsV2('ready', material.requirements, material)
    const view = {
        stable: {
            manual: used.session && {
                title: manualDisplayTitleV2(used.session),
                pages: used.session.pages.map((page) => ({
                    pageId: page.pageId,
                    assetId: page.assetId,
                    contentHash: page.contentHash,
                    mimeType: page.mimeType,
                    width: page.width,
                    height: page.height,
                })),
                steps: material.stepCount,
                parts: [...partNames].map(([partId, name]) => ({ partId, name })),
            },
        },
        dynamic: {
            document: {
                kind: inputs.kind,
                requiredStates: requiredStatesV2(inputs.kind, material.requirements),
                requirements: material.requirements,
                /** Every factId the ready screen must state: the requirements plus a quick check's overview steps. */
                readyFacts: ready.facts,
                /** Every source index the ready screen must cite visibly: the requirements plus the overview steps' pages. */
                readySources: ready.sources,
                overview: material.overview,
                failure: inputs.failure,
                completion: inputs.kind === 'completion' ? material.completion : null,
                captureId: bound.captureId,
                step: step && {
                    order: step.order,
                    of: material.stepCount,
                    title: step.title,
                    parts: material.partIds.map((partId) => ({
                        partId,
                        name: partNames.get(partId) ?? null,
                        quantity: quantities.get(partId) ?? null,
                    })),
                },
                facts: material.facts.map((fact) => ({
                    id: fact.factId,
                    kind: fact.kind,
                    basis: fact.basis,
                    text: fact.text,
                    sources: resolve(fact.sourceRefs),
                })),
                sources: material.sources.map((source, index) => ({ index, ...source })),
                sourcePrecision: material.sourcePrecision,
                result:
                    result === null
                        ? null
                        : result.kind === 'check'
                          ? { kind: 'check', decision: result.value.decision }
                          : { kind: 'question', question: result.question },
                /** More only: the answer held beside the retained check (its words are the facts `result:answer*`). */
                companionAnswer:
                    result?.kind === 'check' && companion?.kind === 'question'
                        ? { question: companion.question }
                        : null,
                ui: screenContextPartsV2(inputs).content.ui,
                boundKeys: availableBoundKeys(material),
                allowedIntents: allowed,
                allowedLabels: Object.fromEntries(
                    allowed.map((candidate) => [`${candidate.intent}:${candidate.target}`, labelsFor(candidate)]),
                ),
                genericLabels: GENERIC_LABELS,
                /** Only in the `confirming` variant: Keep = navigate/reading, Stop = navigate/pages (nothing else there). */
                confirmation:
                    material.requirements.confirm.length > 0
                        ? { variant: 'confirming', keep: CONFIRM_LABELS_V2.keep, stop: CONFIRM_LABELS_V2.stop }
                        : null,
                /** The only literals each variant may write; any other prose is rejected (facts come from fact refs). */
                literalCopy: Object.fromEntries(
                    (['ready', ...requiredStatesV2(inputs.kind, material.requirements)] as const).map((name) => [
                        name,
                        allowedLiteralsV2(material, name),
                    ]),
                ),
                coachCopy: Object.fromEntries(
                    coachTargetsForV2(material).map((target) => [target, COACH_COPY_V2[target]]),
                ),
                cameraCues: CAMERA_CUES_V2,
                cameraPills: CAMERA_PILLS_V2,
            },
        },
    }
    return {
        inputs,
        material,
        bound,
        contentKey: sha256(screenContentJsonV2(inputs)),
        stage: screenStageV2(inputs.kind) === 'step-page' ? 'step-pages' : 'screens',
        view,
    }
}
