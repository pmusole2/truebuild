import { useEffect, useRef, useState, type ReactElement } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import type { ManualPage, ManualSession } from '@truebuild/contracts'
import { ModelApiClient } from '../../api/model-client'
import { fonts, palette, radius, space } from '../../components/theme'
import { ActionButton, Notice, Panel, Segmented, SectionTitle, Tag } from '../../components/ui'
import { freshRequestId } from '../assembly/identity'
import { modelConnectionStore, useModelConnection, type ModelConnection } from '../connection/connection-store'
import type { StoredPageAsset } from '../../storage/manual-store.types'
import { describeRawStep } from './raw-describe'
import { isDemoSession } from './workspace-state'
import {
    EXTRACTION_MAX_PAGES,
    ExtractionError,
    previewBatch,
    selectBatch,
    type ExtractionPreview,
} from './model-extraction'

type ExtractionPanelProps = {
    readonly session: ManualSession
    readonly loadPageAsset: (assetId: string) => Promise<StoredPageAsset | null>
    readonly onApply: (preview: ExtractionPreview) => void
    readonly onCopyRawStep: (rawStepId: string) => void
}

type Mode = 'append' | 'replace'

const UNAVAILABLE_EXTRACT: Record<string, string> = {
    unconfigured: 'Extraction is not configured on the connected backend. No model was called.',
    unauthorized: 'The owner token was rejected, so the connection was cleared. Reconnect on the connection screen.',
    timeout: 'Extraction timed out. Nothing was previewed; try again.',
    budget_exhausted: 'The check budget is used up. Nothing was previewed.',
    invalid_output: 'The extraction result was not valid for this manual. Nothing was previewed.',
    provider_error: 'Extraction could not be completed. Nothing was previewed; try again.',
}

function effectText(mode: Mode, hasRaw: boolean): string {
    if (!hasRaw) {
        return 'Saves this as the raw extraction. The manual becomes unreviewed. Reviewed steps are not changed.'
    }
    return mode === 'append'
        ? 'Adds these steps and parts after the existing raw extraction. Existing raw facts are kept unchanged. The manual becomes unreviewed.'
        : 'Replaces the existing raw extraction with this batch. The manual becomes unreviewed. Reviewed steps are not changed.'
}

function connectedClient(connection: ModelConnection | null): ModelApiClient | null {
    if (connection === null) {
        return null
    }
    try {
        return new ModelApiClient({ baseUrl: connection.origin, token: connection.token })
    } catch {
        return null
    }
}

/**
 * Explicit, user-triggered extraction from chosen source pages. The result is a preview only. Applying it writes raw
 * evidence; copying a raw step creates an editable, unreviewed draft step. Neither marks anything reviewed.
 * Changing the selection or mode, changing the connection, or leaving the screen cancels the request in flight.
 */
