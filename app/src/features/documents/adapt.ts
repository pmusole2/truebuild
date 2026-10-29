import type {
    ScreenDocument,
    ScreenDocumentV2,
    ScreenNode,
    ScreenNodeV2,
    ScreenVariantV2,
    TextRefV2,
} from '@truebuild/contracts'
import type { FrameBar, FrameDocument, FrameKind, FrameNode, FrameVariant } from './types'

/** Compatibility adapters for retained v1/demo tests only. Production v2 routes never flatten or re-key a document. */

/** Resolves live bound text (`manual-title`, `step-position`, …) from controller state. Never invented here. */
export type BoundTextResolver = (key: string) => string

type FactsTable = ReadonlyMap<string, string>

function resolveText(ref: TextRefV2, facts: FactsTable, bound: (key: string) => string): string {
    switch (ref.kind) {
        case 'literal':
            return ref.text
        case 'fact':
            return facts.get(ref.factId) ?? ''
        case 'bound':
            return bound(ref.key)
    }
}

const GAP: Readonly<Record<string, 'xs' | 'sm' | 'md' | 'lg'>> = {
    none: 'xs',
    xs: 'xs',
    sm: 'sm',
    md: 'md',
    lg: 'lg',
    xl: 'lg',
}

function adaptV2Node(
    node: ScreenNodeV2,
    facts: FactsTable,
    bound: (key: string) => string,
    doc: ScreenDocumentV2,
): FrameNode {
    const text = (ref: TextRefV2): string => resolveText(ref, facts, bound)
    switch (node.type) {
        case 'Stack':
            return {
                type: 'Stack',
                gap: GAP[node.gap] ?? 'sm',
                children: node.children.map((c) => adaptV2Node(c, facts, bound, doc)),
            }
        case 'Row':
            return {
                type: 'Row',
                gap: GAP[node.gap] ?? 'sm',
                children: node.children.map((c) => adaptV2Node(c, facts, bound, doc)),
            }
        case 'Grid':
            return {
                type: 'Grid',
                columns: node.columns,
                children: node.children.map((c) => adaptV2Node(c, facts, bound, doc)),
            }
        case 'Card':
            return {
                type: 'Card',
                tone: node.surface === 'raised' ? 'raised' : 'surface',
                children: node.children.map((c) => adaptV2Node(c, facts, bound, doc)),
            }
        case 'Section':
            return {
                type: 'Section',
                label: node.title === null ? '' : text(node.title),
                initiallyOpen: node.initiallyOpen,
                collapsible: node.collapsible,
                children: node.children.map((c) => adaptV2Node(c, facts, bound, doc)),
            }
        case 'Scroll':
            return { type: 'Scroll', children: node.children.map((c) => adaptV2Node(c, facts, bound, doc)) }
        case 'Divider':
            return { type: 'Divider' }
        case 'Spacer':
            return { type: 'Spacer', size: node.size === 'xl' ? 'lg' : node.size === 'none' ? 'xs' : node.size }
        case 'Text':
            return {
                type: 'Instruction',
                text: text(node.content),
                emphasis:
                    node.role === 'caption' || node.role === 'label'
                        ? 'quiet'
                        : node.emphasis === 'quiet'
                          ? 'quiet'
                          : node.emphasis,
                citations: [],
            }
        case 'Image': {
            const source = node.source
            const refId =
                source.kind === 'page'
                    ? source.pageId
                    : source.kind === 'part'
                      ? source.partId
                      : source.kind === 'capture'
                        ? (doc.bound.captureId ?? '')
                        : (doc.sources[source.index]?.pageId ?? '')
            const heroSource = source.kind === 'capture' ? 'capture' : source.kind === 'part' ? 'part' : 'page'
            return {
                type: 'HeroFigure',
                source: heroSource,
                refId,
                caption: node.caption === null ? null : text(node.caption),
                fit: node.fit,
            }
        }
        case 'Citation':
            return {
                type: 'SourceDetails',
                label: node.label === null ? 'See it in the manual' : text(node.label),
                sources: [...node.sources],
                fit: 'contain',
                initiallyOpen: false,
            }
        case 'ManualPage':
            return {
                type: 'SourceDetails',
                label: node.label === null ? 'Manual page' : text(node.label),
                sources: [...node.sources],
                fit: node.fit,
                initiallyOpen: node.initiallyOpen,
            }
        case 'Checklist':
            return {
                type: 'PartList',
                showQuantities: false,
                items: node.items.map((item, index) => ({
                    partId: `item-${index}`,
                    label: text(item.label),
                    quantity: null,
                })),
            }
        case 'ManualList':
            return {
                type: 'ManualLibrary',
                entries: node.entries,
                layout: node.layout,
                showProgress: node.showProgress,
                emptyText: null,
            }
        case 'PageList':
            return {
                type: 'PageGallery',
                pages: 'session',
                layout: node.layout,
                showNumbers: node.showNumbers,
                action: null,
            }
        case 'FactEditor':
            return {
                type: 'FactEditor',
                questionRef: 'current',
                kind: node.kind,
                label: node.label,
                saveLabel: node.saveLabel,
                cancelLabel: node.cancelLabel,
            }
        case 'PrimaryAction':
        case 'SecondaryAction':
            return { type: 'ActionLink', label: node.label, icon: node.icon, intent: node.intent, emphasis: 'normal' }
        case 'Choice':
            return node.options.mode === 'intents'
                ? {
                      type: 'ChoiceList',
                      prompt: node.prompt === null ? null : text(node.prompt),
                      options: node.options.items.map((item) => ({ label: item.label, intent: item.intent })),
                  }
                : { type: 'V2Leaf', node }
        default:
            // Content/control/native leaves with live bindings render natively in the renderer.
            return { type: 'V2Leaf', node }
    }
}

