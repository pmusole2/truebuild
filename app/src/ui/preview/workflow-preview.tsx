import { useEffect, useState, type ReactElement } from 'react'
import { ScrollView, StyleSheet, View } from 'react-native'
import { StatusBar } from 'expo-status-bar'
import type { SharedValue } from 'react-native-reanimated'
import { baseKindV2, buildFallbackDocumentV2, waitCopyV2, type ScreenKindV2 } from '@truebuild/contracts'
import { ManualImage } from '../../features/capture/page-media'
import type { QuickProgress } from '../../features/screens/quick-progress'
import { useQuickProgress } from '../../features/screens/quick-progress'
import { useMoreState, type MoreControl } from '../../features/capture/screen-header'
import { AppUnavailableScreen } from '../../features/capture/app-unavailable'
import { defaultNav } from '../../features/capture/screen-nav'
import type { WorkflowController } from '../../features/capture/workflow-types'
import { documentInputs } from '../../features/capture/document-inputs'
import { DocumentRenderer } from '../../features/documents/document-renderer'
import type { FrameBindings } from '../../features/documents/types'
import { sha256Hex } from '../../features/documents/sha256'
import { resolveIntent } from '../../features/screens/intents'
import { MoreSheet } from '../sheet'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { InertTour, tourScreenFor } from './inert-tour'
import { ThemeProvider, useTheme } from '../../theme/theme'
import type { ColorScheme } from '../../theme/tokens'
import { SegmentedControl } from '../fields'
import { Caption } from '../text'
import { FeedbackProvider } from '../feedback'
import {
    WORKFLOW_PREVIEW_BANNER,
    WORKFLOW_PREVIEW_CASES,
    cameraPreviewPresentation,
    workflowPreviewFixture,
    type WorkflowPreviewCase,
    type WorkflowPreviewGroup,
} from './workflow-fixtures'

const doNothing = (): void => undefined
const resolveNothing = async (): Promise<void> => undefined

/** No application controller, IO ports, storage, picker, camera or API client is constructed in this preview. */
export const INERT_WORKFLOW_CONTROLLER = Object.freeze({
    acceptStepFacts: async (): Promise<boolean> => false,
    ask: resolveNothing,
    camera: doNothing,
    canCompose: true,
    cancel: doNothing,
    completeStep: resolveNothing,
    confirm: resolveNothing,
    coverageNotice: (): null => null,
    createManual: resolveNothing,
    editPage: resolveNothing,
    home: doNothing,
    navigate: doNothing,
    open: resolveNothing,
    parse: resolveNothing,
    questionChanged: doNothing,
    rename: resolveNothing,
    setReadingLanguage: resolveNothing,
    restore: resolveNothing,
    step: resolveNothing,
    targetChanged: doNothing,
} satisfies WorkflowController)

const GROUPS: readonly WorkflowPreviewGroup[] = ['Home', 'Pages', 'Review', 'Guide', 'Done', 'Camera', 'Settings']
const GROUP_OPTIONS = GROUPS.map((value) => ({ value, label: value }))
const SCHEME_OPTIONS = [
    { value: 'light', label: 'Light' },
    { value: 'dark', label: 'Dark' },
] as const

export function workflowPreviewCase(value: unknown): WorkflowPreviewCase {
    return WORKFLOW_PREVIEW_CASES.find((preview) => preview.id === value)?.id ?? 'home-empty'
}

/** Development visual evidence only. Fixture selection remounts real screens so local drafts never cross states. */
/**
 * What a hosting route hands the screens so the gallery can sit under the app's real native Stack header. In this mode
 * the gallery draws no banner, controls or second header, and the host's header More opens the screen's own More sheet.
 */
export type NativeChrome = {
    readonly more: MoreControl
    // Home's large-title collapse and Quick check's "Question N of M" live above the screen, as in the production routes.
    readonly scrollY: SharedValue<number>
    readonly onCollapsedChange: (collapsed: boolean) => void
    readonly progress: QuickProgress
}

