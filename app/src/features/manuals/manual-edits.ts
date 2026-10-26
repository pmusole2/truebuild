import {
    manualSessionSchema,
    type Connection,
    type Fact,
    type ManualPart,
    type ManualSession,
    type ManualStep,
    type Orientation,
    type PartRequirement,
    type VisibleCheck,
} from '@truebuild/contracts'
import { removeManualPage, renameManual, replaceReviewedParts, replaceReviewedSteps } from '../../domain/manual-session'
import { confirmCorrection, copyRawStepToDraft, discardCorrection, RawReviewError } from './raw-review'

// Manual sources are cited by page; a known fact always carries one page reference.
// Assembly observations are never created here.
// Messages from this module are written for the user; domain and platform errors are never shown verbatim.
export class ManualEditError extends Error {
    constructor(message: string) {
        super(message)
        this.name = 'ManualEditError'
    }
}

export const UNKNOWN_REASON = 'Not confirmed from the imported manual pages.'

export type FactInput =
    { readonly state: 'known'; readonly text: string; readonly pageId: string } | { readonly state: 'unknown' }

export type QuantityInput =
    { readonly state: 'known'; readonly quantity: number; readonly pageId: string } | { readonly state: 'unknown' }

export type ManualEdit =
    | { readonly kind: 'rename'; readonly title: string }
    | { readonly kind: 'remove-page'; readonly pageId: string }
    | { readonly kind: 'move-page'; readonly pageId: string; readonly direction: -1 | 1 }
    | { readonly kind: 'add-part'; readonly name: FactInput }
    | { readonly kind: 'set-part-name'; readonly partId: string; readonly name: FactInput }
    | { readonly kind: 'remove-part'; readonly partId: string }
    | { readonly kind: 'add-step'; readonly title: string }
    | { readonly kind: 'set-step-title'; readonly stepId: string; readonly title: string }
    | { readonly kind: 'move-step'; readonly stepId: string; readonly direction: -1 | 1 }
    | { readonly kind: 'remove-step'; readonly stepId: string }
    | { readonly kind: 'add-step-part'; readonly stepId: string; readonly partId: string; readonly pageId: string }
    | {
          readonly kind: 'set-step-part-quantity'
          readonly stepId: string
          readonly partId: string
          readonly quantity: QuantityInput
      }
    | { readonly kind: 'remove-step-part'; readonly stepId: string; readonly partId: string }
    | {
          readonly kind: 'set-step-orientation'
          readonly stepId: string
          readonly description: FactInput
          readonly partId?: string
      }
    | {
          readonly kind: 'set-step-connection'
          readonly stepId: string
          readonly description: FactInput
          readonly partIds?: readonly string[]
      }
    | { readonly kind: 'add-step-check'; readonly stepId: string; readonly description: FactInput }
    | { readonly kind: 'remove-step-check'; readonly stepId: string; readonly checkId: string }
    // Raw evidence is only read by these; reviewed facts change, and the manual becomes unreviewed.
    | { readonly kind: 'copy-raw-step'; readonly rawStepId: string }
    | { readonly kind: 'confirm-correction'; readonly stepId: string }
    | { readonly kind: 'discard-correction'; readonly stepId: string }

function knownFact<T>(value: T, pageId: string): Fact<T> {
    return { state: 'known', value, sourceRefs: [{ pageId, region: null }] }
}

function unknownFact<T>(): Fact<T> {
    return { state: 'unknown', reason: UNKNOWN_REASON }
}

function requireText(text: string): string {
    const trimmed = text.trim()
    if (trimmed.length === 0) {
        throw new ManualEditError('Enter text, or mark the fact unknown.')
    }
    return trimmed
}

function textFact(input: FactInput): Fact<string> {
    return input.state === 'known' ? knownFact(requireText(input.text), input.pageId) : unknownFact<string>()
}

// Returns the smallest unused `${prefix}-n`, so identifiers stay short and deterministic.
function nextId(prefix: string, existing: readonly string[]): string {
    const used = new Set(existing)
    let counter = 1
    while (used.has(`${prefix}-${counter}`)) {
        counter += 1
    }
    return `${prefix}-${counter}`
}

// A step is only reviewable when it cites at least one page, so every cited fact also cites its step.
function citeStep(step: ManualStep, pageId: string): ManualStep {
    if (step.sourceRefs.some((ref) => ref.pageId === pageId)) {
        return step
    }
    return { ...step, sourceRefs: [...step.sourceRefs, { pageId, region: null }] }
}

function findStep(session: ManualSession, stepId: string): ManualStep {
    const step = session.reviewedSteps.find((candidate) => candidate.stepId === stepId)
    if (step === undefined) {
        throw new ManualEditError('That step is no longer in this manual.')
    }
    return step
}

function replaceStep(session: ManualSession, stepId: string, update: (step: ManualStep) => ManualStep): ManualSession {
    findStep(session, stepId)
    return replaceReviewedSteps(
        session,
        session.reviewedSteps.map((step) => (step.stepId === stepId ? update(step) : step)),
    )
}

