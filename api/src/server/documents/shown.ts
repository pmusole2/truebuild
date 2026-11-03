import {
    allowedLiteralsV2,
    documentMaterialV2,
    intentAllowedV2,
    nodeChildrenV2,
    nodeTextRefsV2,
    screenFacts,
    sourceKeyV2,
    type DocumentSourceV2,
    type ManualSession,
    type ScreenDocumentV2,
    type ScreenNodeV2,
    type TextRefV2,
} from '@truebuild/contracts'

import { SHOWN_BLOCK_LIMIT, shownScreenV2Schema, type ShownBlock, type ShownScreen } from '../../providers/shown-screen'
import { normalize } from '../screens/text'

/**
 * What the server remembers of a version 2 guide or camera page it issued: the CHOICES the published document made (node
 * order and nesting, which fact, part, figure and citation each node uses, the bar), never texts or geometry of its own.
 * It is a projection of the validated document only (never of a model draft), and it is not trusted when it is used:
 * `resolveShownV2` rebuilds every text, part name, quantity, region and source from the manual of the request and drops
 * what that manual no longer states. It describes the composition, not the pixels a person saw.
 */
type Figure =
    { kind: 'source'; ref: DocumentSourceV2 } | { kind: 'page'; pageId: string } | { kind: 'part'; partId: string }

export interface IssuedBlockV2 {
    path: string
    type: string
    origin: ShownBlock['origin']
    emphasis?: 'normal' | 'strong' | 'quiet'
    tone?: 'caution' | 'critical'
    /** The first TextRef the node writes (its words), resolved only against the current manual. */
    words?: TextRefV2
    /** Facts the node states, with the exact text the page showed (a changed manual drops them). */
    facts?: { factId: string; text: string }[]
    partIds?: string[]
    figure?: { figure: Figure; fit: 'cover' | 'contain' }
    sources?: DocumentSourceV2[]
    collapsed?: true
    label?: string
}

export interface IssuedShownV2 {
    header: { title: TextRefV2; subtitle: TextRefV2 | null }
    bar: { primary: IssuedAction; secondary: IssuedAction | null } | null
    blocks: IssuedBlockV2[]
    /** False when the page has more blocks than a provider payload may carry; its facts are still resolved. */
    projectable: boolean
}
interface IssuedAction {
    label: string
    intent: string
    target: string
}

