import { useState, type ReactElement } from 'react'
import { Pressable, StyleSheet, View } from 'react-native'
import type { AppIntent, ScreenNode } from '@truebuild/contracts'
import { stepPartChoices } from '../assembly/question-state'
import { FixEditor } from '../capture/fix-editor'
import { ContinueCard, ManualRow } from '../capture/library-screen'
import type { LibraryEntry } from '../capture/library'
import { PageRow } from '../capture/pages-screen'
import { ManualImage } from '../capture/page-media'
import { SourceDiagrams } from '../capture/step-facts'
import { AppButton } from '../../ui/button'
import { AskSheet } from '../../ui/ask-sheet'
import { Icon } from '../../ui/icons'
import { Caption, Heading, Instruction } from '../../ui/text'
import { useTheme } from '../../theme/theme'
import { space, touchTarget } from '../../theme/tokens'
import type { BlockContext } from './blocks'
import { intentLabel } from './intents'
import { originId } from './render-origin'

type NodeOf<T extends ScreenNode['type']> = Extract<ScreenNode, { type: T }>

const MAX_LIBRARY = 12

/** Library entries a ManualLibrary block may show: the library itself, in the order the document asked for. */
export function libraryEntries(
    node: NodeOf<'ManualLibrary'>,
    entries: readonly LibraryEntry[],
): readonly LibraryEntry[] {
    const recent = [...entries].sort((a, b) => b.session.updatedAt.localeCompare(a.session.updatedAt))
    if (node.entries === 'recent') return recent.slice(0, MAX_LIBRARY)
    // Only manuals the library really holds; an unknown id is skipped, never invented.
    return node.entries.manualIds
        .map((manualId) => recent.find((entry) => entry.session.manualId === manualId))
        .filter((entry): entry is (typeof recent)[number] => entry !== undefined)
        .slice(0, MAX_LIBRARY)
}

export function ManualLibraryBlock({
    node,
    context,
    path,
}: {
    node: NodeOf<'ManualLibrary'>
    context: BlockContext
    path: string
}): ReactElement | null {
    const live = context.live
    if (live === null) return null
    const mark = originId(context.originOf(path))
    const { state } = live
    if (state.loading) return null
    const shown = libraryEntries(node, state.entries)
    if (shown.length === 0) {
        return node.emptyText === null ? null : <Instruction nativeID={mark}>{node.emptyText}</Instruction>
    }
    if (shown.length === 1 && node.layout === 'cards') {
        return (
            <ContinueCard
                nativeID={mark}
                entry={shown[0]!}
                pageUris={state.pageUris}
                resumable={context.readOnly !== true && !state.storageReadOnly}
                showProgress={node.showProgress}
            />
        )
    }
    return (
        <View nativeID={mark} style={styles.stack}>
            {shown.map((entry) => (
                <ManualRow
                    key={entry.session.manualId}
                    entry={entry}
                    pageUris={state.pageUris}
                    showProgress={node.showProgress && node.layout === 'cards'}
                    disabled={context.readOnly === true || state.pending !== null}
                    onOpen={(): void => {
                        if (context.readOnly !== true) live.nav.openStop(entry)
                    }}
                />
            ))}
        </View>
    )
}

export function PageGalleryBlock({
    node,
    context,
    path,
}: {
    node: NodeOf<'PageGallery'>
    context: BlockContext
    path: string
}): ReactElement | null {
    const live = context.live
    const entry = live?.entry
    if (live === null || entry === undefined || live.pages === undefined) return null
    const mark = originId(context.originOf(path))
    const { pages } = entry.session
    const action = node.action === null ? null : context.resolve(node.action)
    return (
        <View nativeID={mark} style={styles.stack}>
            <View style={node.layout === 'grid' ? styles.grid : styles.stack}>
                {pages.map((page, index) =>
                    live.pages?.arriving.has(page.pageId) === true ? null : node.layout === 'grid' ? (
                        <PageCell
                            key={page.pageId}
                            number={index + 1}
                            shown={node.showNumbers}
                            uri={live.state.pageUris[page.pageId]}
                            aspectRatio={page.width / page.height}
                            onPress={(): void => live.pages?.open(page.pageId)}
                        />
                    ) : (
                        <PageRow
                            key={page.pageId}
                            index={index}
                            numbered={node.showNumbers}
                            uri={live.state.pageUris[page.pageId]}
                            aspectRatio={page.width / page.height}
                            onPress={(): void => live.pages?.open(page.pageId)}
                        />
                    ),
                )}
            </View>
            {node.action === null || action === null ? null : (
                <AppButton
                    label={intentLabel(node.action)}
                    variant="quiet"
                    disabled={!action.enabled}
                    hint={action.reason ?? undefined}
                    onPress={action.run}
                />
            )}
        </View>
    )
}

function PageCell({
    number,
    shown,
    uri,
    aspectRatio,
    onPress,
}: {
    number: number
    shown: boolean
    uri: string | undefined
    aspectRatio: number
    onPress: () => void
}): ReactElement {
    return (
        <Pressable
            accessibilityRole="button"
            accessibilityLabel={`View page ${number}`}
            onPress={onPress}
            style={styles.cell}
        >
            {uri === undefined ? (
                <View style={[styles.cellFrame, { aspectRatio }]} />
            ) : (
                <View style={[styles.cellFrame, { aspectRatio }]}>
                    <ManualImage uri={uri} label={`Manual page ${number}`} />
                </View>
            )}
            {shown ? <Caption>{`Page ${number}`}</Caption> : null}
        </Pressable>
    )
}