function orientationFact(step: ManualStep, input: FactInput, partId?: string): Fact<Orientation> {
    if (input.state === 'unknown') {
        return unknownFact<Orientation>()
    }
    const targetId = partId ?? (step.orientation.state === 'known' ? step.orientation.value.partId : undefined)
    if (targetId === undefined) {
        throw new ManualEditError(
            'Select the part that is oriented, or mark this fact unknown if the description is not about a specific part.',
        )
    }
    const partExists = step.parts.some((part) => part.partId === targetId)
    if (!partExists) {
        throw new ManualEditError(
            'That part is no longer required by this step. Select an existing part or mark unknown.',
        )
    }
    return knownFact({ partId: targetId, description: requireText(input.text) }, input.pageId)
}

// `partIds` distinguishes three cases. Undefined is a description-only edit: a known connection keeps its existing
// targets, and an unknown one has no target to keep, so it is refused. An explicit array is the user's selection and
// is validated as given; an empty array is refused rather than replaced by the old or a default set.
function connectionFact(step: ManualStep, input: FactInput, partIds?: readonly string[]): Fact<Connection> {
    if (input.state === 'unknown') {
        return unknownFact<Connection>()
    }
    if (step.parts.length === 0) {
        throw new ManualEditError('Add a part to this step before describing its connection.')
    }
    const targetIds = partIds ?? (step.connection.state === 'known' ? step.connection.value.partIds : undefined)
    if (targetIds === undefined) {
        throw new ManualEditError('Select the parts this connection involves before saving its description.')
    }
    if (targetIds.length === 0) {
        throw new ManualEditError('Select at least one part this connection involves, or mark the connection unknown.')
    }
    if (new Set(targetIds).size !== targetIds.length) {
        throw new ManualEditError('Each part can be selected only once for this connection.')
    }
    for (const id of targetIds) {
        if (!step.parts.some((part) => part.partId === id)) {
            throw new ManualEditError(
                'A selected part is no longer required by this step. Update the connection parts.',
            )
        }
    }
    return knownFact({ partIds: [...targetIds], description: requireText(input.text) }, input.pageId)
}

function quantityFact(input: QuantityInput): Fact<number> {
    if (input.state === 'unknown') {
        return unknownFact<number>()
    }
    if (!Number.isInteger(input.quantity) || input.quantity < 1) {
        throw new ManualEditError('Quantity must be a whole number of at least 1.')
    }
    return knownFact(input.quantity, input.pageId)
}

function citeFactStep(input: FactInput, updated: ManualStep): ManualStep {
    return input.state === 'known' ? citeStep(updated, input.pageId) : updated
}

function moveStep(session: ManualSession, stepId: string, direction: -1 | 1): ManualSession {
    const ordered = [...session.reviewedSteps].sort((left, right) => left.order - right.order)
    const index = ordered.findIndex((step) => step.stepId === stepId)
    const neighbour = ordered[index + direction]
    const current = ordered[index]
    if (index === -1 || neighbour === undefined || current === undefined) {
        return session
    }
    const swapped = ordered.map((step) => {
        if (step.stepId === current.stepId) {
            return { ...step, order: neighbour.order }
        }
        if (step.stepId === neighbour.stepId) {
            return { ...step, order: current.order }
        }
        return step
    })
    return replaceReviewedSteps(session, swapped)
}

function addStep(session: ManualSession, title: string): ManualSession {
    const stepIds = session.reviewedSteps.map((step) => step.stepId)
    const order = session.reviewedSteps.reduce((highest, step) => Math.max(highest, step.order), 0) + 1
    const step: ManualStep = {
        stepId: nextId('step', stepIds),
        order,
        title: requireText(title),
        parts: [],
        orientation: unknownFact<Orientation>(),
        connection: unknownFact<Connection>(),
        visibleChecks: [],
        sourceRefs: [],
        correction: null,
    }
    return replaceReviewedSteps(session, [...session.reviewedSteps, step])
}

function addStepPart(step: ManualStep, partId: string, pageId: string): ManualStep {
    if (step.parts.some((part) => part.partId === partId)) {
        throw new ManualEditError('That part is already required by this step.')
    }
    const requirement: PartRequirement = { partId, quantity: knownFact(1, pageId) }
    return { ...step, parts: [...step.parts, requirement] }
}

function setPartRequirement(step: ManualStep, partId: string, quantity: Fact<number>): ManualStep {
    return {
        ...step,
        parts: step.parts.map((part) => (part.partId === partId ? { ...part, quantity } : part)),
    }
}

function addCheck(step: ManualStep, description: Fact<string>): ManualStep {
    const check: VisibleCheck = {
        checkId: nextId(
            'check',
            step.visibleChecks.map((item) => item.checkId),
        ),
        description,
    }
    return { ...step, visibleChecks: [...step.visibleChecks, check] }
}

