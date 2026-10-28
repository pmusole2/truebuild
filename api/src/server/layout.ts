import {
    LAYOUT_LIMITS,
    layoutSchema,
    proposedLayoutSchema,
    type CheckResult,
    type Layout,
    type LayoutComponent,
    type ManualSession,
    type ManualStep,
} from '@truebuild/contracts'

export interface LayoutContext {
    step: ManualStep
    /** Present for step checks only; recovery is offered solely after a refusal. */
    decision?: CheckResult['decision']
    /** Manual pages actually supplied with this request. */
    pageIds: readonly string[]
}

function reviewedActionIds(step: ManualStep, decision: LayoutContext['decision']): string[] {
    return decision === 'refuse' && step.correction?.reviewed === true
        ? step.correction.actions.map((action) => action.actionId)
        : []
}

function supplied(step: ManualStep, pageIds: readonly string[]): number[] {
    return step.sourceRefs.flatMap((ref, index) => (pageIds.includes(ref.pageId) ? [index] : []))
}

function referencesResolve(component: LayoutComponent, { step, decision, pageIds }: LayoutContext): boolean {
    const within = (values: readonly (string | number)[], allowed: readonly (string | number)[]): boolean =>
        values.every((value) => allowed.includes(value))

    switch (component.type) {
        case 'part_grid':
            return within(
                component.partIds,
                step.parts.map((part) => part.partId),
            )
        case 'orientation':
            return step.orientation.state === 'known' && step.orientation.value.partId === component.partId
        case 'connection':
            return step.connection.state === 'known' && within(component.partIds, step.connection.value.partIds)
        case 'visible_checks':
            return within(
                component.checkIds,
                step.visibleChecks.flatMap((check) => (check.description.state === 'known' ? [check.checkId] : [])),
            )
        case 'source_diagram':
            return within(component.sourceRefIndexes, supplied(step, pageIds))
        case 'recovery':
            return within(component.actionIds, reviewedActionIds(step, decision))
    }
}

/** Deterministic layout from validated step data alone; every reference resolves by construction. */
export function fallbackLayout(context: LayoutContext): Layout {
    const { step, decision, pageIds } = context
    const limit = LAYOUT_LIMITS.references
    const components: LayoutComponent[] = []
    const parts = step.parts.map((part) => part.partId).slice(0, limit)
    if (parts.length > 0) components.push({ type: 'part_grid', partIds: parts })
    if (step.orientation.state === 'known')
        components.push({ type: 'orientation', partId: step.orientation.value.partId })
    if (step.connection.state === 'known')
        components.push({ type: 'connection', partIds: step.connection.value.partIds.slice(0, limit) })
    const checks = step.visibleChecks
        .flatMap((check) => (check.description.state === 'known' ? [check.checkId] : []))
        .slice(0, limit)
    if (checks.length > 0) components.push({ type: 'visible_checks', checkIds: checks })
    const diagrams = supplied(step, pageIds).slice(0, limit)
    if (diagrams.length > 0) components.push({ type: 'source_diagram', sourceRefIndexes: diagrams })
    const actions = reviewedActionIds(step, decision).slice(0, limit)
    if (actions.length > 0) components.push({ type: 'recovery', actionIds: actions })

    return layoutSchema.parse({ source: 'fallback', components })
}

/** A proposal is accepted whole or not at all: any bad shape or reference selects the fallback. */
export function resolveLayout(proposal: unknown, context: LayoutContext): Layout {
    const parsed = proposedLayoutSchema.safeParse(proposal)
    if (!parsed.success || !parsed.data.components.every((component) => referencesResolve(component, context))) {
        return fallbackLayout(context)
    }

    return { source: 'model', components: parsed.data.components }
}

interface LayoutInput {
    session: ManualSession
    binding: { stepId: string }
    sourceImages: readonly { page: { pageId: string } }[]
}

/**
 * Service-boundary step: with the flag off every proposal is discarded (response unchanged); with it on the layout is
 * resolved against the bound step, replacing any proposal. The verdict and other fields are never read or modified.
 */
export function withResolvedLayout<T extends { layout?: Layout; decision?: CheckResult['decision'] }>(
    result: T,
    input: LayoutInput,
    enabled: boolean,
): T {
    const { layout, ...rest } = result
    const step = input.session.reviewedSteps.find((candidate) => candidate.stepId === input.binding.stepId)
    if (!enabled || !step) return rest as T

    return {
        ...rest,
        layout: resolveLayout(layout, {
            step,
            decision: result.decision,
            pageIds: input.sourceImages.map((source) => source.page.pageId),
        }),
    } as T
}
