import {
    COACH_COPY_V2,
    INTENT_TARGETS,
    allowedLiteralsV2,
    availableBoundKeysV2 as availableBoundKeys,
    coachTargetsForV2,
    documentLanguageV2,
    documentMaterialV2,
    guideHeaderTextV2,
    intentAllowedV2,
    manualDisplayTitleV2,
    manualChecksInitiallyOpen,
    manualDirectionGroups,
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

import {
    CAMERA_CUES_V2,
    CAMERA_PILLS_V2,
    GENERIC_ACTION_LABELS_V2 as GENERIC_LABELS,
    labelsForV2 as labelsFor,
} from '@truebuild/contracts'
export {
    CAMERA_CUES_V2,
    CAMERA_PILLS_V2,
    GENERIC_ACTION_LABELS_V2 as GENERIC_LABELS,
    confirmLabelsForV2 as confirmLabelsFor,
    labelsForV2 as labelsFor,
} from '@truebuild/contracts'
import { sha256 } from '../screens/context'

export { sha256 }

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

/**
 * The state-bound list and editor nodes this screen has state for: the same bindings the semantic gate enforces
 * (`binding_unavailable`), so the model is never handed a choice the gate would refuse.
 */
function nativeNodes(inputs: ScreenContextInputsV2, material: DocumentMaterialV2): string[] {
    const ui = inputs.uiState
    return [
        ...(ui?.library ? ['ManualList'] : []),
        ...(ui?.pages ? ['PageList'] : []),
        ...(ui?.capture ? ['TextField'] : []),
        ...(ui?.review?.currentQuestion ? ['FactEditor'] : []),
        ...((ui?.pages?.languageOptions.length ?? 0) > 0 || (ui?.language?.options.length ?? 0) > 0
            ? ['Choice:language']
            : []),
        ...(ui?.capture && inputs.captureId !== null && material.partIds.length > 0 ? ['Choice:part-target'] : []),
        ...(material.pieceIds.length > 0 ? ['PieceViewer', 'PiecesGrid'] : []),
    ]
}

export function buildDocumentContext(inputs: ScreenContextInputsV2, legacyDirections = false): DocumentContext {
    const material = documentMaterialV2(inputs, legacyDirections)
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
    const groups = manualDirectionGroups(material.facts)
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
                /** The code the manual text is in (`en` unless the manual was parsed in another language). */
                language: documentLanguageV2(used.session),
                requirements: material.requirements,
                /** Every factId the ready screen must state: the requirements plus a quick check's overview steps. */
                readyFacts: ready.facts,
                /** Every source index the ready screen must cite visibly: the requirements plus the overview steps' pages. */
                readySources: ready.sources,
                // Guide directions are needed even when explicit safety classification leaves no mandatory facts.
                ...(used.kind === 'guide' && step !== null
                    ? {
                          headerText: legacyDirections
                              ? {
                                    title: { kind: 'bound', key: 'step-title' },
                                    subtitle: { kind: 'bound', key: 'step-position' },
                                }
                              : guideHeaderTextV2(material),
                          ...(legacyDirections ? { legacyDirections: true } : {}),
                          directionFacts: material.facts
                              .filter((fact) =>
                                  legacyDirections
                                      ? fact.kind !== 'safety' &&
                                        fact.kind !== 'title' &&
                                        (fact.basis === 'direction' || fact.basis === 'unclassified-step')
                                      : groups.directions.includes(fact),
                              )
                              .map((fact) => ({ kind: 'fact', factId: fact.factId })),
                          ...(!legacyDirections
                              ? {
                                    checkInitiallyOpen: manualChecksInitiallyOpen(step),
                                    checkFacts: material.facts
                                        .filter((fact) => groups.checks.includes(fact))
                                        .map((fact) => ({ kind: 'fact', factId: fact.factId })),
                                }
                              : {}),
                      }
                    : {}),
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
                nativeNodes: nativeNodes(used, material),
                boundKeys: availableBoundKeys(material),
                allowedIntents: allowed,
                /** Home is the root: its header.back must be null, so the way back is not offered to it at all. */
                headerBack: allowed.some((candidate) => candidate.intent === 'navigate' && candidate.target === 'back')
                    ? 'navigate/back'
                    : null,
                allowedLabels: Object.fromEntries(
                    allowed.map((candidate) => [`${candidate.intent}:${candidate.target}`, labelsFor(candidate)]),
                ),
                genericLabels: GENERIC_LABELS,
                /** The only literals the ready screen may write; any other prose is rejected (facts come from fact refs). */
                literalCopy: { ready: allowedLiteralsV2(material, 'ready') },
                coachCopy: Object.fromEntries(
                    coachTargetsForV2(material).map((target) => [target, COACH_COPY_V2[target]]),
                ),
                cameraCues: CAMERA_CUES_V2,
                cameraPills: CAMERA_PILLS_V2,
                // The ids only (never geometry): the registry's where one was supplied, a guide's step catalog otherwise.
                ...(used.pieces == null && used.kind !== 'guide' ? {} : { pieceIds: material.pieceIds }),
                // A guide's closed catalog, exact ids and quantities (the app renders the quantity); null when none is known.
                ...(used.kind === 'guide' ? { stepPieces: used.stepPieces ?? null } : {}),
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
