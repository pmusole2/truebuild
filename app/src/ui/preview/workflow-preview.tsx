import { useState, type ReactElement } from 'react'
import { ScrollView, StyleSheet, View } from 'react-native'
import { CameraStage } from '../../features/capture/camera-stage'
import { ManualImage } from '../../features/capture/page-media'
import { SettingsScreen } from '../../features/capture/settings-screen'
import { AppUnavailableScreen } from '../../features/capture/app-unavailable'
import { stepAssemblyGuide } from '../../features/capture/step-facts'
import { ShutterButton } from '../camera-chrome'
import {
    DoneScreen,
    GuideScreen,
    LibraryScreen,
    OverviewScreen,
    PagesScreen,
    ReadingScreen,
    type WorkflowController,
} from '../../features/capture/screens'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
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
export function WorkflowPreview({
    initialCase = 'home-empty',
    initialScheme = 'light',
    showControls = true,
}: {
    readonly initialCase?: WorkflowPreviewCase
    readonly initialScheme?: ColorScheme
    readonly showControls?: boolean
}): ReactElement {
    const [scheme, setScheme] = useState<ColorScheme>(initialScheme)
    const [selected, setSelected] = useState<WorkflowPreviewCase>(initialCase)
    return (
        <FeedbackProvider reduceMotion={true}>
            <ThemeProvider scheme={scheme}>
                <PreviewFrame
                    scheme={scheme}
                    onScheme={setScheme}
                    selected={selected}
                    onSelect={setSelected}
                    showControls={showControls}
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
}: {
    readonly scheme: ColorScheme
    readonly onScheme: (scheme: ColorScheme) => void
    readonly selected: WorkflowPreviewCase
    readonly onSelect: (selected: WorkflowPreviewCase) => void
    readonly showControls: boolean
}): ReactElement {
    const { colors } = useTheme()
    // The gallery runs inside the app, under the status bar, so its controls clear the top inset themselves.
    const insets = useSafeAreaInsets()
    const { state, entry } = workflowPreviewFixture(selected)
    const group = WORKFLOW_PREVIEW_CASES.find((preview) => preview.id === selected)!.group
    const options = WORKFLOW_PREVIEW_CASES.filter((preview) => preview.group === group).map((preview) => ({
        value: preview.id,
        label: preview.label.split(' · ')[1]!,
    }))

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
                {selected === 'home-unavailable' ? (
                    <AppUnavailableScreen />
                ) : selected === 'settings' ? (
                    <SettingsScreen state={state} onOpenDeviceSettings={doNothing} />
                ) : state.route === 'camera' ? (
                    <CameraStage
                        intent={{
                            kind:
                                selected === 'camera-page'
                                    ? 'page'
                                    : selected === 'camera-question'
                                      ? 'question'
                                      : 'check',
                        }}
                        guide={
                            selected === 'camera-page'
                                ? undefined
                                : stepAssemblyGuide(entry.session, entry.stepIndex, state.pageUris)
                        }
                        presentation={
                            cameraPreviewPresentation(selected) ?? {
                                status: 'preview',
                                media: (
                                    // Fixture pages are SVG, which the native Image cannot draw: ManualImage can.
                                    <ManualImage
                                        uri={Object.values(state.pageUris)[0] ?? ''}
                                        label="Synthetic camera preview"
                                    />
                                ),
                                shutter: (
                                    <ShutterButton
                                        label={selected === 'camera-preparing' ? 'Preparing photo…' : 'Capture photo'}
                                        disabled={selected === 'camera-preparing'}
                                        onPress={doNothing}
                                    />
                                ),
                            }
                        }
                        onCancel={doNothing}
                        onRequestPermission={doNothing}
                        onOpenSettings={doNothing}
                        onRetry={doNothing}
                    />
                ) : state.route === 'library' ? (
                    <LibraryScreen state={state} controller={INERT_WORKFLOW_CONTROLLER} />
                ) : selected === 'done-finished' ? (
                    <DoneScreen state={state} entry={entry} controller={INERT_WORKFLOW_CONTROLLER} />
                ) : state.route === 'pages' && state.pending !== null && state.pending.startsWith('Reading') ? (
                    <ReadingScreen state={state} entry={entry} controller={INERT_WORKFLOW_CONTROLLER} />
                ) : state.route === 'pages' ? (
                    <PagesScreen
                        state={state}
                        entry={entry}
                        controller={INERT_WORKFLOW_CONTROLLER}
                        choosePages={doNothing}
                    />
                ) : state.route === 'overview' ? (
                    <OverviewScreen state={state} entry={entry} controller={INERT_WORKFLOW_CONTROLLER} />
                ) : (
                    <GuideScreen state={state} entry={entry} controller={INERT_WORKFLOW_CONTROLLER} />
                )}
            </View>
        </View>
    )
}

const styles = StyleSheet.create({
    root: { flex: 1, minHeight: 0 },
    controls: { paddingHorizontal: 10, paddingBottom: 10, gap: 6, borderBottomWidth: 1 },
    topControls: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    device: { flex: 1, width: '100%', maxWidth: 480, alignSelf: 'center', minHeight: 0, borderWidth: 1 },
})
