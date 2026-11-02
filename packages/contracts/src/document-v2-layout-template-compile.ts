import {
    DOCUMENT_V2_LIMITS,
    VARIANT_STATES,
    componentPathsV2,
    isRequiredFactV2,
    requiredStatesV2,
    screenDocumentV2Schema,
    sourceResolverV2,
    variantPolicyV2,
    visitVariantNodesV2,
    type FactV2,
    type HeaderActionV2,
    type LabelTextRefV2,
    type PrimaryActionNodeV2,
    type ScreenDocumentV2,
    type ScreenNodeV2,
    type ScreenProposalV2,
    type ScreenStatesV2,
    type ScreenVariantV2,
    type SecondaryActionNodeV2,
    type TextRefV2,
    type VariantState,
} from './document-v2'
import { assembleDocumentV2, type AssembleDeps } from './document-v2-assemble'
import { BUSY_COPY_V2, STATE_COPY_V2 } from './document-v2-copy'
import type { ScreenContextInputsV2 } from './document-v2-context'
import {
    LAYOUT_DECISIONS_V2,
    LAYOUT_TEMPLATE_V2_CHECKING_VERSION,
    layoutTemplateProvenanceV2Schema,
    layoutTemplateSha256V2,
    layoutTemplateVariantsV2,
    parseLayoutTemplateV2,
    type FactSetV2,
    type LayoutDecisionV2,
    type RepeatFactsV2,
    type TemplateBodyRefV2,
    type TemplateLabelRefV2,
    type TemplateNodeV2,
    type TemplateVariantV2,
} from './document-v2-layout-template'
import { documentMaterialV2, type DocumentMaterialV2 } from './document-v2-material'
import { semanticIssuesV2 } from './document-v2-semantic'
import { syntheticDocumentFactsV2 } from './document-v2-recorded'
import { verifyDocumentAgainstInputsV2 } from './document-v2-verify'
import { canonicalJson } from './screen-context'

/**
 * Which ready variant of the record was compiled: the actual decision of a held check, the one of an answer,
 * `checking`, the held photo before its check returns (version 2 records only), or `questions`, the one ready
 * variant of the Question sheet over the held photo (version 3 records only).
 */
export type LayoutBranchV2 = LayoutDecisionV2 | 'answer' | 'checking' | 'questions'

/**
 * Where a compiled component came from in the raw record. `template` is the raw JSON path of the template node that
 * produced it (`ready.pass.body.children.1.row.children.0`, `states.busy.bar.primary`, `ready.pass.header.back`). A
 * component produced by a repeat also says which: its fact set, whether it is the `group` wrapper or a node of a `row`,
 * the group number, the fact's position in the set and its fact id, and, for a Citation, the citation chunk.
 */
export interface LayoutLineageV2 {
    template: string
    repeat: null | {
        set: FactSetV2
        role: 'group' | 'row'
        group: number
        index: number | null
        factId: string | null
        citation: number | null
    }
}

export interface CompileLayoutTemplateArgsV2 {
    /** The exact current inputs (the same value the document request and the context key are built from). */
    inputs: ScreenContextInputsV2
    /** The raw record, as parsed JSON. Nothing about it is trusted. */
    template: unknown
    /** The sidecar `{ authoring, templateSha256 }`, as parsed JSON. */
    provenance: unknown
    deps: AssembleDeps
}

export type LayoutCompileResultV2 =
    | {
          ok: true
          /** Complete and already validated: `source: 'generated'`, evidence `synthetic-fixture`, the record's author. */
          document: ScreenDocumentV2
          /** Recomputed canonical hash of the record that was compiled. */
          templateSha256: string
          branch: LayoutBranchV2
          /** Every component path of the document (`componentPathsV2`) with its origin in the raw record. */
          lineage: Readonly<Record<string, LayoutLineageV2>>
      }
    | {
          ok: false
          /** Machine codes only (a path and a rule, never record or manual text). */
          issues: string[]
          /** For an issue of the form `<document path>:<rule>`, the raw record path that produced that component. */
          where: Readonly<Record<string, string>>
      }

