import { useCallback, useMemo, useState, type ReactElement } from 'react'
import { StyleSheet, View } from 'react-native'
import type { ManualBinding, ManualSession, ManualStep } from '@truebuild/contracts'
import { AppButton } from '../../ui/button'
import { FixedBottomBar, type BarAction } from '../../ui/bottom-bar'
import { SegmentedControl, TextField } from '../../ui/fields'
import { ProgressBar } from '../../ui/progress'
import { MoreSheet } from '../../ui/sheet'
import { Card, Stack } from '../../ui/surface'
import { Body, Caption, Heading, Instruction } from '../../ui/text'
import { focusRingStyle, useFocusRing } from '../../ui/focus'
import { PressMotion } from '../../ui/press-motion'
import { useTheme } from '../../theme/theme'
import { space, touchTarget } from '../../theme/tokens'
import { reviewedSession, unresolvedCriticalFacts } from './controller'
import type { LibraryEntry } from './library'
import { AboutThisCheck } from './more-sections'
import { PageImage } from './page-media'
import { firstSentences, isProgressNotice, plainReason, plainWords } from './plain-copy'
import { editableQuestions, otherBlockers, type Question } from './quick-check-model'
import { PlainNotice, ScreenBody, TextRegion, useHeroHeight } from './screen-layout'
import { InlineHeader, useMoreState, type ChromeProps } from './screen-header'
import { defaultNav, type ScreenNav } from './screen-nav'
import { StepDetails } from './step-details'
import { StepPicture } from './step-picture'
import type { WorkflowScreenProps } from './workflow-types'

/** Internal issue wording turned into a plain line for More. Part ids and field names never show. */
function plainIssue(issue: string): string {
    return issue.replace(/^Part \S+ name: /u, 'A part name is unclear: ').replace(/, quantity of \S+:/u, ', how many:')
}

export type QuickProgress = {
    readonly questions: readonly Question[]
    readonly current: Question | undefined
    // The current question's place among all the questions this read started with; 0 when none is showing.
    readonly position: number
    readonly total: number
    readonly skipped: readonly string[]
    readonly skip: (id: string) => void
    readonly unskip: () => void
    // "Question 2 of 5", for the fixed header; undefined when no question is on screen.
    readonly label: string | undefined
}

/**
 * Where the person is in the questions. It is held above the screen so that accepting a fact (which makes a new
 * revision of the manual) keeps the count: after question 1 of 2 comes question 2 of 2. A different manual or a new read
 * of different pages starts the count again.
 */
export function useQuickProgress(session: ManualSession | undefined): QuickProgress {
    const questions = useMemo(() => (session === undefined ? [] : editableQuestions(session)), [session])
    const key =
        session === undefined
            ? ''
            : `${session.manualId}:${session.pages.map((page) => page.pageId).join(',')}:${session.rawExtraction === null ? 'unread' : 'read'}`
    const [progress, setProgress] = useState<{ key: string; total: number; skipped: readonly string[] }>({
        key,
        total: questions.length,
        skipped: [],
    })
    let live = progress
    if (progress.key !== key) {
        live = { key, total: questions.length, skipped: [] }
        setProgress(live)
    }
    const total = Math.max(live.total, questions.length)
    const asking = questions.filter((question) => !live.skipped.includes(question.id))
    const current = asking[0]
    const position = current === undefined ? 0 : total - questions.length + questions.indexOf(current) + 1
    const skip = useCallback(
        (id: string): void => setProgress((now) => ({ ...now, skipped: [...now.skipped, id] })),
        [],
    )
    const unskip = useCallback((): void => setProgress((now) => ({ ...now, skipped: [] })), [])
    const showing = current !== undefined && current.step.sourceRefs.length > 0
    return {
        questions,
        current,
        position,
        total,
        skipped: live.skipped,
        skip,
        unskip,
        label: showing ? `Question ${position} of ${total}` : undefined,
    }
}

type QuickCheckProps = WorkflowScreenProps &
    ChromeProps & { entry: LibraryEntry; readonly nav?: ScreenNav; readonly progress?: QuickProgress }

/**
 * Quick check: one honest question at a time. Only what the existing gate lets a person fill in is asked (a missing
 * orientation or missing visible checks, each from the step's cited page); anything else needs clearer pages. Nothing
 * is guessed, so with no value from the manual the card shows its picture, the question and Let me fix it. The editor
 * opens in the More sheet. The whole manual is confirmed only by the explicit Start building tap after the questions.
 */