export function WorkflowPreview({
    initialCase = 'home-empty',
    initialScheme = 'light',
    showControls = true,
    native,
    tour = false,
    externalTour = false,
    reduceMotion = true,
    reveal,
}: {
    readonly initialCase?: WorkflowPreviewCase
    readonly initialScheme?: ColorScheme
    readonly showControls?: boolean
    readonly native?: NativeChrome
    // Explicit inert tour fixture for native visual evidence. Off by default: the gallery shows no tips.
    readonly tour?: boolean
    readonly externalTour?: boolean
    readonly reduceMotion?: boolean | null
    // Explicit inert motion-capture sequence. No controller or request is involved.
    readonly reveal?: 'pass' | 'refuse' | 'cannot-verify'
}): ReactElement {
    const [scheme, setScheme] = useState<ColorScheme>(initialScheme)
    const [selected, setSelected] = useState<WorkflowPreviewCase>(initialCase)
    useEffect(() => {
        if (reveal === undefined) return undefined
        setSelected('guide-pending')
        // Setup delay, not animation: let the OS motion preference resolve before the canned result arrives.
        const timer = setTimeout(
            () =>
                setSelected(
                    reveal === 'pass' ? 'guide-pass' : reveal === 'refuse' ? 'guide-refuse' : 'guide-cannot-verify',
                ),
            1500,
        )
        return (): void => clearTimeout(timer)
    }, [reveal])
    return (
        <FeedbackProvider reduceMotion={reduceMotion}>
            <ThemeProvider scheme={scheme}>
                <PreviewFrame
                    scheme={scheme}
                    onScheme={setScheme}
                    selected={selected}
                    onSelect={setSelected}
                    showControls={showControls && native === undefined}
                    native={native}
                    tour={tour}
                    externalTour={externalTour}
                />
            </ThemeProvider>
        </FeedbackProvider>
    )
}

function PreviewFrame({
    scheme,
    onScheme,
    selected,
    onSelect,
    showControls,
    native,
    tour,
    externalTour,
}: {
    readonly scheme: ColorScheme
    readonly onScheme: (scheme: ColorScheme) => void
    readonly selected: WorkflowPreviewCase
    readonly onSelect: (selected: WorkflowPreviewCase) => void
    readonly showControls: boolean
    readonly native: NativeChrome | undefined
    readonly tour: boolean
    readonly externalTour: boolean
}): ReactElement {
    const { colors } = useTheme()
    // The gallery runs inside the app, under the status bar, so its controls clear the top inset themselves.
    const insets = useSafeAreaInsets()
    const { state } = workflowPreviewFixture(selected)
    const group = WORKFLOW_PREVIEW_CASES.find((preview) => preview.id === selected)!.group
    const options = WORKFLOW_PREVIEW_CASES.filter((preview) => preview.group === group).map((preview) => ({
        value: preview.id,
        label: preview.label.split(' · ')[1]!,
    }))

    const screenFor = (): ReactElement =>
        selected === 'home-unavailable' ? (
            <AppUnavailableScreen />
        ) : (
            <DocumentFixture key={selected} selected={selected} native={native} />
        )
    if (native !== undefined || !showControls) {
        // The camera is dark and full bleed whatever the appearance; every other screen follows the gallery's scheme.
        return (
            <View style={[styles.root, { backgroundColor: colors.canvas }]} testID="workflow-preview">
                <StatusBar style={state.route === 'camera' || scheme === 'dark' ? 'light' : 'dark'} />
                <View key={selected} style={styles.nativeDevice}>
                    {externalTour ? (
                        screenFor()
                    ) : (
                        <InertTour enabled={tour} screen={tourScreenFor(selected)} scene={selected}>
                            {screenFor()}
                        </InertTour>
                    )}
                </View>
            </View>
        )
    }
    return (
        <View style={[styles.root, { backgroundColor: colors.canvas }]} testID="workflow-preview">
            <View
                style={[
                    styles.controls,
                    { backgroundColor: colors.surface, borderColor: colors.border, paddingTop: 10 + insets.top },
                ]}
            >
                <Caption>
                    {showControls ? WORKFLOW_PREVIEW_BANNER : 'Synthetic visual preview · local fixtures only'}
                </Caption>
                {showControls ? (
                    <>
                        <View style={styles.topControls}>
                            <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                                <SegmentedControl
                                    label="Workflow screen"
                                    value={group}
                                    options={GROUP_OPTIONS}
                                    onChange={(next): void => {
                                        const first = WORKFLOW_PREVIEW_CASES.find((preview) => preview.group === next)
                                        if (first !== undefined) {
                                            onSelect(first.id)
                                        }
                                    }}
                                />
                            </ScrollView>
                            <SegmentedControl
                                label="Preview appearance"
                                value={scheme}
                                options={SCHEME_OPTIONS}
                                onChange={onScheme}
                            />
                        </View>
                        <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                            <SegmentedControl
                                label="Workflow state"
                                value={selected}
                                options={options}
                                onChange={onSelect}
                            />
                        </ScrollView>
                        {selected === 'guide-instructions' ? (
                            <Caption>Press More to open the real details sheet.</Caption>
                        ) : null}
                        <Caption>Screen actions are inert. Change fixtures with the controls above.</Caption>
                    </>
                ) : null}
            </View>
            <View key={selected} style={[styles.device, { borderColor: colors.border }]}>
                {externalTour ? (
                    screenFor()
                ) : (
                    <InertTour enabled={tour} screen={tourScreenFor(selected)} scene={selected}>
                        {screenFor()}
                    </InertTour>
                )}
            </View>
        </View>
    )
}