export function ExtractionPanel({
    session,
    loadPageAsset,
    onApply,
    onCopyRawStep,
}: ExtractionPanelProps): ReactElement {
    const connection = useModelConnection()
    const generation = connection?.generation ?? 0
    const client = connectedClient(connection)
    const [selected, setSelected] = useState<string[]>([])
    const [mode, setMode] = useState<Mode>('append')
    const [preview, setPreview] = useState<ExtractionPreview | null>(null)
    const [notice, setNotice] = useState<string | null>(null)
    const [pending, setPending] = useState(false)
    // The single in-flight extraction and its cancellation. A reply is published only while it is still this run.
    const runRef = useRef<{ readonly controller: AbortController } | null>(null)

    function cancelRun(): void {
        runRef.current?.controller.abort()
        runRef.current = null
        setPending(false)
    }

    // Leaving the screen cancels the run, so a detached panel can never publish a preview.
    useEffect(() => {
        return (): void => {
            runRef.current?.controller.abort()
            runRef.current = null
        }
    }, [])

    // A different connection (or none) makes any preview and in-flight extraction stale.
    useEffect(() => {
        cancelRun()
        setPreview(null)
        setNotice(null)
        // Only the connection identity matters here.
    }, [generation])

    const demo = isDemoSession(session)
    const hasRaw = session.rawExtraction !== null
    const rawSummary = session.rawExtraction
    const pageNumber = (pageId: string): number | undefined => {
        const index = session.pages.findIndex((page) => page.pageId === pageId)
        return index === -1 ? undefined : index + 1
    }

    function changeSelection(pageId: string): void {
        cancelRun()
        setPreview(null)
        setNotice(null)
        setSelected((current) =>
            current.includes(pageId)
                ? current.filter((id) => id !== pageId)
                : current.length >= EXTRACTION_MAX_PAGES
                  ? current
                  : [...current, pageId],
        )
    }

    function chooseMode(next: Mode): void {
        cancelRun()
        setMode(next)
        setPreview(null)
        setNotice(null)
    }

    async function extract(): Promise<void> {
        if (runRef.current !== null || client === null) {
            return
        }
        if (demo) {
            setNotice('Save this manual to this device before extracting. The built-in demo has no stored page images.')
            return
        }
        const choice = selectBatch(session, selected, mode)
        if ('reason' in choice) {
            setNotice(choice.reason)
            return
        }
        const startedGeneration = generation
        const controller = new AbortController()
        const run = { controller }
        runRef.current = run
        setPending(true)
        setNotice(null)
        setPreview(null)
        // Still the same run, same connection, same screen: the only state in which a reply may be published.
        const current = (): boolean =>
            runRef.current === run &&
            !controller.signal.aborted &&
            modelConnectionStore.currentGeneration() === startedGeneration
        try {
            const images: { bytes: Uint8Array; mimeType: ManualPage['mimeType']; width: number; height: number }[] = []
            for (const page of choice.pages) {
                const asset = await loadPageAsset(page.assetId)
                if (!current()) {
                    return
                }
                if (asset === null || asset.mimeType !== page.mimeType) {
                    setNotice('A selected page image is missing from this device. Nothing was sent.')
                    return
                }
                images.push({ bytes: asset.bytes, mimeType: page.mimeType, width: page.width, height: page.height })
            }
            const binding = { kind: 'manual' as const, manualId: session.manualId, revision: session.revision }
            const result = await client.parse(binding, choice.pages, images, {
                requestId: freshRequestId('extract'),
                signal: controller.signal,
            })
            if (!current()) {
                return
            }
            if (result.status === 'unavailable' && result.code === 'unauthorized') {
                modelConnectionStore.clearIfCurrent(startedGeneration)
                setNotice(UNAVAILABLE_EXTRACT.unauthorized ?? 'The owner token was rejected.')
                return
            }
            if (result.status !== 'ok') {
                setNotice(
                    UNAVAILABLE_EXTRACT[result.code] ?? 'Extraction could not be completed. Nothing was previewed.',
                )
                return
            }
            setPreview(
                previewBatch(
                    session,
                    choice.pages.map((page) => page.pageId),
                    mode,
                    result.value,
                ),
            )
        } catch (error: unknown) {
            if (current()) {
                setNotice(
                    error instanceof ExtractionError
                        ? error.message
                        : 'Extraction could not be completed. Nothing was previewed; try again.',
                )
            }
        } finally {
            if (runRef.current === run) {
                runRef.current = null
                setPending(false)
            }
        }
    }

    const reason =
        client === null
            ? 'Connect a live backend on the connection screen first. Without a connection no page is sent and no model is called.'
            : demo
              ? 'Save this manual to this device before extracting.'
              : selected.length === 0
                ? 'Select one to three source pages to extract.'
                : null

    return (
        <Panel>
            <SectionTitle>Extract facts from pages (live model)</SectionTitle>
            <Notice text="Only the pages you select are sent, to the connected backend, when you press Extract. Assembly photos are never sent here. The result is a preview: nothing is saved until you apply it." />
            <View style={styles.pageChips}>
                {session.pages.map((page, index) => {
                    const chosen = selected.includes(page.pageId)
                    return (
                        <Pressable
                            key={page.pageId}
                            accessibilityRole="checkbox"
                            accessibilityLabel={`Select page ${index + 1} for extraction`}
                            aria-checked={chosen}
                            onPress={() => changeSelection(page.pageId)}
                            style={[styles.chip, chosen && styles.chipSelected]}
                        >
                            <Text style={[styles.chipText, chosen && styles.chipTextSelected]}>Page {index + 1}</Text>
                        </Pressable>
                    )
                })}
            </View>
            {hasRaw ? (
                <Segmented
                    label="Extraction mode"
                    options={[
                        { value: 'append', label: 'Add to raw extraction' },
                        { value: 'replace', label: 'Replace raw extraction' },
                    ]}
                    value={mode}
                    onChange={chooseMode}
                />
            ) : null}
            <Notice tone="caution" text={effectText(mode, hasRaw)} />
            <ActionButton
                label={pending ? 'Extracting…' : 'Extract selected pages'}
                tone="primary"
                disabled={pending || reason !== null}
                onPress={() => void extract()}
            />
            {reason === null || pending ? null : <Notice tone="caution" text={reason} />}
            {notice === null ? null : <Notice tone="error" text={notice} />}

            {preview === null ? null : (
                <View style={styles.block}>
                    <Tag tone="unreviewed" text="Live model preview — not applied" />
                    <Text style={styles.body}>
                        {preview.counts.steps} steps, {preview.counts.parts} parts, {preview.counts.unknowns} unknown
                        notes from {preview.pageIds.length} page{preview.pageIds.length === 1 ? '' : 's'}.
                    </Text>
                    {preview.extraction.steps.map((step) => (
                        <View key={step.stepId} style={styles.block}>
                            {describeRawStep(step, preview.extraction.parts, pageNumber).map((line, index) => (
                                <Text key={`${step.stepId}-${index}`} style={styles.body}>
                                    {line}
                                </Text>
                            ))}
                        </View>
                    ))}
                    {preview.extraction.unknowns.map((note, index) => (
                        <Text key={`unknown-${index}`} style={styles.body}>
                            Unknown note: {note}
                        </Text>
                    ))}
                    <Text style={styles.body}>{effectText(preview.mode, hasRaw)}</Text>
                    <ActionButton
                        label="Apply extraction preview"
                        tone="primary"
                        onPress={() => {
                            onApply(preview)
                            setPreview(null)
                        }}
                    />
                    <ActionButton label="Discard extraction preview" onPress={() => setPreview(null)} />
                </View>
            )}

            {rawSummary === null ? null : (
                <View style={styles.block}>
                    <Text style={styles.body}>
                        Raw extraction (unreviewed evidence, kept unchanged): {rawSummary.steps.length} steps,{' '}
                        {rawSummary.parts.length} parts.
                    </Text>
                    {rawSummary.steps.map((step) => {
                        const inDraft = session.reviewedSteps.some((candidate) => candidate.stepId === step.stepId)
                        return (
                            <View key={step.stepId} style={styles.block}>
                                {describeRawStep(step, rawSummary.parts, pageNumber).map((line, index) => (
                                    <Text key={`${step.stepId}-${index}`} style={styles.body}>
                                        {line}
                                    </Text>
                                ))}
                                <ActionButton
                                    label={
                                        inDraft
                                            ? `Raw step ${step.order} is already in the draft`
                                            : `Copy raw step ${step.order} to draft`
                                    }
                                    disabled={inDraft}
                                    onPress={() => onCopyRawStep(step.stepId)}
                                />
                            </View>
                        )
                    })}
                    {rawSummary.unknowns.map((note, index) => (
                        <Text key={`raw-unknown-${index}`} style={styles.body}>
                            Unknown note: {note}
                        </Text>
                    ))}
                </View>
            )}
        </Panel>
    )
}

const styles = StyleSheet.create({
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
    body: {
        color: palette.charcoal,
        fontSize: 15,
        lineHeight: 22,
    },
    block: {
        gap: space.xs,
    },
})