// Reorders pages without changing any identifier, step, part or raw extraction. The review bump mirrors replaceReviewedSteps:
// a revision increment and an unreviewed status, so a stale review cannot survive a page move.
function movePage(session: ManualSession, pageId: string, direction: -1 | 1): ManualSession {
    const index = session.pages.findIndex((page) => page.pageId === pageId)
    const target = index + direction
    const moved = session.pages[index]
    if (moved === undefined || target < 0 || target >= session.pages.length) {
        throw new ManualEditError('This page is already at that end of the manual.')
    }
    const pages = [...session.pages]
    pages.splice(index, 1)
    pages.splice(target, 0, moved)
    return manualSessionSchema.parse({
        ...session,
        pages,
        updatedAt: new Date().toISOString(),
        revision: session.revision + 1,
        reviewStatus: 'unreviewed',
    })
}

function addPart(session: ManualSession, name: FactInput): ManualSession {
    const part: ManualPart = {
        partId: nextId(
            'part',
            session.parts.map((item) => item.partId),
        ),
        name: textFact(name),
    }
    return replaceReviewedParts(session, [...session.parts, part])
}

function setPartName(session: ManualSession, partId: string, name: FactInput): ManualSession {
    const parts = session.parts.map((part) => (part.partId === partId ? { ...part, name: textFact(name) } : part))
    return replaceReviewedParts(session, parts)
}

// Applies one editing action and returns a new session with a bumped revision.
// Every structural edit resets review status, so stale verdicts and reviews cannot survive a change.
/** Runs a raw-review operation, presenting its refusals as the same user-facing edit errors. */
function reviewAction(run: () => ManualSession): ManualSession {
    try {
        return run()
    } catch (error: unknown) {
        if (error instanceof RawReviewError) {
            throw new ManualEditError(error.message)
        }
        throw error
    }
}

export function applyManualEdit(session: ManualSession, edit: ManualEdit): ManualSession {
    switch (edit.kind) {
        case 'rename':
            return renameManual(session, requireText(edit.title))
        case 'remove-page':
            return removeManualPage(session, edit.pageId)
        case 'move-page':
            return movePage(session, edit.pageId, edit.direction)
        case 'add-part':
            return addPart(session, edit.name)
        case 'set-part-name':
            return setPartName(session, edit.partId, edit.name)
        case 'remove-part':
            return replaceReviewedParts(
                session,
                session.parts.filter((part) => part.partId !== edit.partId),
            )
        case 'add-step':
            return addStep(session, edit.title)
        case 'set-step-title':
            return replaceStep(session, edit.stepId, (step) => ({ ...step, title: requireText(edit.title) }))
        case 'move-step':
            return moveStep(session, edit.stepId, edit.direction)
        case 'remove-step':
            findStep(session, edit.stepId)
            return replaceReviewedSteps(
                session,
                session.reviewedSteps.filter((step) => step.stepId !== edit.stepId),
            )
        case 'add-step-part':
            return replaceStep(session, edit.stepId, (step) =>
                citeStep(addStepPart(step, edit.partId, edit.pageId), edit.pageId),
            )
        case 'set-step-part-quantity':
            return replaceStep(session, edit.stepId, (step) => {
                const quantity = quantityFact(edit.quantity)
                const cited = edit.quantity.state === 'known' ? citeStep(step, edit.quantity.pageId) : step
                return setPartRequirement(cited, edit.partId, quantity)
            })
        case 'remove-step-part':
            return replaceStep(session, edit.stepId, (step) => ({
                ...step,
                parts: step.parts.filter((part) => part.partId !== edit.partId),
            }))
        case 'set-step-orientation':
            return replaceStep(session, edit.stepId, (step) =>
                citeFactStep(edit.description, {
                    ...step,
                    orientation: orientationFact(step, edit.description, edit.partId),
                }),
            )
        case 'set-step-connection':
            return replaceStep(session, edit.stepId, (step) =>
                citeFactStep(edit.description, {
                    ...step,
                    connection: connectionFact(step, edit.description, edit.partIds),
                }),
            )
        case 'add-step-check':
            return replaceStep(session, edit.stepId, (step) =>
                citeFactStep(edit.description, addCheck(step, textFact(edit.description))),
            )
        case 'copy-raw-step':
            return reviewAction(() => copyRawStepToDraft(session, edit.rawStepId, new Date().toISOString()))
        case 'confirm-correction':
            return reviewAction(() => confirmCorrection(session, edit.stepId, new Date().toISOString()))
        case 'discard-correction':
            return reviewAction(() => discardCorrection(session, edit.stepId, new Date().toISOString()))
        case 'remove-step-check':
            return replaceStep(session, edit.stepId, (step) => ({
                ...step,
                visibleChecks: step.visibleChecks.filter((check) => check.checkId !== edit.checkId),
            }))
    }
}