export function OverviewScreen({
    state,
    controller,
    entry,
    nav: navProp,
    chrome = 'inline',
    more: moreProp,
    progress: progressProp,
}: QuickCheckProps): ReactElement {
    const { session } = entry
    const nav = navProp ?? defaultNav(controller)
    const internalMore = useMoreState()
    const more = moreProp ?? internalMore
    const heroHeight = useHeroHeight()
    const ownProgress = useQuickProgress(session)
    const { questions, current, position, total, skipped } = progressProp ?? ownProgress
    const skip = progressProp?.skip ?? ownProgress.skip
    const unskip = progressProp?.unskip ?? ownProgress.unskip
    const blockers = otherBlockers(session)
    const reviewed = session.reviewStatus === 'reviewed'
    const canConfirm = reviewedSession(session) !== null
    const busy = state.pending !== null || state.storageReadOnly
    // Nothing has been read yet: no extraction and no steps. (A session that already carries steps is shown as it is.)
    const noRead = session.rawExtraction === null && session.reviewedSteps.length === 0
    const unreadable = current !== undefined && current.step.sourceRefs.length === 0

    let sentence: string
    let primary: BarAction | null = null
    let secondary: BarAction | undefined
    if (noRead) {
        sentence = 'Add photos of your manual and read them first.'
        primary = { label: 'Add photos', compactLabel: 'Add', onPress: nav.editPages }
    } else if (current !== undefined && !unreadable) {
        // Short enough for one line at the normal size, so the manual's own words beneath it show without scrolling.
        // The editor in More keeps the full wording with the step number.
        sentence = current.kind === 'orientation' ? 'Which way should it face?' : 'What should you see?'
    } else if (questions.length > 0 || blockers.length > 0 || current !== undefined) {
        sentence = 'One thing still needs a clearer photo before we can check your work.'
        primary = {
            label: 'Add clearer photos',
            compactLabel: 'Add',
            testID: 'quick-check-clearer',
            onPress: nav.editPages,
        }
        secondary =
            skipped.length > 0
                ? { label: 'Answer skipped questions', icon: 'refresh' as const, onPress: unskip }
                : undefined
    } else if (canConfirm || reviewed) {
        sentence = 'Thanks. Your steps are ready.'
        primary = {
            label: reviewed ? 'Keep building' : 'Start building',
            compactLabel: reviewed ? 'Resume' : 'Start',
            testID: 'quick-check-start',
            busy: state.pending !== null,
            disabled: busy,
            onPress: (): void => {
                void nav.startBuilding()
            },
        }
    } else {
        sentence = 'One thing still needs a clearer photo before we can check your work.'
        primary = {
            label: 'Add clearer photos',
            compactLabel: 'Add',
            testID: 'quick-check-clearer',
            onPress: nav.editPages,
        }
    }

    const asking = current !== undefined && !unreadable
    // The header count already shows progress; "Saved. Thanks." would be a second sentence under the question.
    const quietState = state.notice !== null && isProgressNotice(state.notice) ? { ...state, notice: null } : state
    return (
        <ScreenBody testID="overview-screen">
            <View testID="quick-check-screen" style={styles.flex}>
                {chrome === 'inline' ? (
                    <InlineHeader
                        title="Quick check"
                        subtitle={asking ? `Question ${position} of ${total}` : undefined}
                        more={more}
                    />
                ) : null}
                {asking ? (
                    <>
                        <ProgressBar label={`Question ${position} of ${total}`} value={position - 1} total={total} />
                        <View style={styles.hero}>
                            <StepPicture
                                reference={current.step.sourceRefs[0]}
                                session={session}
                                pageUris={state.pageUris}
                                height={heroHeight}
                                cover
                            />
                        </View>
                        <TextRegion compact>
                            <PlainNotice state={quietState} controller={controller} />
                            <Instruction>{sentence}</Instruction>
                            {current.reason === null ? null : (
                                <Caption>{`The manual says: ${firstSentences(plainReason(current.reason), 1)}`}</Caption>
                            )}
                        </TextRegion>
                        <FixedBottomBar
                            primary={{
                                label: 'Let me fix it',
                                compactLabel: 'Fix',
                                testID: 'quick-check-fix',
                                disabled: busy,
                                onPress: (): void => more.show('fix'),
                            }}
                            secondary={{
                                label: 'Skip for now',
                                icon: 'arrowRight',
                                testID: 'quick-check-skip',
                                disabled: busy,
                                onPress: (): void => skip(current.id),
                            }}
                        />
                    </>
                ) : (
                    <>
                        <View style={styles.hero}>
                            <StepPicture
                                reference={session.reviewedSteps[0]?.sourceRefs[0]}
                                session={session}
                                pageUris={state.pageUris}
                                height={heroHeight}
                                cover
                            />
                        </View>
                        <TextRegion>
                            <PlainNotice state={quietState} controller={controller} />
                            <Instruction>{sentence}</Instruction>
                        </TextRegion>
                        <FixedBottomBar primary={primary} secondary={secondary} />
                    </>
                )}
            </View>
            <QuickCheckMore
                visible={more.open}
                onClose={more.hide}
                session={session}
                state={state}
                controller={controller}
                nav={nav}
                issues={unresolvedCriticalFacts(session)}
                editing={more.mode === 'fix' && asking ? current : undefined}
                busy={busy}
            />
        </ScreenBody>
    )
}

