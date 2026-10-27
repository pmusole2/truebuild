import { groundedRegion } from './grounded-region'
import { useState, type ReactElement, type ReactNode } from 'react'
import { Button, Image, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { Rect as SvgRect } from 'react-native-svg'
import type { Fact, ManualSession, SourceRef } from '@truebuild/contracts'
import { FrozenPhoto } from '../assembly/frozen-photo'
import { boxOnDisplay } from '../assembly/frame-geometry'
import { stepPartChoices } from '../assembly/question-state'
import { reviewedSession, unresolvedCriticalFacts, type CaptureController, type WorkflowState } from './controller'
import type { LibraryEntry } from './library'

export type WorkflowScreenProps = { state: WorkflowState; controller: CaptureController }
export function Screen({
    title,
    children,
    onBack,
}: {
    title: string
    children: ReactNode
    onBack?: () => void
}): ReactElement {
    return (
        <SafeAreaView style={styles.safe}>
            <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}>
                {onBack === undefined ? null : <Button title="Back" onPress={onBack} />}
                <Text accessibilityRole="header" style={styles.title}>
                    {title}
                </Text>
                {children}
            </ScrollView>
        </SafeAreaView>
    )
}
export function WorkflowNotice({ state, controller }: WorkflowScreenProps): ReactElement {
    return (
        <View accessibilityLiveRegion="polite">
            {state.notice === null ? null : <Text accessibilityRole="alert">{state.notice}</Text>}
            {state.storageReadOnly ? (
                <Button
                    title={state.loading ? 'Reading local library…' : 'Retry local library'}
                    disabled={state.loading || state.pending !== null}
                    onPress={(): void => {
                        void controller.restore()
                    }}
                />
            ) : null}
            {state.pending === null ? null : (
                <>
                    <Text>{state.pending}</Text>
                    <Button title="Cancel" onPress={controller.cancel} />
                </>
            )}
        </View>
    )
}
export function LibraryScreen({ state, controller }: WorkflowScreenProps): ReactElement {
    return (
        <Screen title="Your manuals">
            <WorkflowNotice state={state} controller={controller} />
            {state.loading ? (
                <Text>Restoring local library…</Text>
            ) : state.entries.length === 0 ? (
                <Text>No manuals yet. Scan or choose your own manual pages to start.</Text>
            ) : null}
            {state.entries.map((entry) => (
                <View key={entry.session.manualId} style={styles.section}>
                    <Text style={styles.subtitle}>{entry.session.title}</Text>
                    <Text>
                        {entry.session.pages.length} pages · {entry.session.reviewedSteps.length} steps ·{' '}
                        {entry.session.reviewStatus}
                    </Text>
                    <Text>{entry.completedStepIds.length} steps marked complete by you</Text>
                    <Button
                        title={`Open ${entry.session.title}`}
                        onPress={(): void => {
                            void controller.open(entry.session.manualId)
                        }}
                    />
                </View>
            ))}
            <Button
                title="Add manual"
                disabled={state.loading || state.pending !== null || state.storageReadOnly}
                onPress={(): void => {
                    void controller.createManual()
                }}
            />
        </Screen>
    )
}
export type PagesScreenProps = WorkflowScreenProps & {
    entry: LibraryEntry
    choosePages: (replaceIndex?: number) => void
}
export function PagesScreen({ state, controller, entry, choosePages }: PagesScreenProps): ReactElement {
    const [title, setTitle] = useState(entry.session.title)
    const busy = state.pending !== null || state.storageReadOnly
    return (
        <Screen title="Manual pages" onBack={controller.home}>
            <WorkflowNotice state={state} controller={controller} />
            <TextInput
                accessibilityLabel="Manual title"
                value={title}
                maxLength={200}
                onChangeText={setTitle}
                onEndEditing={(): void => {
                    void controller.rename(title)
                }}
                style={styles.input}
            />
            <Text>Pages stay on this device. Reading sends these pages to your configured TrueBuild API.</Text>
            <Text>Up to 20 pages. Phone photos are resized and compressed locally before upload.</Text>
            {entry.session.pages.map((page, index) => (
                <View key={page.pageId} style={styles.section}>
                    <Text>Page {index + 1}</Text>
                    <PageImage uri={state.pageUris[page.pageId]} label={`Manual page ${index + 1}`} />
                    <View style={styles.row}>
                        <Button
                            title={`Move page ${index + 1} up`}
                            disabled={busy || index === 0}
                            onPress={(): void => {
                                void controller.editPage(index, 'up')
                            }}
                        />
                        <Button
                            title={`Move page ${index + 1} down`}
                            disabled={busy || index === entry.session.pages.length - 1}
                            onPress={(): void => {
                                void controller.editPage(index, 'down')
                            }}
                        />
                        <Button
                            title={`Remove page ${index + 1}`}
                            disabled={busy}
                            onPress={(): void => {
                                void controller.editPage(index, 'remove')
                            }}
                        />
                        <Button
                            title={`Retake page ${index + 1}`}
                            disabled={busy}
                            onPress={(): void => controller.camera({ kind: 'page', replaceIndex: index })}
                        />
                        <Button
                            title={`Replace page ${index + 1} from photos`}
                            disabled={busy}
                            onPress={(): void => choosePages(index)}
                        />
                    </View>
                </View>
            ))}
            <Button
                title="Scan a page"
                disabled={busy || entry.session.pages.length >= 20}
                onPress={(): void => controller.camera({ kind: 'page' })}
            />
            <Button
                title="Choose pages from photos"
                disabled={busy || entry.session.pages.length >= 20}
                onPress={(): void => choosePages()}
            />
            <Button
                title={entry.session.rawExtraction === null ? 'Read manual' : 'Read manual again'}
                disabled={busy || entry.session.pages.length === 0}
                onPress={(): void => {
                    void controller.parse()
                }}
            />
            {entry.session.rawExtraction === null ? null : (
                <Button
                    title="Review extracted facts"
                    disabled={busy}
                    onPress={(): void => controller.navigate('overview')}
                />
            )}
        </Screen>
    )
}
function PageImage({ uri, label }: { uri: string | undefined; label: string }): ReactElement {
    return uri === undefined ? (
        <Text>Loading local page…</Text>
    ) : (
        <Image source={{ uri }} accessibilityLabel={label} resizeMode="contain" style={styles.thumbnail} />
    )
}
function factText<T>(fact: Fact<T>, display: (value: T) => string): string {
    return fact.state === 'known' ? display(fact.value) : `Unknown: ${fact.reason}`
}
export function StepFacts({ session, index }: { session: ManualSession; index: number }): ReactElement {
    const step = session.reviewedSteps[index]
    if (step === undefined) {
        return <Text>No extracted steps yet.</Text>
    }
    return (
        <View style={styles.section}>
            <Text style={styles.subtitle}>
                {step.order}. {step.title}
            </Text>
            {step.parts.map((part) => (
                <Text key={part.partId}>
                    {part.partId}: {factText(part.quantity, String)}
                </Text>
            ))}
            <Text>Orientation: {factText(step.orientation, (value) => value.description)}</Text>
            <Text>Connection: {factText(step.connection, (value) => value.description)}</Text>
            {step.visibleChecks.map((check) => (
                <Text key={check.checkId}>Visible check: {factText(check.description, String)}</Text>
            ))}
            {step.correction?.actions.map((action) => (
                <Text key={action.actionId}>Correction: {action.instruction}</Text>
            ))}
        </View>
    )
}
export function SourceDiagrams({
    refs,
    session,
    pageUris,
}: {
    refs: readonly SourceRef[]
    session: ManualSession
    pageUris: WorkflowState['pageUris']
}): ReactElement {
    return (
        <View>
            {refs.map((ref, index) => {
                const page = session.pages.find((page) => page.pageId === ref.pageId)
                if (page === undefined) {
                    return <Text key={index}>Cited diagram unavailable.</Text>
                }
                return (
                    <View key={`${ref.pageId}-${index}`} style={styles.section}>
                        <Text>Expected diagram · page {session.pages.indexOf(page) + 1}</Text>
                        <View style={{ width: '100%', maxWidth: 320, aspectRatio: page.width / page.height }}>
                            <Image
                                source={{ uri: pageUris[page.pageId] }}
                                accessibilityLabel={`Expected diagram page ${session.pages.indexOf(page) + 1}`}
                                resizeMode="contain"
                                style={StyleSheet.absoluteFill}
                            />
                            {ref.region === null ? null : (
                                <View
                                    pointerEvents="none"
                                    style={[
                                        styles.region,
                                        {
                                            left: `${ref.region.x * 100}%`,
                                            top: `${ref.region.y * 100}%`,
                                            width: `${ref.region.width * 100}%`,
                                            height: `${ref.region.height * 100}%`,
                                        },
                                    ]}
                                />
                            )}
                        </View>
                    </View>
                )
            })}
        </View>
    )
}
export function OverviewScreen({
    state,
    controller,
    entry,
}: WorkflowScreenProps & { entry: LibraryEntry }): ReactElement {
    const { session } = entry
    const [confirmed, setConfirmed] = useState(false)
    const canConfirm = reviewedSession(session) !== null
    const unresolved = unresolvedCriticalFacts(session)
    return (
        <Screen title={session.title} onBack={controller.home}>
            <WorkflowNotice state={state} controller={controller} />
            <Text>
                Review extracted facts against your original diagrams. Unknown critical facts block verified checks.
            </Text>
            <View style={styles.row}>
                {session.pages.map((page, index) => (
                    <PageImage key={page.pageId} uri={state.pageUris[page.pageId]} label={`Manual page ${index + 1}`} />
                ))}
            </View>
            {session.parts.map((part) => (
                <Text key={part.partId}>
                    Part {part.partId}: {factText(part.name, String)}
                </Text>
            ))}
            {unresolved.map((issue) => (
                <Text key={issue}>Unresolved critical fact: {issue}</Text>
            ))}
            {session.rawExtraction?.unknowns.map((unknown, index) => (
                <Text key={index}>Extraction note: {unknown}</Text>
            ))}
            {session.reviewedSteps.map((step, index) => (
                <View key={step.stepId} style={styles.section}>
                    <StepFacts session={session} index={index} />
                    <SourceDiagrams refs={step.sourceRefs} session={session} pageUris={state.pageUris} />
                    {session.reviewStatus !== 'reviewed' ? null : (
                        <Button
                            title={`Guide step ${step.order}`}
                            onPress={(): void => {
                                void controller.step(index)
                            }}
                        />
                    )}
                </View>
            ))}
            {session.reviewStatus === 'reviewed' ? (
                <>
                    <Text>Facts confirmed by you.</Text>
                    <Button title="Continue assembly" onPress={(): void => controller.navigate('guide')} />
                </>
            ) : (
                <>
                    <Pressable
                        accessibilityRole="checkbox"
                        accessibilityLabel="I checked all facts and corrections against the manual"
                        accessibilityState={{ checked: confirmed, disabled: !canConfirm }}
                        disabled={!canConfirm}
                        onPress={(): void => setConfirmed(!confirmed)}
                        style={styles.section}
                    >
                        <Text>{confirmed ? '☑' : '☐'} I checked all facts and corrections against the manual</Text>
                    </Pressable>
                    {!canConfirm ? (
                        <Text>
                            Add or retake clearer pages showing the unresolved facts, then read the manual again. No
                            unknown facts will be filled in automatically.
                        </Text>
                    ) : null}
                    <Button
                        title="Confirm reviewed facts"
                        disabled={!confirmed || !canConfirm || state.pending !== null || state.storageReadOnly}
                        onPress={(): void => {
                            void controller.confirm()
                        }}
                    />
                </>
            )}
            <Button
                title="Edit manual pages"
                disabled={state.pending !== null}
                onPress={(): void => controller.navigate('pages')}
            />
        </Screen>
    )
}
export function GuideScreen({ state, controller, entry }: WorkflowScreenProps & { entry: LibraryEntry }): ReactElement {
    const step = entry.session.reviewedSteps[entry.stepIndex]
    const blocked = controller.coverageNotice()
    const highlight = groundedRegion(state.answer ?? state.check)
    const busy = state.pending !== null || state.storageReadOnly
    return (
        <Screen title={`Assembly · ${entry.session.title}`} onBack={(): void => controller.navigate('overview')}>
            <WorkflowNotice state={state} controller={controller} />
            <Text>
                Step {entry.stepIndex + 1} of {entry.session.reviewedSteps.length}
            </Text>
            <StepFacts session={entry.session} index={entry.stepIndex} />
            <SourceDiagrams refs={step?.sourceRefs ?? []} session={entry.session} pageUris={state.pageUris} />
            {blocked === null ? null : <Text>{blocked}</Text>}
            {state.capture === null ? (
                <Text>Take a photo of this step to check or ask about it.</Text>
            ) : (
                <FrozenPhoto
                    observation={state.capture.observation}
                    caption="Frozen photo for this step. New photos clear prior results."
                    onTapPoint={
                        busy ? undefined : (point): void => controller.targetChanged({ kind: 'point', ...point })
                    }
                    overlay={
                        highlight === null
                            ? undefined
                            : (displayed): ReactNode => {
                                  const rect = boxOnDisplay(highlight, displayed)
                                  return <SvgRect {...rect} fill="none" stroke="#c34224" strokeWidth={3} />
                              }
                    }
                />
            )}
            {state.check === null ? null : (
                <View accessibilityLiveRegion="polite">
                    <Text style={styles.subtitle}>
                        {state.check.decision === 'pass'
                            ? 'Pass'
                            : state.check.decision === 'refuse'
                              ? 'Refuse'
                              : 'Cannot verify'}
                    </Text>
                    <Text>{state.check.reason}</Text>
                    {state.check.missingEvidence.map((missing, index) => (
                        <Text key={index}>{missing}</Text>
                    ))}
                    <SourceDiagrams refs={state.check.sourceRefs} session={entry.session} pageUris={state.pageUris} />
                </View>
            )}
            <Button
                title="Take new photo and check"
                disabled={busy || blocked !== null || entry.session.reviewStatus !== 'reviewed'}
                onPress={(): void => controller.camera({ kind: 'check' })}
            />
            <Button
                title="Take photo to ask"
                disabled={busy || blocked !== null || entry.session.reviewStatus !== 'reviewed'}
                onPress={(): void => controller.camera({ kind: 'question' })}
            />
            {state.capture === null ? null : (
                <View style={styles.section}>
                    <Text>
                        Tap a point in the frozen photo or select a step part. Type a question, or use your keyboard’s
                        dictation. Each submitted question has its own 8-second request deadline; the frozen photo stays
                        until you retake it or leave this step.
                    </Text>
                    {step === undefined
                        ? null
                        : stepPartChoices(entry.session, step).map((part) => (
                              <Button
                                  key={part.partId}
                                  title={`Ask about ${part.label}`}
                                  disabled={busy}
                                  onPress={(): void => controller.targetChanged({ kind: 'part', partId: part.partId })}
                              />
                          ))}
                    <Text>
                        {state.target === null
                            ? 'Choose a point or part.'
                            : state.target.kind === 'part'
                              ? `Selected part: ${state.target.partId}`
                              : 'Selected point in photo.'}
                    </Text>
                    <TextInput
                        accessibilityLabel="Question about frozen photo"
                        multiline
                        value={state.question}
                        maxLength={500}
                        onChangeText={controller.questionChanged}
                        style={styles.input}
                        editable={controller.canCompose}
                    />
                    <Button
                        title="Send question"
                        disabled={busy || state.target === null || state.question.trim().length === 0}
                        onPress={(): void => {
                            void controller.ask()
                        }}
                    />
                    {state.answer === null ? null : (
                        <>
                            <Text>{state.answer.answer}</Text>
                            {state.answer.missingEvidence.map((missing, index) => (
                                <Text key={index}>{missing}</Text>
                            ))}
                            <SourceDiagrams
                                refs={state.answer.sourceRefs}
                                session={entry.session}
                                pageUris={state.pageUris}
                            />
                        </>
                    )}
                </View>
            )}
            <Button
                title="Mark step complete myself"
                disabled={busy}
                onPress={(): void => {
                    void controller.completeStep()
                }}
            />
            <View style={styles.row}>
                <Button
                    title="Previous step"
                    disabled={busy || entry.stepIndex === 0}
                    onPress={(): void => {
                        void controller.step(entry.stepIndex - 1)
                    }}
                />
                <Button
                    title="Next step"
                    disabled={busy || entry.stepIndex >= entry.session.reviewedSteps.length - 1}
                    onPress={(): void => {
                        void controller.step(entry.stepIndex + 1)
                    }}
                />
            </View>
        </Screen>
    )
}
const styles = StyleSheet.create({
    safe: { flex: 1, backgroundColor: '#fff' },
    content: { padding: 16, gap: 16 },
    title: { fontSize: 24, fontWeight: '600' },
    subtitle: { fontSize: 18, fontWeight: '600' },
    section: { gap: 8, paddingVertical: 8 },
    row: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
    input: { borderWidth: 1, borderColor: '#777', borderRadius: 4, padding: 12, minHeight: 48 },
    thumbnail: { width: 120, height: 160 },
    region: { position: 'absolute', borderWidth: 2, borderColor: '#c34224' },
})