/** Stops an expansion that would exceed a guard (the guards of the compiled document are never loosened). */
class Stop extends Error {
    constructor(readonly code: string) {
        super(code)
    }
}

interface Scope {
    set: FactSetV2
    fact: FactV2
    index: number
    group: number
}

const isSafety = (fact: FactV2): boolean => fact.kind === 'safety' || fact.basis === 'safety-note'

/** Whether a fact belongs to a fact set (see `FACT_SETS_V2`). Overview facts belong to none. */
function inSet(set: FactSetV2, fact: FactV2): boolean {
    if (fact.basis === 'overview') return false
    if (fact.basis === 'result') {
        if (set === 'verdict') return fact.kind === 'verdict' || fact.kind === 'answer'

        return set === 'missing' && fact.kind === 'missing'
    }
    if (set === 'verdict' || set === 'missing') return false
    if (set === 'safety') return isSafety(fact)
    if (isSafety(fact)) return false

    return set === 'directions' ? isRequiredFactV2(fact) : !isRequiredFactV2(fact)
}

interface Expanded {
    variant: ScreenVariantV2
    headerLineage: Record<string, LayoutLineageV2>
}

/** Expands one template variant into a catalog variant for the facts this VARIANT may state. */
function expandVariant(
    variant: TemplateVariantV2,
    path: string,
    name: 'ready' | VariantState,
    material: DocumentMaterialV2,
    budget: { document: number },
    nodeLineage: WeakMap<object, LayoutLineageV2>,
    checking: boolean,
): Expanded {
    const { inputs } = material
    const policy = variantPolicyV2(inputs.kind, name, material.requirements, material)
    const withheld = new Set([...policy.forbiddenFacts, ...policy.forbiddenOverview])
    const available = material.facts.filter((fact) => !withheld.has(fact.factId))
    const resolve = sourceResolverV2(material.sources)
    // What a bound part-target Choice needs, exactly the complement of the shared `binding_unavailable` rule
    // (document-v2-semantic.ts): the app holds the photo and the step has a named part. Nothing else is read.
    const partTargets =
        (inputs.uiState?.capture ?? null) !== null && inputs.captureId !== null && material.partIds.length > 0
    const resultKind = inputs.result?.kind ?? 'check'
    const activity = inputs.uiState?.busy?.activity
    // Closed registry copy, selected by the actual witness (the busy activity) and the variant: nothing the app composes.
    // The checking branch is a ready slot whose witnessed activity is `checking` (see `pendingCheckV2`).
    const copy =
        name === 'ready'
            ? checking
                ? BUSY_COPY_V2.checking
                : null
            : name === 'busy' && activity !== undefined
              ? BUSY_COPY_V2[activity]
              : STATE_COPY_V2[name]
    let nodes = 0

    const pick = (set: FactSetV2): FactV2[] => available.filter((fact) => inSet(set, fact))
    const label = (ref: TemplateLabelRefV2 | TemplateBodyRefV2, at: string): TextRefV2 => {
        if (ref.kind !== 'state') return { ...ref }
        if (copy === null) throw new Stop(`state_copy:${at}`)

        return { kind: 'literal', text: copy[ref.part] }
    }
    const labelOrNull = (ref: TemplateLabelRefV2 | null, at: string): LabelTextRefV2 | null =>
        ref === null ? null : (label(ref, at) as LabelTextRefV2)
    const lineageOf = (at: string, scope: Scope | null, citation: number | null): LayoutLineageV2 => ({
        template: at,
        repeat:
            scope === null
                ? null
                : {
                      set: scope.set,
                      role: 'row',
                      group: scope.group,
                      index: scope.index,
                      factId: scope.fact.factId,
                      citation,
                  },
    })
    const emit = <N extends ScreenNodeV2>(made: N, depth: number, lineage: LayoutLineageV2): N => {
        if (depth > DOCUMENT_V2_LIMITS.depth) throw new Stop(`depth:${lineage.template}`)
        nodes += 1
        budget.document += 1
        if (nodes > DOCUMENT_V2_LIMITS.nodes) throw new Stop(`nodes:${lineage.template}`)
        if (budget.document > DOCUMENT_V2_LIMITS.documentNodes) throw new Stop(`document_nodes:${lineage.template}`)
        nodeLineage.set(made, lineage)

        return made
    }

    const list = (items: TemplateNodeV2[], at: string, depth: number, scope: Scope | null): ScreenNodeV2[] => {
        const out = items.flatMap((item, index) => place(item, `${at}.${index}`, depth, scope))
        if (out.length > DOCUMENT_V2_LIMITS.children) throw new Stop(`children:${at}`)

        return out
    }

    const repeat = (item: RepeatFactsV2, at: string, depth: number): ScreenNodeV2[] => {
        const facts = pick(item.source)
        const rowDepth = depth + (item.group === null ? 0 : 1)
        const rows = (from: number, to: number, group: number): ScreenNodeV2[] =>
            facts
                .slice(from, to)
                .map((fact, offset) =>
                    single(item.row, `${at}.row`, rowDepth, { set: item.source, fact, index: from + offset, group }),
                )
        if (item.group === null) return rows(0, facts.length, 0)
        const out: ScreenNodeV2[] = []
        for (let start = 0, group = 0; start < facts.length; start += item.group.size, group += 1) {
            const container = item.group.container
            const wrapper = {
                ...container,
                children: rows(start, start + item.group.size, group),
            } as ScreenNodeV2
            out.push(
                emit(wrapper, depth, {
                    template: `${at}.group.container`,
                    repeat: { set: item.source, role: 'group', group, index: null, factId: null, citation: null },
                }),
            )
        }

        return out
    }

    const place = (item: TemplateNodeV2, at: string, depth: number, scope: Scope | null): ScreenNodeV2[] => {
        switch (item.type) {
            case 'RepeatFacts':
                return repeat(item, at, depth)
            case 'WhenFacts':
                return pick(item.source).length === 0 ? [] : list(item.children, `${at}.children`, depth, scope)
            case 'WhenPartTargets':
                return partTargets ? list(item.children, `${at}.children`, depth, scope) : []
            case 'FactCitations': {
                if (scope === null) throw new Stop(`slot:${at}`)
                const indexes = resolve(scope.fact.sourceRefs)
                const out: ScreenNodeV2[] = []
                for (let start = 0, chunk = 0; start < indexes.length; start += item.chunk, chunk += 1) {
                    out.push(
                        emit(
                            {
                                type: 'Citation',
                                sources: indexes.slice(start, start + item.chunk),
                                label: labelOrNull(item.label, at),
                                display: item.display,
                            },
                            depth,
                            lineageOf(at, scope, chunk),
                        ),
                    )
                }

                return out
            }
            default:
                return [single(item, at, depth, scope)]
        }
    }

    // One node per template node (slots included, except the multi-node FactCitations and the repeat/when wrappers).
    const single = (
        item: Exclude<
            TemplateNodeV2,
            RepeatFactsV2 | { type: 'WhenFacts' } | { type: 'WhenPartTargets' } | { type: 'FactCitations' }
        >,
        at: string,
        depth: number,
        scope: Scope | null,
    ): ScreenNodeV2 => {
        const lineage = lineageOf(at, scope, null)
        switch (item.type) {
            case 'Section':
                return emit(
                    {
                        type: 'Section',
                        title: labelOrNull(item.title, at),
                        collapsible: item.collapsible,
                        initiallyOpen: item.initiallyOpen,
                        children: list(item.children, `${at}.children`, depth + 1, scope),
                    },
                    depth,
                    lineage,
                )
            case 'Stack':
            case 'Row':
            case 'Grid':
            case 'Card':
            case 'Scroll':
                return emit(
                    { ...item, children: list(item.children, `${at}.children`, depth + 1, scope) } as ScreenNodeV2,
                    depth,
                    lineage,
                )
            case 'Text':
                return emit({ ...item, content: label(item.content, at) }, depth, lineage)
            case 'Image':
                return emit(
                    { ...item, source: { kind: 'capture' }, caption: labelOrNull(item.caption, at) },
                    depth,
                    lineage,
                )
            case 'Badge':
                return emit({ ...item, label: label(item.label, at) as LabelTextRefV2 }, depth, lineage)
            case 'Checklist':
                return emit(
                    {
                        ...item,
                        items: item.items.map((entry) => ({
                            ...entry,
                            label: label(entry.label, at) as LabelTextRefV2,
                        })),
                    },
                    depth,
                    lineage,
                )
            case 'Progress':
            case 'Meter':
                return emit({ ...item, label: labelOrNull(item.label, at) }, depth, lineage)
            case 'TextField':
                return emit(
                    {
                        type: 'TextField',
                        binding: 'question',
                        label: label(item.label, at) as LabelTextRefV2,
                        placeholder: null,
                    },
                    depth,
                    lineage,
                )
            case 'Choice':
                return emit(
                    {
                        type: 'Choice',
                        prompt: labelOrNull(item.prompt, at),
                        options: { mode: 'bound', binding: 'part-target' },
                    },
                    depth,
                    lineage,
                )
            case 'FactText': {
                if (scope === null) throw new Stop(`slot:${at}`)
                const { role, emphasis, tone, align } = item

                return emit(
                    { type: 'Text', content: { kind: 'fact', factId: scope.fact.factId }, role, emphasis, tone, align },
                    depth,
                    lineage,
                )
            }
            case 'ResultCard':
                return emit(
                    {
                        type: 'VerdictCard',
                        result: resultKind,
                        variant: item.variant,
                        showReason: item.showReason,
                        showRegions: item.showRegions,
                    },
                    depth,
                    lineage,
                )
            default:
                return emit({ ...item }, depth, lineage)
        }
    }

    const copyAction = (action: HeaderActionV2): HeaderActionV2 => ({ ...action, intent: { ...action.intent } })
    const prefix = name === 'ready' ? '' : `states.${name}.`
    const headerLineage: Record<string, LayoutLineageV2> = {
        [`${prefix}header`]: { template: `${path}.header`, repeat: null },
    }
    const { header } = variant
    if (header.back) headerLineage[`${prefix}header.back`] = { template: `${path}.header.back`, repeat: null }
    header.actions.forEach((_action, index) => {
        headerLineage[`${prefix}header.actions.${index}`] = {
            template: `${path}.header.actions.${index}`,
            repeat: null,
        }
    })
    const body = single(variant.body, `${path}.body`, 1, null)
    const action = <A extends PrimaryActionNodeV2 | SecondaryActionNodeV2>(made: A, at: string): A =>
        emit({ ...made, intent: { ...made.intent } } as A, 1, { template: at, repeat: null })

    return {
        variant: {
            header: {
                title: label(header.title, `${path}.header`) as LabelTextRefV2,
                subtitle: labelOrNull(header.subtitle, `${path}.header`),
                back: header.back ? copyAction(header.back) : null,
                actions: header.actions.map(copyAction),
            },
            body,
            bar: {
                primary: action(variant.bar.primary, `${path}.bar.primary`),
                secondary: variant.bar.secondary ? action(variant.bar.secondary, `${path}.bar.secondary`) : null,
            },
            overlays: [],
        },
        headerLineage,
    }
}

