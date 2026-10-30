import {
    buildFallbackProposalV2,
    nodeFactIdsV2,
    type ScreenNodeV2,
    type ScreenProposalV2,
    type ScreenVariantV2,
} from '@truebuild/contracts'

import type { DocumentFixtureGenerator } from '../server/documents/service'
import { encodeWireProposal } from './document-wire'

/**
 * Synthetic whole-screen documents for the isolated fixture runtime (`PROVIDER_MODE=fixture`) and tests. This is NOT a
 * model and not a fallback for one: it is wired only by the explicit fixture runtime (or an injected test option), its
 * documents are labeled `synthetic-fixture`, and they claim no model, effort, timing or usage. It returns the raw flat
 * wire table a provider would return, so every fixture document takes the same decode, validation, repair and
 * fallback path as a real model document. Two arrangements exist so two different manuals differ in composition.
 *
 * Deterministic scenarios:
 * - the guide of every step after the first takes `STEP_DELAY_MS`, so a precompute shows partial progress;
 * - the question screen of the `treadmill-monitor-arm` manual is invalid on both attempts (forced invalid, then the
 *   complete deterministic fallback);
 * - the guide of the `repair-once-manual` manual omits its safety fact on the first attempt and is valid on the single
 *   repair (so a repaired generated document is exercised).
 */
export const DOCUMENT_STEP_DELAY_MS = 600
export const INVALID_QUESTIONS_MANUAL = 'treadmill-monitor-arm'
export const REPAIR_ONCE_MANUAL = 'repair-once-manual'

function wait(milliseconds: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        if (signal.aborted) return reject(signal.reason)
        const timer = setTimeout(resolve, milliseconds)
        timer.unref?.()
        signal.addEventListener(
            'abort',
            () => {
                clearTimeout(timer)
                reject(signal.reason)
            },
            { once: true },
        )
    })
}

const arrangement = (manualId: string | null): 'stacked' | 'cards' =>
    Array.from(manualId ?? '').reduce((sum, character) => sum + (character.codePointAt(0) ?? 0), 0) % 2 === 0
        ? 'stacked'
        : 'cards'

const card = (child: ScreenNodeV2): ScreenNodeV2 => ({
    type: 'Card',
    surface: 'plain',
    tone: 'neutral',
    padding: 'sm',
    children: [child],
})

function rearrange(variant: ScreenVariantV2): ScreenVariantV2 {
    const body = variant.body
    const inner = body.type === 'Scroll' ? body.children[0] : undefined
    if (body.type !== 'Scroll' || inner === undefined || inner.type !== 'Stack') return variant
    return { ...variant, body: { ...body, children: [{ ...inner, children: inner.children.map(card) }] } }
}

function withoutFacts(node: ScreenNodeV2, drop: ReadonlySet<string>): ScreenNodeV2 {
    if (!('children' in node)) return node
    return {
        ...node,
        children: node.children
            .filter((child) => !nodeFactIdsV2(child).some((id) => drop.has(id)))
            .map((child) => withoutFacts(child, drop)),
    } as ScreenNodeV2
}

export function createDocumentFixtureGenerator(): DocumentFixtureGenerator {
    return async (request, signal) => {
        const { context } = request
        const { kind, stepId, manualId } = request
        if (manualId === INVALID_QUESTIONS_MANUAL && kind === 'questions') return { nodes: [] }
        if (kind === 'guide' && stepId !== null) {
            const index = context.material.stepIndex
            if (index > 0) await wait(DOCUMENT_STEP_DELAY_MS, signal)
        }
        let proposal: ScreenProposalV2 = buildFallbackProposalV2(context.material)
        if (arrangement(manualId) === 'cards') {
            proposal = { ...proposal, ...rearrange(proposal) }
            // The camera stays mounted while its screen waits: its waiting variants take the same arrangement, so the
            // CameraView keeps one spine in the ready, busy and pending variants.
            // A photo-first screen keeps its held photo at one spine in the ready, waiting and failure variants.
            const keepSpine =
                kind === 'camera'
                    ? ['busy', 'pending']
                    : context.material.requirements.capture
                      ? ['busy', 'pending', 'error', 'recovery']
                      : []
            if (keepSpine.length > 0) {
                const states = { ...proposal.states }
                for (const name of keepSpine as ('busy' | 'pending' | 'error' | 'recovery')[]) {
                    const variant = states[name]
                    states[name] = variant === null ? null : rearrange(variant)
                }
                proposal = { ...proposal, states }
            }
        }
        if (manualId === REPAIR_ONCE_MANUAL && kind === 'guide' && request.attempt === 1) {
            proposal = { ...proposal, body: withoutFacts(proposal.body, new Set(context.material.requirements.facts)) }
        }
        return encodeWireProposal(proposal)
    }
}