/** The projection of a published document's READY variant (the step guide or the camera page). */
export function issueShownV2(document: ScreenDocumentV2): IssuedShownV2 {
    const origins = document.metadata.origins
    const facts = new Map(document.facts.map((fact) => [fact.factId, fact.text]))
    // A published document names the origin of every component it emits; a missing one is an error, never `fallback`.
    const originOf = (path: string): ShownBlock['origin'] => {
        const origin = origins[path]
        if (origin === undefined) throw new Error(`missing_origin:${path}`)
        // Only the ready variant is projected, and its origin is always the document's own source.
        if (origin === 'shell') throw new Error(`unexpected_shell_origin:${path}`)
        return origin
    }
    const cites = (indexes: readonly number[]): DocumentSourceV2[] =>
        indexes.flatMap((index) => {
            const source = document.sources[index]
            return source === undefined ? [] : [source]
        })
    const blocks: IssuedBlockV2[] = []
    const walk = (node: ScreenNodeV2, path: string): void => {
        const block: IssuedBlockV2 = { path, type: node.type, origin: originOf(path) }
        if (node.type === 'Text') {
            block.emphasis = node.emphasis
            if (node.tone === 'caution' || node.tone === 'critical') block.tone = node.tone
        }
        const [words] = nodeTextRefsV2(node)
        if (words !== undefined) block.words = words
        const stated = nodeTextRefsV2(node).flatMap((ref) =>
            ref.kind === 'fact' && facts.has(ref.factId) ? [{ factId: ref.factId, text: facts.get(ref.factId)! }] : [],
        )
        if (stated.length > 0) block.facts = stated
        if (node.type === 'PieceTile') block.partIds = [node.partId]
        if (node.type === 'Image') {
            const source = node.source
            const figure: Figure | null =
                source.kind === 'source'
                    ? document.sources[source.index] === undefined
                        ? null
                        : { kind: 'source', ref: document.sources[source.index]! }
                    : source.kind === 'page'
                      ? { kind: 'page', pageId: source.pageId }
                      : source.kind === 'part'
                        ? { kind: 'part', partId: source.partId }
                        : null
            if (figure !== null) block.figure = { figure, fit: node.fit }
        }
        if (node.type === 'Citation' || node.type === 'ManualPage') block.sources = cites(node.sources)
        if (node.type === 'CameraView') block.label = node.cue
        if (node.type === 'PrimaryAction' || node.type === 'SecondaryAction') block.label = node.label
        const closed = node.type === 'Section' && node.collapsible && !node.initiallyOpen
        if (closed) block.collapsed = true
        blocks.push(block)
        if (closed) return
        nodeChildrenV2(node).forEach((child, index) => walk(child, `${path}.${index}`))
    }
    walk(document.body, 'body')
    const action = (
        value: { label: string; intent: { intent: string; target: string } } | null,
    ): IssuedAction | null =>
        value === null ? null : { label: value.label, intent: value.intent.intent, target: value.intent.target }
    return {
        header: { title: document.header.title, subtitle: document.header.subtitle },
        bar: { primary: action(document.bar.primary)!, secondary: action(document.bar.secondary) },
        blocks,
        projectable: blocks.length <= SHOWN_BLOCK_LIMIT,
    }
}