const slug = (message: string): string =>
    message
        .toLowerCase()
        .replace(/[^a-z0-9]+/gu, '_')
        .replace(/^_|_$/gu, '')
        .slice(0, 64)

function failure(issues: readonly string[], where: Record<string, string> = {}): LayoutCompileResultV2 {
    return { ok: false, issues: [...new Set(issues)].slice(0, 16), where }
}

/**
 * What the held Question sheet needs of its inputs, all of it witnessed and none of it predicted: a reviewed manual
 * that has the current step, the photo the app actually holds (named by the inputs and by the held-capture state), and
 * no result and no failure. A result or failure is refused in the raw inputs as well as the normalized ones, so nothing
 * a caller sent is silently ignored. Without the witnesses there is no Question to compile (the app shows its camera
 * first).
 */
function questionInputIssues(raw: ScreenContextInputsV2, material: DocumentMaterialV2): string[] {
    const { inputs } = material
    if (inputs.kind !== 'questions') return ['inputs::kind_unsupported']
    const issues: string[] = []
    if (!material.reviewed) issues.push('inputs::not_reviewed')
    if (material.step === null) issues.push('inputs::no_step')
    if (inputs.captureId === null || raw.captureId !== inputs.captureId) issues.push('inputs::no_capture')
    if (raw.result !== null || inputs.result !== null || (raw.companionAnswer ?? null) !== null) {
        issues.push('inputs::result_provided')
    }
    if (raw.failure !== null || inputs.failure !== null) issues.push('inputs::failure_provided')

    return issues
}