/**
 * The one scoped editor, opened by Let me fix it. Its draft lives only while the sheet is open: Cancel and closing
 * discard it, a refused save keeps it, and only Save writes (through the unchanged `acceptStepFacts`).
 */
function FixEditor({
    question,
    session,
    state,
    controller,
    busy,
    onDone,
}: {
    question: Question
    session: ManualSession
    state: WorkflowScreenProps['state']
    controller: WorkflowScreenProps['controller']
    busy: boolean
    onDone: () => void
}): ReactElement {
    const { step } = question
    const binding: ManualBinding = { kind: 'manual', manualId: session.manualId, revision: session.revision }
    const labels = new Map(
        session.parts.map((part) => [part.partId, part.name.state === 'known' ? part.name.value : 'A part']),
    )
    const parts = step.parts.map((part) => ({ value: part.partId, label: labels.get(part.partId) ?? 'A part' }))
    const [partId, setPartId] = useState<string | null>(parts.length === 1 ? parts[0]!.value : null)
    const [text, setText] = useState('')
    const [error, setError] = useState<string | undefined>(undefined)
    const accept = async (
        resolution: Parameters<WorkflowScreenProps['controller']['acceptStepFacts']>[2],
    ): Promise<void> => {
        if (await controller.acceptStepFacts(binding, step.stepId, resolution)) {
            onDone()
        }
    }
    const save = async (): Promise<void> => {
        if (question.kind === 'orientation') {
            const description = text.trim()
            if (description.length === 0) {
                setError('Write a few words first.')
                return
            }
            if (partId === null) {
                setError('Choose the part first.')
                return
            }
            setError(undefined)
            await accept({ orientation: { partId, description } })
            return
        }
        const visibleChecks = text
            .split('\n')
            .map((line) => line.trim())
            .filter((line) => line.length > 0)
        if (visibleChecks.length === 0) {
            setError('Write at least one thing, one per line.')
            return
        }
        setError(undefined)
        await accept({ visibleChecks })
    }
    return (
        <View testID="quick-check-editor" style={styles.editor}>
            <PlainNotice state={state} controller={controller} />
            <Body>
                {question.kind === 'orientation'
                    ? `Which way should the part face in step ${step.order}?`
                    : `What should you see when step ${step.order} is done?`}
            </Body>
            {question.reason === null ? null : <Caption>{`The manual says: ${plainWords(question.reason)}`}</Caption>}
            {question.kind === 'orientation' && parts.length > 1 ? (
                <SegmentedControl label="Which part" options={parts} value={partId ?? ''} onChange={setPartId} />
            ) : null}
            {question.kind === 'orientation' && parts.length === 1 ? (
                <Caption>{`Part: ${parts[0]!.label}`}</Caption>
            ) : null}
            <TextField
                label={question.kind === 'orientation' ? 'What the picture shows' : 'What you should see, one per line'}
                value={text}
                onChangeText={setText}
                multiline={question.kind === 'checks'}
                placeholder={question.kind === 'orientation' ? 'e.g. the groove faces inward' : 'One thing per line'}
                error={error}
                editable={!busy}
            />
            <AppButton
                label="Save"
                testID="quick-check-save"
                variant="accent"
                disabled={busy || (question.kind === 'orientation' && parts.length === 0)}
                onPress={(): void => {
                    void save()
                }}
            />
            <AppButton label="Cancel" testID="quick-check-cancel" variant="quiet" onPress={onDone} />
        </View>
    )
}