/** Re-verifies an issued projection against the manual of the current request. Anything that fails is dropped. */
export function resolveShownV2(
    issued: IssuedShownV2,
    session: ManualSession,
    stepId: string,
    legacyDirections = false,
): ShownScreen | undefined {
    const material = documentMaterialV2(
        {
            kind: 'guide',
            session,
            stepId,
            captureId: null,
            result: null,
            failure: null,
            uiState: null,
        },
        legacyDirections,
    )
    const current = new Map(material.facts.filter((fact) => fact.basis !== 'result').map((fact) => [fact.factId, fact]))
    const manual = screenFacts(session)
    const step = material.step
    const names = new Map(
        (manual?.parts ?? []).flatMap((part) => (part.name.state === 'known' ? [[part.partId, part.name.value]] : [])),
    )
    const quantities = new Map(
        (step?.parts ?? []).flatMap((part) =>
            part.quantity.state === 'known' ? [[part.partId, part.quantity.value]] : [],
        ),
    )
    const carried = new Set<string>(
        [...(step?.sourceRefs ?? []), ...material.facts.flatMap((fact) => fact.sourceRefs)].map((ref) =>
            sourceKeyV2({ pageId: ref.pageId, region: ref.region }),
        ),
    )
    const carriedPages = new Set([...carried].map((key) => key.slice(0, key.indexOf('|'))))
    const pageIds = new Set(session.pages.map((page) => page.pageId))
    const known = (source: DocumentSourceV2): boolean =>
        carried.has(sourceKeyV2(source)) ||
        (source.region === null && carriedPages.has(source.pageId) && pageIds.has(source.pageId))
    const listed = new Set(allowedLiteralsV2(material, 'ready').map(normalize))
    const wording = (ref: TextRefV2 | undefined): string | undefined => {
        if (ref?.kind === 'literal' && listed.has(normalize(ref.text))) return ref.text
        return undefined
    }
    const resolveRef = (ref: TextRefV2): string | undefined => {
        if (ref.kind === 'literal') return wording(ref)
        if (ref.kind === 'fact') return current.get(ref.factId)?.text
        if (ref.key === 'step-title') return step?.title
        if (ref.key === 'manual-title') return session.title
        if (ref.key === 'step-position' && step) return `Step ${step.order} of ${material.stepCount}`
        return undefined
    }

    const placed = new Set<string>()
    const blocks = issued.blocks.map((block): ShownBlock => {
        const out: ShownBlock = { path: block.path, type: block.type, origin: block.origin }
        if (block.emphasis !== undefined) out.emphasis = block.emphasis
        if (block.tone !== undefined) out.tone = block.tone
        if (block.collapsed) out.collapsed = true
        const kept = (block.facts ?? []).filter((fact) => {
            const now = current.get(fact.factId)
            return now !== undefined && now.text === fact.text
        })
        if (kept.length > 0) {
            out.factIds = kept.map((fact) => fact.factId)
            for (const fact of kept) placed.add(fact.factId)
        }
        const text = block.words?.kind === 'literal' ? wording(block.words) : undefined
        if (text !== undefined && block.type !== 'Section') out.text = text
        const label = block.label ?? (block.type === 'Section' ? text : undefined)
        if (label !== undefined && label.length <= 60) out.label = label
        if (block.partIds !== undefined) {
            const parts = block.partIds.flatMap((partId) => {
                const name = names.get(partId)
                if (name === undefined || !material.partIds.includes(partId)) return []
                return [{ partId, label: name.slice(0, 60), quantity: quantities.get(partId) ?? null }]
            })
            if (parts.length > 0) out.parts = parts
        }
        if (block.figure !== undefined) {
            const { figure, fit } = block.figure
            if (figure.kind === 'source' && known(figure.ref)) {
                out.figure = { source: 'page', refId: figure.ref.pageId, fit, region: figure.ref.region }
            } else if (
                figure.kind === 'source' &&
                pageIds.has(figure.ref.pageId) &&
                carriedPages.has(figure.ref.pageId)
            ) {
                // The region is no longer one the manual carries: keep the page, never the region.
                out.figure = { source: 'page', refId: figure.ref.pageId, fit, region: null }
            } else if (figure.kind === 'page' && pageIds.has(figure.pageId) && carriedPages.has(figure.pageId)) {
                out.figure = { source: 'page', refId: figure.pageId, fit, region: null }
            } else if (figure.kind === 'part' && material.partIds.includes(figure.partId)) {
                out.figure = { source: 'part', refId: figure.partId, fit, region: null }
            }
        }
        if (block.sources !== undefined) {
            const sources = block.sources.filter(known)
            if (sources.length > 0)
                out.sources = sources.map((source) => ({ pageId: source.pageId, region: source.region }))
        }
        return out
    })

    const resolveHeader = (): ShownScreen['header'] => {
        const title = resolveRef(issued.header.title)
        if (title === undefined || title.length > 200) return undefined
        const subtitle = issued.header.subtitle === null ? null : (resolveRef(issued.header.subtitle) ?? null)
        return { title, subtitle: subtitle !== null && subtitle.length > 200 ? null : subtitle }
    }
    const verifyAction = (action: IssuedAction | null): IssuedAction | null => {
        if (action === null) return null
        const intent = { intent: action.intent, target: action.target } as Parameters<typeof intentAllowedV2>[0]
        return intentAllowedV2(intent, material) ? action : null
    }
    const resolveBar = (): ShownScreen['bar'] => {
        if (issued.bar === null) return undefined
        const primary = verifyAction(issued.bar.primary)
        return primary === null ? undefined : { primary, secondary: verifyAction(issued.bar.secondary) }
    }
    const header = resolveHeader()
    const bar = resolveBar()

    const remainderFactIds = material.requirements.facts.filter((id) => current.has(id) && !placed.has(id))
    const parsed = issued.projectable
        ? shownScreenV2Schema.safeParse({
              ...(header === undefined ? {} : { header }),
              ...(bar === undefined ? {} : { bar }),
              blocks,
              remainderFactIds,
          })
        : null
    return parsed?.success ? parsed.data : undefined
}