function compile(args: CompileLayoutTemplateArgsV2): LayoutCompileResultV2 {
    const provenance = layoutTemplateProvenanceV2Schema.safeParse(args.provenance)
    if (!provenance.success) {
        return failure(
            provenance.error.issues.map((issue) => `provenance:${issue.path.map(String).join('.')}:${issue.code}`),
        )
    }
    const parsed = parseLayoutTemplateV2(args.template)
    if (!parsed.ok) return failure(parsed.issues)
    const { template } = parsed
    const templateSha256 = layoutTemplateSha256V2(template, args.deps.sha256Hex)
    const bad: string[] = []
    if (templateSha256 !== provenance.data.templateSha256) bad.push('provenance::hash_mismatch')
    if (template.kind !== args.inputs.kind) bad.push('template::kind_mismatch')
    if (provenance.data.authoring.fixtureId !== template.fixtureId) bad.push('provenance::fixture_mismatch')
    const material = documentMaterialV2(args.inputs)
    const held = material.inputs.result
    if (template.kind === 'questions') bad.push(...questionInputIssues(args.inputs, material))
    else if (material.inputs.kind !== 'result' && material.inputs.kind !== 'answer')
        bad.push('inputs::kind_unsupported')
    else if (held === null && !material.pendingCheck) bad.push('inputs::no_result')
    else if (held !== null && held.kind !== (material.inputs.kind === 'result' ? 'check' : 'question'))
        bad.push('inputs::result_mismatch')
    if (bad.length > 0) return failure(bad)

    const decision = material.decision
    let ready: TemplateVariantV2
    let branch: LayoutBranchV2
    if (template.kind === 'questions') {
        // The Question sheet has one ready screen: no decision, no checking, no result to choose from.
        ready = template.ready
        branch = 'questions'
    } else if (template.kind === 'result' && material.pendingCheck) {
        // The held photo before its check returns: only a version 2 record owns that screen; a version 1 record cannot.
        if (template.version !== LAYOUT_TEMPLATE_V2_CHECKING_VERSION) return failure(['inputs::pending_unsupported'])
        ready = template.ready.checking
        branch = 'checking'
    } else if (template.kind === 'result') {
        if (decision === null) return failure(['inputs::no_decision'])
        ready = template.ready[decision]
        branch = decision
    } else {
        ready = template.ready
        branch = 'answer'
    }

    // Expansion. Every compiled component is produced by exactly one template node, never by the compiler itself.
    const budget = { document: 0 }
    const nodeLineage = new WeakMap<object, LayoutLineageV2>()
    const readyAt = layoutTemplateVariantsV2(template).find((entry) => entry.variant === ready)?.path ?? 'ready'
    let readyExpanded: Expanded
    const states: Partial<Record<VariantState, ScreenVariantV2>> = {}
    const headerLineage: Record<string, LayoutLineageV2> = {}
    try {
        readyExpanded = expandVariant(ready, readyAt, 'ready', material, budget, nodeLineage, branch === 'checking')
        Object.assign(headerLineage, readyExpanded.headerLineage)
        // The variants this kind owes, as the shared contract names them (a Question also owes `empty`).
        for (const state of requiredStatesV2(template.kind)) {
            const authored = (template.states as Partial<Record<VariantState, TemplateVariantV2>>)[state]
            if (authored === undefined) return failure([`template:states.${state}:missing`])
            const expanded = expandVariant(authored, `states.${state}`, state, material, budget, nodeLineage, false)
            states[state] = expanded.variant
            Object.assign(headerLineage, expanded.headerLineage)
        }
    } catch (error) {
        if (error instanceof Stop) return failure([`expansion:${error.code}`])
        throw error
    }
    const statesV2 = Object.fromEntries(VARIANT_STATES.map((state) => [state, states[state] ?? null])) as ScreenStatesV2
    const proposal: ScreenProposalV2 = { ...readyExpanded.variant, states: statesV2 }

    // Lineage must cover every component exactly (header and controls included): a component without an origin is a bug.
    const lineage: Record<string, LayoutLineageV2> = { ...headerLineage }
    const variants: { prefix: string; variant: ScreenVariantV2 }[] = [
        { prefix: '', variant: proposal },
        ...VARIANT_STATES.flatMap((state) =>
            statesV2[state] === null ? [] : [{ prefix: `states.${state}.`, variant: statesV2[state] }],
        ),
    ]
    for (const { prefix, variant } of variants) {
        visitVariantNodesV2(variant, prefix, ({ node, path }) => {
            const entry = nodeLineage.get(node)
            if (entry !== undefined) lineage[path] = entry
        })
    }
    const expected = componentPathsV2(proposal)
    if (expected.length !== Object.keys(lineage).length || expected.some((path) => lineage[path] === undefined)) {
        return failure(['lineage::incomplete'])
    }

    const where = (issues: readonly string[]): Record<string, string> =>
        Object.fromEntries(
            issues.flatMap((issue) => {
                const path = issue.slice(0, issue.lastIndexOf(':'))
                const origin = lineage[path]

                return origin === undefined ? [] : [[path, origin.template] as const]
            }),
        )

    // The shared gates, unchanged: structure and mandatory witnesses (the published-document schema), then the semantic
    // rules (closed copy, intents, bindings, earned state), then the request-bound check of the identity.
    const document = assembleDocumentV2(
        material,
        proposal,
        syntheticDocumentFactsV2(provenance.data.authoring),
        args.deps,
    )
    const checked = screenDocumentV2Schema.safeParse(document)
    const contract = checked.success
        ? []
        : checked.error.issues.map((issue) =>
              issue.code === 'custom'
                  ? `contract:${slug(issue.message)}`
                  : `${issue.path.slice(0, 3).map(String).join('.')}:${issue.code}`,
          )
    const semantic = semanticIssuesV2(proposal, material)
    if (!checked.success || semantic.length > 0) {
        return failure([...contract, ...semantic], where(semantic))
    }
    const identity = verifyDocumentAgainstInputsV2(checked.data, args.inputs, args.deps.sha256Hex)
    if (identity.length > 0) return failure(identity.map((code) => `verify::${code}`))

    // Provenance is the record's own, never the caller's: a generated fixture authored by the attested author.
    const { metadata } = checked.data
    if (
        metadata.source !== 'generated' ||
        metadata.evidence !== 'synthetic-fixture' ||
        metadata.model !== null ||
        metadata.effort !== null ||
        canonicalJson(metadata.authoring) !== canonicalJson(provenance.data.authoring) ||
        Object.values(metadata.origins).some((origin) => origin !== 'generated')
    ) {
        return failure(['provenance::not_attested'])
    }
    return { ok: true, document: checked.data, templateSha256, branch, lineage }
}

/**
 * Compiles a model-authored layout record into the complete `ScreenDocumentV2` of the exact current inputs, or says why
 * it cannot. Pure and synchronous: it never calls a provider, records no receipt and never builds a fallback document
 * (the caller keeps its truthful fallback when this fails). What it supplies is witnessed data and repetitions only:
 * the facts, their source indexes, the held photo/verdict card and closed state copy, each placed exactly where the
 * record's slots say. Everything is validated by `assembleDocumentV2`, `screenDocumentV2Schema`, the shared semantic
 * rules and `verifyDocumentAgainstInputsV2`, all unchanged.
 */
export function compileLayoutTemplateV2(args: CompileLayoutTemplateArgsV2): LayoutCompileResultV2 {
    try {
        return compile(args)
    } catch {
        // Fail closed: an unexpected fault (say, a hostile record that defeats a guard) is a rejection, never a crash.
        return failure(['template::internal_error'])
    }
}

/** The decisions a `result` record owes, re-exported so a caller can enumerate branches without a second import. */
export const LAYOUT_RESULT_BRANCHES_V2: readonly LayoutDecisionV2[] = LAYOUT_DECISIONS_V2
