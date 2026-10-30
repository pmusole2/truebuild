import { useEffect, useMemo, useState, type ReactElement } from 'react'
import { StyleSheet, useWindowDimensions, View } from 'react-native'
import { Stack as RouterStack, useIsFocused } from 'expo-router'
import type { LibraryEntry } from '../capture/library'
import { manualPageImagesKey } from '../capture/controller'
import { useWorkflowActions } from '../capture/native-routes'
import { useMoreState } from '../capture/screen-header'
import { useWorkflow } from '../capture/workflow-context'
import { DocumentSurface } from '../capture/document-surface'
import { AppButton } from '../../ui/button'
import { Caption, Heading } from '../../ui/text'
import { space } from '../../theme/tokens'
import { DocumentRenderer } from '../documents/document-renderer'
import { manualDisplayTitle } from '../documents/manual-title'
import { useDocument } from '../document-runtime/use-document'
import { documentKey } from '../document-runtime/store'
import type { FrameBindings } from '../documents/types'
import { useJudge } from './judge-context'
import { useOriginNativeId } from '../../ui/render-origin'

export const SIDE_BY_SIDE_WIDTH = 900
export function comparable(entry: LibraryEntry): boolean {
    return entry.session.reviewStatus === 'reviewed' && entry.session.reviewedSteps.length > 0
}

/** Each pane is a real v2 guide with its own facts, citation hero and full frame; actions remain read-only. */
export function ComparePane({ entry }: { readonly entry: LibraryEntry }): ReactElement {
    const chromeOrigin = useOriginNativeId()
    const { state, controller: reader, documents } = useWorkflow()
    const { controller, nav } = useWorkflowActions()
    const more = useMoreState()
    const focused = useIsFocused()
    const inputs = useMemo(
        () =>
            ({
                kind: 'guide',
                session: entry.session,
                stepId: entry.session.reviewedSteps[0]?.stepId ?? null,
                captureId: null,
                result: null,
                failure: null,
            }) as const,
        [entry.session],
    )
    const reading = useDocument(inputs, { focused: false })
    const key = documentKey(inputs)
    // Panes stay read-only and never become the shown guide for checking. Their bounded preparation is explicit.
    useEffect(() => {
        if (focused) documents?.warmup([inputs])
    }, [documents, focused, key])
    const { manualId, revision } = entry.session
    const pageKey = manualPageImagesKey(entry.session)
    const [pictures, setPictures] = useState<{
        readonly key: string
        readonly status: 'pending' | 'ready' | 'unavailable'
        readonly uris: Readonly<Record<string, string>>
    }>({ key: pageKey, status: 'pending', uris: {} })
    useEffect(() => {
        const abort = new AbortController()
        let active = true
        setPictures({ key: pageKey, status: 'pending', uris: {} })
        void reader.pageImages(manualId, revision, abort.signal).then(
            (uris) => {
                if (active) setPictures({ key: pageKey, status: 'ready', uris })
            },
            () => {
                if (active) setPictures({ key: pageKey, status: 'unavailable', uris: {} })
            },
        )
        return (): void => {
            active = false
            abort.abort()
        }
    }, [reader, manualId, revision, pageKey])
    const currentPictures = pictures.key === pageKey ? pictures : null
    const bindings: FrameBindings = {
        readOnly: true,
        resolve: () => ({ enabled: false, reason: 'Comparison is read only.', run: (): void => undefined }),
        live: { state, entry: { ...entry, stepIndex: 0 }, controller, nav, more },
        session: entry.session,
        pageUris: currentPictures?.uris ?? {},
        pageImageStatus: currentPictures?.status ?? 'pending',
        capture: null,
        marks: [],
        heroMode: 'inline',
        inspect: false,
    }
    return (
        <View testID={`compare-pane-${entry.session.manualId}`} style={styles.paneFrame}>
            <View nativeID={chromeOrigin} style={{ padding: space.sm, gap: space.xs }}>
                <Heading>{manualDisplayTitle(entry.session)}</Heading>
                <Caption>
                    {reading.document.metadata.evidence === 'synthetic-fixture'
                        ? 'Simulated fixture · no model call'
                        : reading.document.metadata.source === 'generated'
                          ? 'Model-composed guide'
                          : 'App fallback guide'}
                </Caption>
            </View>
            <DocumentRenderer document={reading.document} bindings={bindings} variant={reading.activeState} />
        </View>
    )
}

function Columns(): ReactElement {
    const { state } = useWorkflow()
    const { width } = useWindowDimensions()
    const [chosen, setChosen] = useState<readonly string[]>([])
    const wide = width >= SIDE_BY_SIDE_WIDTH
    const panes = chosen.flatMap((id) => state.entries.filter((entry) => entry.session.manualId === id))
    return (
        <View style={styles.content}>
            <Caption>{wide ? 'Two manuals, side by side.' : 'Narrow layout: the two manuals are stacked.'}</Caption>
            {state.entries.map((entry) => (
                <AppButton
                    key={entry.session.manualId}
                    testID={`compare-choose-${entry.session.manualId}`}
                    label={manualDisplayTitle(entry.session)}
                    variant={chosen.includes(entry.session.manualId) ? 'accent' : 'secondary'}
                    disabled={!comparable(entry)}
                    onPress={(): void =>
                        setChosen((current) =>
                            current.includes(entry.session.manualId)
                                ? current.filter((id) => id !== entry.session.manualId)
                                : [...current, entry.session.manualId].slice(-2),
                        )
                    }
                />
            ))}
            <View testID="compare-panes" style={[styles.panes, wide ? styles.row : styles.column]}>
                {panes.map((entry) => (
                    <View key={entry.session.manualId} style={wide ? styles.pane : undefined}>
                        <ComparePane entry={entry} />
                    </View>
                ))}
            </View>
        </View>
    )
}

/** Hidden by default. The compare capability only places manual documents; pane content is never excluded. */
export function CompareScreen(): ReactElement {
    const { showBuilt } = useJudge()
    return (
        <>
            <RouterStack.Screen options={{ headerShown: false }} />
            {showBuilt ? <DocumentSurface kind="compare" compare={<Columns />} /> : <DocumentSurface kind="home" />}
        </>
    )
}
const styles = StyleSheet.create({
    content: { gap: space.md },
    panes: { gap: space.md },
    row: { flexDirection: 'row' },
    column: { flexDirection: 'column' },
    pane: { flex: 1, minWidth: 0 },
    paneFrame: { minHeight: 640 },
})