export function FactPromptBlock({
    node,
    context,
    path,
}: {
    node: NodeOf<'FactPrompt'>
    context: BlockContext
    path: string
}): ReactElement | null {
    const current = context.live?.quick?.current
    // Only while there really is a question to ask; the document cannot ask one the review gate does not have.
    if (current === undefined || current.step.sourceRefs.length === 0) return null
    return (
        <View nativeID={originId(context.originOf(path))} style={styles.stack}>
            <Instruction>{node.prompt}</Instruction>
            {node.detail === null ? null : <Caption>{node.detail}</Caption>}
        </View>
    )
}

export function FactEditorBlock({
    node,
    context,
    path,
}: {
    node: NodeOf<'FactEditor'>
    context: BlockContext
    path: string
}): ReactElement | null {
    const live = context.live
    const current = live?.quick?.current
    const entry = live?.entry
    if (live === null || current === undefined || entry === undefined || current.step.sourceRefs.length === 0) {
        return null
    }
    // The editor edits the question the review gate asks; a document naming the other kind has nothing to edit.
    if (current.kind !== node.kind) return null
    return (
        <FixEditor
            key={`${entry.session.manualId}:${entry.session.revision}:${current.id}`}
            nativeID={originId(context.originOf(path))}
            question={current}
            session={entry.session}
            state={live.state}
            controller={live.controller}
            busy={context.readOnly === true || live.state.pending !== null || live.state.storageReadOnly}
            onDone={(): void => live.closeSheet?.()}
            labels={{ label: node.label, save: node.saveLabel, cancel: node.cancelLabel }}
        />
    )
}

export function QuestionComposerBlock({
    node,
    context,
    path,
}: {
    node: NodeOf<'QuestionComposer'>
    context: BlockContext
    path: string
}): ReactElement | null {
    const live = context.live
    const entry = live?.entry
    const { capture, target } = live?.state ?? { capture: null, target: null }
    // Asking is about the held photo; without one there is nothing to compose.
    if (live === null || entry === undefined || capture === null || live.ask === undefined) return null
    const { state, controller, ask } = live
    const step = entry.session.reviewedSteps[entry.stepIndex]
    const choices =
        node.partScope === 'none' || step === undefined
            ? []
            : ask.choices.length > 0
              ? ask.choices
              : stepPartChoices(entry.session, step)
    return (
        <AskSheet
            nativeID={originId(context.originOf(path))}
            question={state.question}
            questionLabel={node.prompt ?? 'Question about your photo'}
            onQuestionChange={controller.questionChanged}
            parts={choices.map((choice) => ({ id: choice.partId, label: choice.label }))}
            selectedPartId={target?.kind === 'part' ? target.partId : null}
            onSelectPart={(partId): void => controller.targetChanged({ kind: 'part', partId })}
            targetSummary={ask.targetSummary}
            hasTarget={target !== null}
            editable={ask.editable}
            busy={state.pending !== null && /^(Asking|Still thinking)/u.test(state.pending)}
            stillThinking={state.pending?.startsWith('Still thinking') === true}
            submitLabel={node.submitLabel}
            onSubmit={(): void => {
                void controller.ask()
            }}
        />
    )
}

export function SourceDetailsBlock({
    node,
    context,
    path,
}: {
    node: NodeOf<'SourceDetails'>
    context: BlockContext
    path: string
}): ReactElement | null {
    const session = context.session
    const [open, setOpen] = useState(node.initiallyOpen)
    const { colors } = useTheme()
    if (session === undefined) return null
    // Citations are indexes into the document's own sources; one that does not exist shows nothing.
    const refs = node.sources.flatMap((index) => {
        const source = context.sources[index]
        return source === undefined ? [] : [{ pageId: source.pageId, region: source.region }]
    })
    if (refs.length === 0) return null
    return (
        <View nativeID={originId(context.originOf(path))} style={styles.stack}>
            <Pressable
                accessibilityRole="button"
                accessibilityLabel={node.label}
                accessibilityState={{ expanded: open }}
                onPress={(): void => setOpen(!open)}
                style={styles.disclosure}
            >
                <Heading>{node.label}</Heading>
                <Icon name={open ? 'chevronLeft' : 'chevronRight'} color={colors.inkMuted} />
            </Pressable>
            {open ? (
                <SourceDiagrams
                    refs={refs}
                    session={session}
                    pageUris={context.pageUris}
                    fit={node.fit === 'cover' ? 'frame' : 'page'}
                />
            ) : null}
        </View>
    )
}

const EMPHASIS_VARIANT = { strong: 'accent', normal: 'secondary', quiet: 'quiet' } as const

export function ActionLinkBlock({
    node,
    context,
    path,
}: {
    node: NodeOf<'ActionLink'>
    context: BlockContext
    path: string
}): ReactElement {
    const resolved = context.resolve(node.intent as AppIntent)
    return (
        <AppButton
            nativeID={originId(context.originOf(path))}
            label={node.label}
            variant={EMPHASIS_VARIANT[node.emphasis]}
            {...(node.icon === null ? {} : { icon: node.icon })}
            disabled={!resolved.enabled}
            hint={resolved.reason ?? undefined}
            onPress={resolved.run}
        />
    )
}

const styles = StyleSheet.create({
    stack: { gap: space.xs },
    grid: { flexDirection: 'row', flexWrap: 'wrap', gap: space.xs },
    cell: { width: 96, minHeight: touchTarget },
    cellFrame: { width: '100%', overflow: 'hidden' },
    disclosure: {
        minHeight: touchTarget,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: space.xs,
    },
})