/** Uses production document inputs, the shared v2 composer and the actual native renderer over inert controller IO. */
function DocumentFixture({
    selected,
    native,
}: {
    readonly selected: WorkflowPreviewCase
    readonly native?: NativeChrome
}): ReactElement {
    const { state, entry } = workflowPreviewFixture(selected, { reusableCapture: true })
    const ownMore = useMoreState()
    const more = native?.more ?? ownMore
    const progress = useQuickProgress(entry.session)
    const quick = native?.progress ?? progress
    const controller =
        selected === 'guide-needs-pages'
            ? { ...INERT_WORKFLOW_CONTROLLER, coverageNotice: (): string => 'A clearer page is needed.' }
            : INERT_WORKFLOW_CONTROLLER
    const nav = defaultNav(controller)
    const kind: ScreenKindV2 =
        selected === 'settings'
            ? 'more'
            : state.route === 'camera'
              ? 'camera'
              : state.route === 'library'
                ? 'home'
                : selected === 'done-finished'
                  ? 'completion'
                  : state.route === 'overview'
                    ? 'quick-check'
                    : state.route === 'pages'
                      ? state.pending?.startsWith('Reading')
                          ? 'reading'
                          : entry.session.pages.length === 0
                            ? 'add'
                            : 'pages'
                      : state.answer !== null
                        ? 'answer'
                        : state.check !== null
                          ? 'result'
                          : state.notice !== null
                            ? 'recovery'
                            : 'guide'
    const inputs = documentInputs(kind, { state, entry }, quick)
    const presentation = cameraPreviewPresentation(selected)
    const permission =
        presentation?.status === 'permission'
            ? 'denied'
            : presentation?.status === 'checking-access'
              ? 'undetermined'
              : 'granted'
    if (kind === 'camera' && inputs.uiState?.camera != null)
        inputs.uiState.camera = {
            ...inputs.uiState.camera,
            permission,
            failed: presentation?.status === 'error',
            canAskAgain: presentation?.status === 'permission' ? presentation.canAskAgain : null,
        }
    const compose = (next: typeof inputs): ReturnType<typeof buildFallbackDocumentV2> =>
        buildFallbackDocumentV2(next, {
            sha256Hex,
            now: () => new Date('2026-10-29T00:00:00.000Z'),
            reason: 'disabled',
            evidence: 'synthetic-fixture',
        })
    const document = compose(inputs)
    const bindings: FrameBindings = {
        resolve: (intent) => {
            if (intent.intent === 'navigate' && intent.target === 'back')
                return {
                    enabled: !state.loading,
                    reason: state.loading ? waitCopyV2('home').heading : null,
                    run: more.open ? more.hide : doNothing,
                }
            if (intent.intent === 'open-details' && intent.target === 'device-settings')
                return { enabled: state.pending === null, reason: state.pending, run: doNothing }
            if (
                kind === 'camera' &&
                ((intent.intent === 'confirm' && intent.target === 'camera-permission') ||
                    (intent.intent === 'retry' && intent.target === 'camera'))
            )
                return { enabled: state.pending === null, reason: state.pending, run: doNothing }
            return resolveIntent(intent, {
                kind: baseKindV2(kind),
                state,
                entry,
                controller,
                nav,
                extras: { showMore: more.show, choosePages: doNothing, contextualMore: more.open },
            })
        },
        live: {
            state,
            entry,
            controller,
            nav,
            more,
            quick,
            pages: { open: (): void => more.show('details'), arriving: new Set() },
            closeSheet: more.hide,
        },
        session: entry.session,
        pageUris: state.pageUris,
        pageImageStatus: 'ready',
        capture: state.capture,
        marks: state.stages?.masks ?? [],
        heroMode: 'inline',
        inspect: false,
        workInProgress: state.pending !== null || state.loading,
        camera:
            kind === 'camera'
                ? {
                      preview: (
                          <ManualImage uri={Object.values(state.pageUris)[0] ?? ''} label="Synthetic camera preview" />
                      ),
                      capture: doNothing,
                      ready: presentation === null && selected !== 'camera-preparing',
                      permission,
                      failed: presentation?.status === 'error',
                      canAskAgain: presentation?.status === 'permission' ? presentation.canAskAgain : null,
                      requestPermission: doNothing,
                      openSettings: doNothing,
                      retry: doNothing,
                  }
                : undefined,
        operationNotice: state.notice,
        language: { value: 'en', onChange: doNothing },
        closeOverlays: more.hide,
    }
    const variant =
        state.loading || presentation?.status === 'checking-access'
            ? 'pending'
            : state.storageReadOnly
              ? 'recovery'
              : presentation?.status === 'error'
                ? 'error'
                : presentation?.status === 'permission'
                  ? 'auth-needed'
                  : state.pending !== null || selected === 'camera-preparing'
                    ? 'busy'
                    : 'ready'
    const testID =
        kind === 'home'
            ? 'library-screen'
            : kind === 'quick-check'
              ? 'overview-screen'
              : kind === 'completion'
                ? 'done-screen'
                : kind === 'add' || kind === 'pages'
                  ? 'pages-screen'
                  : kind === 'reading'
                    ? 'reading-screen'
                    : kind === 'camera'
                      ? 'camera-screen'
                      : kind === 'more'
                        ? 'settings-screen'
                        : 'guide-screen'
    const moreInputs = documentInputs('more', { state, entry }, quick, true)
    return (
        <>
            <DocumentRenderer document={document} bindings={bindings} variant={variant} testID={testID} />
            <MoreSheet visible={more.open} title="More about this step" onClose={more.hide} documentFrame>
                <DocumentRenderer document={compose(moreInputs)} bindings={bindings} testID="preview-more-document" />
            </MoreSheet>
        </>
    )
}

const styles = StyleSheet.create({
    root: { flex: 1, minHeight: 0 },
    controls: { paddingHorizontal: 10, paddingBottom: 10, gap: 6, borderBottomWidth: 1 },
    topControls: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    nativeDevice: { flex: 1, minHeight: 0 },
    device: { flex: 1, width: '100%', maxWidth: 480, alignSelf: 'center', minHeight: 0, borderWidth: 1 },
})
