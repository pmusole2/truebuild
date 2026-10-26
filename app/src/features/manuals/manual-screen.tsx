import type { ManualSession } from '@truebuild/contracts'
import { useCallback, useReducer, useRef, useState, type ReactElement } from 'react'
import { Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native'
import { contentMaxWidth, fonts, palette, radius, space } from '../../components/theme'
import { ActionButton, FIXTURE_LABEL, Notice, Panel, SectionTitle, Tag } from '../../components/ui'
import { TextDraft } from './fact-draft'
import { ExtractionPanel } from './extraction-panel'
import { localStore } from './local-store'
import type { ManualEdit } from './manual-edits'
import type { ExtractionPreview } from './model-extraction'
import { PartsEditor } from './parts-editor'
import { SourceView } from './source-view'
import { StepEditor } from './step-editor'
import {
    checkBlockReason,
    createWorkspaceState,
    hasUnsavedChanges,
    isDemoSession,
    workspaceReducer,
} from './workspace-state'

const WIDE_LAYOUT_MIN_WIDTH = 900

type ManualScreenProps = {
    readonly initialSession: ManualSession
    readonly initialSavedRevision: number | null
    readonly onOpenCheck: (stepId: string) => void
    readonly onDeleted: () => void
}

type OperationState = {
    id: number
    editEpoch: number
}

type OperationTracking = {
    id: number
    editEpoch: number
    reload: OperationState | null
}

export function ManualScreen({
    initialSession,
    initialSavedRevision,
    onOpenCheck,
    onDeleted,
}: ManualScreenProps): ReactElement {
    const [state, dispatch] = useReducer(workspaceReducer, createWorkspaceState(initialSession, initialSavedRevision))
    const [citePageId, setCitePageId] = useState<string>(initialSession.pages[0]?.pageId ?? '')
    const [confirmingDelete, setConfirmingDelete] = useState(false)
    const operationRef = useRef<OperationTracking>({
        id: 0,
        editEpoch: 0,
        reload: null,
    })
    const { width } = useWindowDimensions()
    const { session, savedRevision, selectedStepId, notice } = state
    const demo = isDemoSession(session)
    const unsaved = hasUnsavedChanges(state)
    const wide = width >= WIDE_LAYOUT_MIN_WIDTH
    const blockReason = checkBlockReason(state)

    // Falls back to the first page when the cited page was removed.
    const activePageId = session.pages.some((page) => page.pageId === citePageId)
        ? citePageId
        : (session.pages[0]?.pageId ?? '')
    const citedPage = session.pages.find((page) => page.pageId === activePageId) ?? null
    const citedIndex = citedPage === null ? -1 : session.pages.indexOf(citedPage)
    const orderedSteps = [...session.reviewedSteps].sort((left, right) => left.order - right.order)
    const selectedStep = orderedSteps.find((step) => step.stepId === selectedStepId) ?? null
    const selectedIndex = selectedStep === null ? -1 : orderedSteps.indexOf(selectedStep)
    const highlights =
        selectedStep === null || citedPage === null
            ? []
            : selectedStep.sourceRefs.flatMap((ref) =>
                  ref.pageId === citedPage.pageId && ref.region !== null ? [ref.region] : [],
              )

    const edit = useCallback((change: ManualEdit): void => {
        dispatch({ type: 'edit', edit: change })
        setConfirmingDelete(false)
        operationRef.current.editEpoch += 1
        operationRef.current.reload = null
    }, [])

    // Applying a previewed extraction is a state change: it stales every pending reload and any earlier review.
    const applyExtraction = useCallback((preview: ExtractionPreview): void => {
        dispatch({ type: 'apply-extraction', preview, now: new Date().toISOString() })
        operationRef.current.editEpoch += 1
        operationRef.current.reload = null
    }, [])

    async function save(): Promise<void> {
        try {
            await localStore.saveManual(session)
            dispatch({ type: 'saved', revision: session.revision })
            operationRef.current.editEpoch += 1
            operationRef.current.reload = null
        } catch {
            dispatch({ type: 'notice', text: 'Could not save this manual. Your edits are still on screen.' })
        }
    }

    async function reloadSaved(): Promise<void> {
        operationRef.current.id = (operationRef.current.id + 1) % 1000000
        const requestOp: OperationState = {
            id: operationRef.current.id,
            editEpoch: operationRef.current.editEpoch,
        }
        operationRef.current.reload = requestOp
        try {
            const saved = await localStore.loadManual(session.manualId)
            if (operationRef.current.reload !== requestOp || operationRef.current.editEpoch !== requestOp.editEpoch) {
                dispatch({
                    type: 'notice',
                    text: 'A more recent change was made before the reload completed. Using the newer version.',
                })
                return
            }
            if (saved === null) {
                dispatch({ type: 'notice', text: 'No saved copy of this manual was found.' })
                return
            }
            operationRef.current.editEpoch = (operationRef.current.editEpoch + 1) % 1000000
            dispatch({ type: 'loaded', session: saved, savedRevision: saved.revision })
        } catch {
            dispatch({ type: 'notice', text: 'Could not reload this manual from local storage.' })
        }
    }

    async function removeSaved(): Promise<void> {
        if (!confirmingDelete) {
            setConfirmingDelete(true)
            return
        }
        try {
            await localStore.deleteManual(session.manualId)
            onDeleted()
        } catch {
            setConfirmingDelete(false)
            dispatch({ type: 'notice', text: 'Could not delete this manual. Nothing was removed.' })
        }
    }

    const statusText = demo
        ? 'Built-in demo — not saved. Import pages to keep a manual on this device.'
        : unsaved || savedRevision === null
          ? `Revision ${session.revision} — unsaved changes.`
          : `Revision ${session.revision} — saved on this device.`

    const stepColumn = (
        <View style={styles.column}>
            <Panel>
                <SectionTitle>Source pages</SectionTitle>
                <Text style={styles.hint}>
                    Pages are manual sources. Photos you import are never treated as assembly observations.
                </Text>
                <View style={styles.pageChips}>
                    {session.pages.map((page, index) => {
                        const selected = page.pageId === activePageId
                        return (
                            <Pressable
                                key={page.pageId}
                                accessibilityRole="radio"
                                accessibilityLabel={`Cite page ${index + 1}`}
                                aria-checked={selected}
                                onPress={() => setCitePageId(page.pageId)}
                                style={[styles.chip, selected && styles.chipSelected]}
                            >
                                <Text style={[styles.chipText, selected && styles.chipTextSelected]}>
                                    Page {index + 1}
                                </Text>
                            </Pressable>
                        )
                    })}
                </View>
                {citedPage === null ? (
                    <Text style={styles.hint}>This manual has no pages.</Text>
                ) : (
                    <>
                        <SourceView
                            page={citedPage}
                            isDemo={demo}
                            highlights={highlights}
                            caption={`Page ${session.pages.indexOf(citedPage) + 1} · ${citedPage.width}×${citedPage.height}`}
                        />
                        <View style={styles.actions}>
                            <ActionButton
                                label="Move page earlier"
                                disabled={citedIndex <= 0}
                                onPress={() => edit({ kind: 'move-page', pageId: citedPage.pageId, direction: -1 })}
                            />
                            <ActionButton
                                label="Move page later"
                                disabled={citedIndex === session.pages.length - 1}
                                onPress={() => edit({ kind: 'move-page', pageId: citedPage.pageId, direction: 1 })}
                            />
                        </View>
                        <ActionButton
                            label="Remove this page"
                            tone="danger"
                            onPress={() => edit({ kind: 'remove-page', pageId: citedPage.pageId })}
                        />
                    </>
                )}
            </Panel>

            <Panel>
                <SectionTitle>Steps</SectionTitle>
                {orderedSteps.length === 0 ? (
                    <Text style={styles.hint}>No steps yet. Add the steps you read on the pages.</Text>
                ) : null}
                {orderedSteps.map((step) => {
                    const selected = step.stepId === selectedStep?.stepId
                    return (
                        <Pressable
                            key={step.stepId}
                            accessibilityRole="button"
                            accessibilityLabel={`Step ${step.order}: ${step.title}`}
                            accessibilityState={{ selected }}
                            onPress={() => dispatch({ type: 'select-step', stepId: step.stepId })}
                            style={[styles.stepRow, selected && styles.stepRowSelected]}
                        >
                            <Text style={[styles.stepRowNumber, selected && styles.stepRowTextSelected]}>
                                {step.order}
                            </Text>
                            <Text style={[styles.stepRowTitle, selected && styles.stepRowTextSelected]}>
                                {step.title}
                            </Text>
                        </Pressable>
                    )
                })}
                <TextDraft
                    key={`add-step-${session.revision}`}
                    label="New step title"
                    initialValue=""
                    actionLabel="Add step"
                    placeholder="For example: Stand the side panel upright"
                    onSubmit={(title) => edit({ kind: 'add-step', title })}
                />
            </Panel>
        </View>
    )

    const detailColumn = (
        <View style={styles.column}>
            {selectedStep === null ? (
                <Panel>
                    <Text style={styles.hint}>Select a step, or add one, to edit its facts.</Text>
                </Panel>
            ) : (
                <StepEditor
                    key={`step-${selectedStep.stepId}-${session.revision}`}
                    session={session}
                    step={selectedStep}
                    citePageId={activePageId}
                    isFirst={selectedIndex <= 0}
                    isLast={selectedIndex === orderedSteps.length - 1}
                    onEdit={edit}
                    checkBlockedReason={blockReason}
                    onOpenCheck={() => {
                        if (blockReason === null) {
                            onOpenCheck(selectedStep.stepId)
                        }
                    }}
                />
            )}
            <PartsEditor key={`parts-${session.revision}`} session={session} citePageId={activePageId} onEdit={edit} />
        </View>
    )

    return (
        <ScrollView contentContainerStyle={styles.page} keyboardShouldPersistTaps="handled">
            <View style={styles.inner}>
                <Panel>
                    <View style={styles.headerRow}>
                        <Tag
                            tone={session.reviewStatus === 'reviewed' ? 'reviewed' : 'unreviewed'}
                            text={session.reviewStatus === 'reviewed' ? 'Reviewed' : 'Unreviewed'}
                        />
                        {demo ? <Tag tone="simulated" text={FIXTURE_LABEL} /> : null}
                    </View>
                    <Text accessibilityRole="header" style={styles.title}>
                        {session.title}
                    </Text>
                    <Text style={styles.hint}>{statusText}</Text>
                    <TextDraft
                        key={`rename-${session.revision}`}
                        label="Manual title"
                        initialValue={session.title}
                        actionLabel="Rename"
                        onSubmit={(title) => edit({ kind: 'rename', title })}
                    />
                    <View style={styles.actions}>
                        <ActionButton
                            label="Save to device"
                            tone="primary"
                            disabled={demo || (!unsaved && savedRevision !== null)}
                            onPress={() => void save()}
                        />
                        <ActionButton label="Reload saved copy" disabled={demo} onPress={() => void reloadSaved()} />
                        <ActionButton
                            label={confirmingDelete ? 'Confirm delete' : 'Delete manual'}
                            tone="danger"
                            disabled={demo}
                            onPress={() => void removeSaved()}
                        />
                    </View>
                    {confirmingDelete ? (
                        <Notice
                            tone="error"
                            text="Deleting removes this manual, its page images and its steps from this device."
                        />
                    ) : null}
                </Panel>

                {notice === null ? null : <Notice tone="error" text={notice} />}

                <Panel>
                    <SectionTitle>Review</SectionTitle>
                    <Text style={styles.hint}>
                        {session.reviewStatus === 'reviewed'
                            ? 'Reviewed: every critical fact is known and cited. Edits reset this status.'
                            : 'Unreviewed: imported and edited facts are not verified. Mark reviewed only after checking them against the pages.'}
                    </Text>
                    <ActionButton
                        label="Mark reviewed"
                        tone="primary"
                        disabled={session.reviewStatus === 'reviewed'}
                        onPress={() => {
                            dispatch({ type: 'review' })
                            operationRef.current.editEpoch += 1
                            operationRef.current.reload = null
                        }}
                    />
                </Panel>

                <ExtractionPanel
                    key={`extract-${session.revision}`}
                    session={session}
                    loadPageAsset={(assetId) => localStore.loadPageAsset(assetId)}
                    onApply={applyExtraction}
                    onCopyRawStep={(rawStepId) => edit({ kind: 'copy-raw-step', rawStepId })}
                />

                <View style={wide ? styles.wideRow : styles.stackColumn}>
                    {stepColumn}
                    {detailColumn}
                </View>
            </View>
        </ScrollView>
    )
}

const styles = StyleSheet.create({
    page: {
        padding: space.md,
        alignItems: 'center',
    },
    inner: {
        width: '100%',
        maxWidth: contentMaxWidth,
        gap: space.md,
    },
    wideRow: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: space.md,
    },
    stackColumn: {
        gap: space.md,
    },
    column: {
        flex: 1,
        gap: space.md,
    },
    headerRow: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: space.xs,
    },
    title: {
        color: palette.charcoal,
        fontFamily: fonts.display,
        fontSize: 26,
        fontWeight: '700',
    },
    hint: {
        color: palette.graphite,
        fontSize: 14,
        lineHeight: 20,
    },
    actions: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: space.xs,
    },
    pageChips: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: space.xs,
    },
    chip: {
        minHeight: 44,
        paddingHorizontal: space.sm,
        justifyContent: 'center',
        borderWidth: 1,
        borderRadius: radius,
        borderColor: palette.rule,
        backgroundColor: palette.paperRaised,
    },
    chipSelected: {
        backgroundColor: palette.charcoal,
        borderColor: palette.charcoal,
    },
    chipText: {
        color: palette.charcoal,
        fontFamily: fonts.mono,
        fontSize: 13,
    },
    chipTextSelected: {
        color: palette.paperRaised,
    },
    stepRow: {
        minHeight: 44,
        flexDirection: 'row',
        alignItems: 'center',
        gap: space.sm,
        paddingHorizontal: space.sm,
        borderLeftWidth: 3,
        borderLeftColor: 'transparent',
    },
    stepRowSelected: {
        borderLeftColor: palette.signal,
        backgroundColor: palette.paperDeep,
    },
    stepRowNumber: {
        fontFamily: fonts.mono,
        color: palette.signalInk,
        fontWeight: '700',
        width: 24,
    },
    stepRowTitle: {
        color: palette.charcoal,
        fontSize: 15,
        flex: 1,
    },
    stepRowTextSelected: {
        color: palette.charcoal,
        fontWeight: '700',
    },
})
