import { useState, type ReactElement } from 'react'
import { Pressable, StyleSheet, View } from 'react-native'
import {
    requiredManualFacts,
    type ManualFact,
    type ManualSession,
    type PublishedManualFact,
    type ScreenDocument,
    type ScreenNode,
} from '@truebuild/contracts'
import { SourceDiagrams } from '../capture/step-facts'
import { useOptionalWorkflow } from '../capture/workflow-context'
import { Notice } from '../../ui/status'
import { Body, Caption, Instruction } from '../../ui/text'
import { space, touchTarget } from '../../theme/tokens'
import type { BlockContext } from './blocks'
import { originId, RenderOriginProvider, useOriginNativeId, type RenderOrigin } from './render-origin'
import { safetyKey } from './safety'

type DirectionsNode = Extract<ScreenNode, { type: 'ManualDirections' }>

/**
 * Citation mechanics belong to the exact fact node that placed them. Unowned use remains shell.
 */
function FactSource({
    fact,
    session,
    pageUris,
}: {
    fact: Pick<ManualFact, 'factId' | 'sourceRefs'>
    session: ManualSession | undefined
    pageUris: Readonly<Record<string, string>>
}): ReactElement | null {
    const [open, setOpen] = useState(false)
    const origin = useOriginNativeId()
    if (session === undefined) return null
    const pages = new Set(session.pages.map((page) => page.pageId))
    const refs = fact.sourceRefs.filter((ref) => pages.has(ref.pageId))
    // A citation to a page this manual does not hold shows nothing rather than a broken link.
    if (refs.length === 0) return null
    return (
        <>
            <Pressable
                nativeID={origin}
                testID="fact-source"
                accessibilityRole="button"
                accessibilityLabel={open ? 'Hide this in the manual' : 'Show this in the manual'}
                accessibilityState={{ expanded: open }}
                onPress={(): void => setOpen(!open)}
                style={styles.source}
            >
                <Caption>{open ? 'Hide the manual page' : 'See it in the manual'}</Caption>
            </Pressable>
            {open ? (
                <View testID="fact-source-content" nativeID={origin}>
                    <SourceDiagrams refs={refs} session={session} pageUris={pageUris} fit="page" />
                </View>
            ) : null}
        </>
    )
}

/** Citation access survives deduplication when an instruction or warning already states the complete fact. */
export function TextFactSources({ text, context }: { text: string; context: BlockContext }): ReactElement {
    return (
        <>
            {context.manualFacts
                .filter((fact) => fact.text === text)
                .map((fact) => (
                    <FactSource key={fact.factId} fact={fact} session={context.session} pageUris={context.pageUris} />
                ))}
        </>
    )
}

/** One manual fact, in the manual's own complete words. Safety is a notice; other directions read as text. */
export function Fact({
    fact,
    emphasis,
    nativeID,
    session,
    pageUris,
}: {
    fact: Pick<ManualFact, 'basis' | 'text' | 'factId' | 'sourceRefs'>
    emphasis: 'normal' | 'strong' | 'quiet'
    nativeID?: string
    session?: ManualSession | undefined
    pageUris?: Readonly<Record<string, string>>
}): ReactElement {
    // Complete text, never clipped: these lines have no line limit and wrap.
    const words =
        fact.basis === 'safety-note' ? (
            <Notice nativeID={nativeID} tone="caution" text={fact.text} />
        ) : emphasis === 'strong' ? (
            <Instruction nativeID={nativeID}>{fact.text}</Instruction>
        ) : emphasis === 'quiet' ? (
            <Caption nativeID={nativeID}>{fact.text}</Caption>
        ) : (
            <Body nativeID={nativeID}>{fact.text}</Body>
        )
    return (
        <>
            {words}
            <FactSource fact={fact} session={session} pageUris={pageUris ?? {}} />
        </>
    )
}

/**
 * The ManualDirections block: the facts the model chose to place here, in its order, with the manual's own words
 * written by the server. A fact the document does not publish is never invented, and a placed fact is never collapsed.
 */