function adaptV2Bar(variant: ScreenVariantV2): FrameBar {
    return {
        primary: {
            label: variant.bar.primary.label,
            icon: variant.bar.primary.icon,
            intent: variant.bar.primary.intent,
        },
        secondary:
            variant.bar.secondary === null
                ? null
                : {
                      label: variant.bar.secondary.label,
                      icon: variant.bar.secondary.icon,
                      intent: variant.bar.secondary.intent,
                  },
    }
}

function frameVariantName(state: string): FrameVariant | null {
    switch (state) {
        case 'busy':
            return 'busy'
        case 'pending':
            return 'pending'
        case 'empty':
            return 'empty'
        case 'error':
            return 'error'
        case 'recovery':
            return 'recovery'
        default:
            return null
    }
}

/** V2 origin paths (`body.0.2`) in frame path form (`body.0.children.2`); header/bar keys already match. */
function frameOrigins(document: ScreenDocumentV2): Readonly<Record<string, 'generated' | 'fallback' | 'shell'>> {
    const out: Record<string, 'generated' | 'fallback' | 'shell'> = {}
    for (const [path, origin] of Object.entries(document.metadata.origins)) {
        if (path.startsWith('states.')) continue
        const parts = path.split('.')
        if (parts[0] === 'body' && parts.length > 2) {
            out[['body', parts[1], ...parts.slice(2).flatMap((p) => ['children', p])].join('.')] = origin as never
        } else {
            out[path] = origin as never
        }
    }
    return out
}

/**
 * Consumes the real exported `ScreenDocumentV2`. TextRefs are resolved against the document's own fact table and
 * the caller's live bound-text resolver; layout stays a recursive tree; every state variant stays a document.
 */
export function adaptScreenDocumentV2(
    document: ScreenDocumentV2,
    boundText: (key: string) => string = (): string => '',
): FrameDocument {
    const facts: FactsTable = new Map(document.facts.map((fact) => [fact.factId, fact.text]))
    const adaptBody = (variant: ScreenVariantV2): FrameNode[] => [adaptV2Node(variant.body, facts, boundText, document)]
    const variants: Partial<Record<FrameVariant, { body: FrameNode[]; bar: FrameBar }>> = {}
    for (const [state, variant] of Object.entries(document.states)) {
        if (variant === null) continue
        const name = frameVariantName(state)
        if (name === null) continue
        variants[name] = { body: adaptBody(variant), bar: adaptV2Bar(variant) }
    }
    const ready: ScreenVariantV2 = {
        header: document.header,
        body: document.body,
        bar: document.bar,
        overlays: document.overlays,
    }
    return {
        kind: document.kind as FrameKind,
        source: document.metadata.source,
        bound: {
            manualId: document.bound.manualId,
            revision: document.bound.revision,
            stepId: document.bound.stepId,
            captureId: document.bound.captureId,
        },
        header: {
            title: resolveText(document.header.title, facts, boundText),
            subtitle:
                document.header.subtitle === null ? null : resolveText(document.header.subtitle, facts, boundText),
            trailing: document.header.actions[0]?.intent ?? document.header.back?.intent ?? null,
            actions: document.header.actions.map((action) => ({ label: action.label, intent: action.intent })),
        },
        body: adaptBody(ready),
        bar: adaptV2Bar(ready),
        variants,
        origins: frameOrigins(document),
        sources: document.sources,
        manualFacts: document.facts.map((fact) => ({ ...fact, placement: 'body' as const })),
        requiredFactIds: document.requirements.facts,
    }
}

/** Widens one v1 node into the recursive frame tree (leaf-only containers become Stack/Section). */
export function widenFrameNode(node: ScreenNode): FrameNode {
    if (node.type === 'Group') {
        return {
            type: node.layout === 'row' ? 'Row' : 'Stack',
            gap: 'sm',
            children: node.children.map(widenFrameNode),
        }
    }
    if (node.type === 'DetailsDisclosure') {
        return {
            type: 'Section',
            label: node.label,
            initiallyOpen: node.initiallyOpen,
            children: node.children.map(widenFrameNode),
        }
    }
    return node
}

export function adaptScreenDocument(document: ScreenDocument): FrameDocument {
    const origin = document.metadata.source === 'generated' ? 'generated' : 'fallback'
    return {
        kind: document.kind as FrameKind,
        source: origin,
        bound: {
            manualId: document.bound.manualId,
            revision: document.bound.revision,
            stepId: document.bound.stepId,
            captureId: document.bound.captureId,
        },
        header: {
            title: document.header.title,
            subtitle: document.header.subtitle,
            trailing: document.header.trailing,
        },
        body: document.body.map(widenFrameNode),
        bar: {
            primary: {
                label: document.bar.primary.label,
                icon: document.bar.primary.icon,
                intent: document.bar.primary.intent,
            },
            secondary:
                document.bar.secondary === null
                    ? null
                    : {
                          label: document.bar.secondary.label,
                          icon: document.bar.secondary.icon,
                          intent: document.bar.secondary.intent,
                      },
        },
        ...(document.metadata.origins === undefined ? {} : { origins: document.metadata.origins }),
        ...(document.sources === undefined ? {} : { sources: document.sources }),
        ...(document.manualFacts === undefined ? {} : { manualFacts: document.manualFacts }),
        requiredFactIds: (document.manualFacts ?? [])
            .filter((fact) => fact.basis !== 'direction')
            .map((fact) => fact.factId),
    }
}