function QuickCheckMore({
    visible,
    onClose,
    session,
    state,
    controller,
    nav,
    issues,
    editing,
    busy,
}: {
    visible: boolean
    onClose: () => void
    session: ManualSession
    state: WorkflowScreenProps['state']
    controller: WorkflowScreenProps['controller']
    nav: ScreenNav
    issues: readonly string[]
    editing: Question | undefined
    busy: boolean
}): ReactElement {
    const [openPage, setOpenPage] = useState<number | null>(null)
    const enlarged = openPage === null ? undefined : session.pages[openPage]
    const notes = session.rawExtraction?.unknowns ?? []
    const close = (): void => {
        setOpenPage(null)
        onClose()
    }
    return (
        <MoreSheet
            visible={visible}
            title={
                editing !== undefined
                    ? 'Let me fix it'
                    : enlarged === undefined
                      ? 'What we read'
                      : `Page ${(openPage ?? 0) + 1}`
            }
            compactTitle={editing !== undefined ? 'Fix' : enlarged === undefined ? 'More' : undefined}
            onClose={close}
            detents={['tall', 'full']}
        >
            {editing !== undefined ? (
                <FixEditor
                    key={`${session.manualId}:${session.revision}:${editing.id}`}
                    question={editing}
                    session={session}
                    state={state}
                    controller={controller}
                    busy={busy}
                    onDone={close}
                />
            ) : enlarged !== undefined ? (
                <Stack gap="sm">
                    <PageImage
                        uri={state.pageUris[enlarged.pageId]}
                        label={`Manual page ${(openPage ?? 0) + 1}`}
                        aspectRatio={enlarged.width / enlarged.height}
                    />
                    <AppButton label="Back to what we read" variant="quiet" onPress={(): void => setOpenPage(null)} />
                </Stack>
            ) : (
                <Stack gap="md">
                    <Caption>You checked these against your manual. Tap a page to see it bigger.</Caption>
                    <View style={styles.strip}>
                        {session.pages.map((page, index) => (
                            <PageStripItem
                                key={page.pageId}
                                number={index + 1}
                                uri={state.pageUris[page.pageId]}
                                aspectRatio={page.width / page.height}
                                onOpen={(): void => setOpenPage(index)}
                            />
                        ))}
                    </View>
                    {session.parts.length === 0 ? null : (
                        <Stack gap="xs">
                            <Heading>Parts</Heading>
                            {session.parts.map((part) => (
                                <Body key={part.partId}>
                                    {part.name.state === 'known' ? part.name.value : 'A part with no clear name'}
                                </Body>
                            ))}
                        </Stack>
                    )}
                    {issues.length === 0 ? null : (
                        <Stack gap="xs">
                            <Heading>Still unclear</Heading>
                            {issues.map((issue) => (
                                <Body key={issue}>{plainIssue(issue)}</Body>
                            ))}
                        </Stack>
                    )}
                    {notes.length === 0 ? null : (
                        <Stack gap="xs">
                            <Heading>Things we could not read</Heading>
                            {notes.map((note, index) => (
                                <Body key={index}>{note}</Body>
                            ))}
                        </Stack>
                    )}
                    {session.reviewedSteps.map((step: ManualStep, index) => (
                        <Card tone="raised" key={step.stepId} testID="step-card">
                            <StepDetails session={session} index={index} />
                        </Card>
                    ))}
                    <AppButton
                        label="Edit manual pages"
                        variant="quiet"
                        disabled={state.pending !== null}
                        onPress={(): void => {
                            close()
                            nav.editPages()
                        }}
                    />
                    <AboutThisCheck result={session.rawExtraction ?? undefined} />
                </Stack>
            )}
        </MoreSheet>
    )
}

function PageStripItem({
    number,
    uri,
    aspectRatio,
    onOpen,
}: {
    number: number
    uri: string | undefined
    aspectRatio: number
    onOpen: () => void
}): ReactElement {
    const { colors } = useTheme()
    const focus = useFocusRing()
    return (
        <PressMotion
            testID="page-strip-item"
            accessibilityRole="button"
            accessibilityLabel={`Manual page ${number}`}
            accessibilityHint="Opens the page full width"
            {...focus.focusHandlers}
            onPress={onOpen}
            style={[styles.stripItem, focusRingStyle(focus.focused, colors)]}
        >
            <PageImage uri={uri} label={`Manual page ${number}`} aspectRatio={aspectRatio} />
        </PressMotion>
    )
}

const styles = StyleSheet.create({
    flex: { flex: 1 },
    hero: { paddingHorizontal: space.md, paddingTop: space.sm },
    editor: { gap: space.md },
    strip: { flexDirection: 'row', flexWrap: 'wrap', gap: space.xs },
    stripItem: { width: 96, minHeight: touchTarget },
})