export function DirectionsBlock({
    node,
    context,
    path,
}: {
    node: DirectionsNode
    context: BlockContext
    path: string
}): ReactElement | null {
    const published = new Map(context.manualFacts.map((fact) => [fact.factId, fact]))
    const facts = node.factIds.flatMap((factId) => {
        const fact = published.get(factId)
        return fact === undefined || context.visibleInstructions?.has(fact.text) ? [] : [fact]
    })
    if (facts.length === 0) return null
    return (
        <View nativeID={originId(context.originOf(path))} testID="manual-directions" style={styles.stack}>
            <RenderOriginProvider origin={context.originOf(path)}>
                {facts.map((fact) => (
                    <Fact
                        key={fact.factId}
                        fact={fact}
                        emphasis={node.emphasis}
                        session={context.session}
                        pageUris={context.pageUris}
                    />
                ))}
            </RenderOriginProvider>
        </View>
    )
}

function bodyWarningKeys(nodes: readonly ScreenNode[]): Set<string> {
    const keys = new Set<string>()
    for (const node of nodes) {
        if (node.type === 'Instruction') keys.add(safetyKey(node.text))
        if (node.type === 'Warning') keys.add(safetyKey(node.text))
        if (node.type === 'Group' || node.type === 'DetailsDisclosure') {
            for (const child of node.children) if (child.type === 'Warning') keys.add(safetyKey(child.text))
        }
    }
    return keys
}

function placedFactIds(nodes: readonly ScreenNode[]): Set<string> {
    const ids = new Set<string>()
    for (const node of nodes) if (node.type === 'ManualDirections') for (const id of node.factIds) ids.add(id)
    return ids
}

export type MandatoryFact = {
    readonly fact: ManualFact
    readonly origin: RenderOrigin
}

/**
 * Every required manual fact of the step that no part of the shown document already states in full. The list is
 * resolved from the manual in the app's own session by the same shared function the server uses; it does not depend on
 * a document, a model, the node bounds or the network. A fact the document placed (a directions block, or a warning
 * with the same words) is not repeated; the rest are deterministic content and are labelled so.
 */
export function mandatoryFacts(
    session: ManualSession | undefined,
    stepId: string | null,
    document: ScreenDocument | null,
    shown: readonly ScreenNode[] | null = null,
): MandatoryFact[] {
    if (session === undefined || stepId === null) return []
    const local: readonly ManualFact[] = requiredManualFacts(session, stepId)
    const published = new Map<string, { fact: PublishedManualFact; index: number }>()
    document?.manualFacts?.forEach((fact, index) => published.set(fact.factId, { fact, index }))
    const body = shown ?? document?.body ?? []
    const placed = placedFactIds(body)
    const keys = bodyWarningKeys(body)
    const all = new Map<string, ManualFact>(local.map((fact) => [fact.factId, fact]))
    // A required fact the server published but this device could not resolve is still shown, never dropped.
    for (const { fact } of published.values()) if (fact.placement === 'remainder') all.set(fact.factId, fact)
    const remaining: MandatoryFact[] = []
    for (const fact of all.values()) {
        if (placed.has(fact.factId) || keys.has(safetyKey(fact.text))) continue
        const entry = published.get(fact.factId)
        const origin = entry === undefined ? 'fallback' : document?.metadata.origins?.[`facts.${entry.index}`]
        if (origin === undefined) throw new Error(`missing-origin:facts.${entry?.index}`)
        remaining.push({
            fact,
            origin,
        })
    }
    return remaining
}

/**
 * The step's mandatory facts in the visible, scrolling part of the screen, whatever the document did. Rendered only
 * where screens are composed: with generated screens off the original screen is unchanged.
 */
export function MandatoryFacts({
    session,
    stepId,
    enabled = false,
    visibleText,
}: {
    readonly session: ManualSession | undefined
    readonly stepId: string | null
    readonly enabled?: boolean
    /** Complete native text already rendered beside this remainder, never a hidden or shortened summary. */
    readonly visibleText?: string | undefined
}): ReactElement | null {
    const pageUris = useOptionalWorkflow()?.state.pageUris
    if (!enabled) return null
    const remaining = mandatoryFacts(session, stepId, null).filter(
        ({ fact }) => visibleText === undefined || safetyKey(fact.text) !== safetyKey(visibleText),
    )
    if (remaining.length === 0) return null
    return (
        <>
            {remaining.map(({ fact, origin }) => (
                <View key={fact.factId} testID="mandatory-fact" nativeID={originId(origin)} style={styles.stack}>
                    <RenderOriginProvider origin={origin}>
                        <Fact fact={fact} emphasis="normal" session={session} pageUris={pageUris ?? {}} />
                    </RenderOriginProvider>
                </View>
            ))}
        </>
    )
}

const styles = StyleSheet.create({
    stack: { gap: space.xs },
    source: { minHeight: touchTarget, justifyContent: 'center' },
})
