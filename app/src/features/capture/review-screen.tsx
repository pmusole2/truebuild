import { useRef, useState, type ReactElement } from 'react'
import { KeyboardAvoidingView, Platform, Pressable, StyleSheet, View } from 'react-native'
import type { ManualBinding, ManualSession, ManualStep } from '@truebuild/contracts'
import { AppButton } from '../../ui/button'
import { FixedBottomBar, type BarAction } from '../../ui/bottom-bar'
import { SegmentedControl, TextField } from '../../ui/fields'
import { ProgressBar } from '../../ui/progress'
import { MoreSheet } from '../../ui/sheet'
import { Card, Stack } from '../../ui/surface'
import { Body, Caption, Heading, Instruction } from '../../ui/text'
import { focusRingStyle, useFocusRing } from '../../ui/focus'
import { useTheme } from '../../theme/theme'
import { space, touchTarget } from '../../theme/tokens'
import { reviewedSession, unresolvedCriticalFacts } from './controller'
import type { LibraryEntry } from './library'
import { AboutThisCheck } from './more-sections'
import { PageImage } from './page-media'
import { editableQuestions, otherBlockers, type Question } from './quick-check-model'
import { PlainNotice, ScreenBody, TextRegion, useHeroHeight, useKeyboardVisible } from './screen-layout'
import { InlineHeader, useMoreState, type ChromeProps } from './screen-header'
import { defaultNav, type ScreenNav } from './screen-nav'
import { StepDetails } from './step-details'
import { StepPicture } from './step-picture'
import type { WorkflowScreenProps } from './workflow-types'

type QuickCheckProps = WorkflowScreenProps & ChromeProps & { entry: LibraryEntry; readonly nav?: ScreenNav }

/** Internal issue wording turned into a plain line for More. Part ids and field names never show. */
function plainIssue(issue: string): string {
    return issue.replace(/^Part \S+ name: /u, 'A part name is unclear: ').replace(/, quantity of \S+:/u, ', how many:')
}

/**
 * Quick check: one honest question at a time. Only what the existing gate lets a person fill in is asked (a missing
 * orientation or missing visible checks, each from the step's cited page); anything else needs clearer pages. Nothing
 * is guessed, and the whole manual is confirmed only by the explicit Start building tap once the questions are done.
 */
export function OverviewScreen({
    state,
    controller,
    entry,
    nav: navProp,
    chrome = 'inline',
    more: moreProp,
}: QuickCheckProps): ReactElement {
    const { session } = entry
    const nav = navProp ?? defaultNav(controller)
    const internalMore = useMoreState()
    const more = moreProp ?? internalMore
    const keyboard = useKeyboardVisible()
    const heroHeight = useHeroHeight(keyboard)
    const questions = editableQuestions(session)
    const [skipped, setSkipped] = useState<readonly string[]>([])
    const [total] = useState(questions.length)
    const asking = questions.filter((question) => !skipped.includes(question.id))
    const current = asking[0]
    const blockers = otherBlockers(session)
    const reviewed = session.reviewStatus === 'reviewed'
    const canConfirm = reviewedSession(session) !== null
    const busy = state.pending !== null || state.storageReadOnly
    const position = current === undefined ? 0 : total - questions.length + questions.indexOf(current) + 1
    const noRead = session.rawExtraction === null
    const unreadable = current !== undefined && current.step.sourceRefs.length === 0

    let sentence: string
    let primary: BarAction | null = null
    let secondary: BarAction | undefined
    if (noRead) {
        sentence = 'Add photos of your manual and read them first.'
        primary = { label: 'Add photos', onPress: nav.editPages }
    } else if (current !== undefined && !unreadable) {
        sentence =
            current.kind === 'orientation'
                ? `Which way should the part face in step ${current.step.order}?`
                : `What should you see when step ${current.step.order} is done?`
    } else if (questions.length > 0 || blockers.length > 0 || current !== undefined) {
        sentence = 'One thing still needs a clearer photo before we can check your work.'
        primary = { label: 'Add clearer photos', testID: 'quick-check-clearer', onPress: nav.editPages }
        secondary =
            skipped.length > 0 ? { label: 'Answer skipped questions', onPress: (): void => setSkipped([]) } : undefined
    } else if (canConfirm || reviewed) {
        sentence = 'Thanks. Your steps are ready.'
        primary = {
            label: reviewed ? 'Keep building' : 'Start building',
            testID: 'quick-check-start',
            busy: state.pending !== null,
            disabled: busy,
            onPress: (): void => {
                void nav.startBuilding()
            },
        }
    } else {
        sentence = 'One thing still needs a clearer photo before we can check your work.'
        primary = { label: 'Add clearer photos', testID: 'quick-check-clearer', onPress: nav.editPages }
    }

    return (
        <ScreenBody testID="overview-screen">
            <View testID="quick-check-screen" style={styles.flex}>
                {chrome === 'inline' ? (
                    <InlineHeader
                        title="Quick check"
                        subtitle={current === undefined || unreadable ? undefined : `Question ${position} of ${total}`}
                        more={more}
                    />
                ) : null}
                {current !== undefined && !unreadable ? (
                    <QuestionCard
                        key={`${session.manualId}:${session.revision}:${current.id}`}
                        question={current}
                        session={session}
                        state={state}
                        controller={controller}
                        position={position}
                        total={total}
                        sentence={sentence}
                        heroHeight={heroHeight}
                        busy={busy}
                        onSkip={(): void => setSkipped([...skipped, current.id])}
                    />
                ) : (
                    <>
                        <View style={styles.hero}>
                            <StepPicture
                                reference={session.reviewedSteps[0]?.sourceRefs[0]}
                                session={session}
                                pageUris={state.pageUris}
                                height={heroHeight}
                            />
                        </View>
                        <TextRegion>
                            <PlainNotice state={state} controller={controller} />
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
                nav={nav}
                issues={unresolvedCriticalFacts(session)}
            />
        </ScreenBody>
    )
}

function QuestionCard({
    question,
    session,
    state,
    controller,
    position,
    total,
    sentence,
    heroHeight,
    busy,
    onSkip,
}: {
    question: Question
    session: ManualSession
    state: WorkflowScreenProps['state']
    controller: WorkflowScreenProps['controller']
    position: number
    total: number
    sentence: string
    heroHeight: number
    busy: boolean
    onSkip: () => void
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
            await controller.acceptStepFacts(binding, step.stepId, { orientation: { partId, description } })
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
        await controller.acceptStepFacts(binding, step.stepId, { visibleChecks })
    }
    return (
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.flex}>
            <ProgressBar label={`Question ${position} of ${total}`} value={position - 1} total={total} />
            <View style={styles.hero}>
                <StepPicture
                    reference={step.sourceRefs[0]}
                    session={session}
                    pageUris={state.pageUris}
                    height={heroHeight}
                />
            </View>
            <TextRegion>
                <PlainNotice state={state} controller={controller} />
                <Instruction>{sentence}</Instruction>
                {question.reason === null ? null : <Caption>{`The manual says: ${question.reason}`}</Caption>}
                {question.kind === 'orientation' && parts.length > 1 ? (
                    <SegmentedControl label="Which part" options={parts} value={partId ?? ''} onChange={setPartId} />
                ) : null}
                {question.kind === 'orientation' && parts.length === 1 ? (
                    <Caption>{`Part: ${parts[0]!.label}`}</Caption>
                ) : null}
                <TextField
                    label={
                        question.kind === 'orientation' ? 'What the picture shows' : 'What you should see, one per line'
                    }
                    value={text}
                    onChangeText={setText}
                    multiline={question.kind === 'checks'}
                    placeholder={
                        question.kind === 'orientation' ? 'e.g. the groove faces inward' : 'One thing per line'
                    }
                    error={error}
                    editable={!busy}
                />
            </TextRegion>
            <FixedBottomBar
                primary={{
                    label: 'Save',
                    testID: 'quick-check-save',
                    disabled: busy || (question.kind === 'orientation' && parts.length === 0),
                    onPress: (): void => {
                        void save()
                    },
                }}
                secondary={{ label: 'Skip for now', testID: 'quick-check-skip', onPress: onSkip, disabled: busy }}
            />
        </KeyboardAvoidingView>
    )
}

function QuickCheckMore({
    visible,
    onClose,
    session,
    state,
    nav,
    issues,
}: {
    visible: boolean
    onClose: () => void
    session: ManualSession
    state: WorkflowScreenProps['state']
    nav: ScreenNav
    issues: readonly string[]
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
            title={enlarged === undefined ? 'What we read' : `Page ${(openPage ?? 0) + 1}`}
            onClose={close}
            detents={['tall', 'full']}
        >
            {enlarged !== undefined ? (
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
        <Pressable
            testID="page-strip-item"
            accessibilityRole="button"
            accessibilityLabel={`Manual page ${number}`}
            accessibilityHint="Opens the page full width"
            {...focus.focusHandlers}
            onPress={onOpen}
            style={[styles.stripItem, focusRingStyle(focus.focused, colors)]}
        >
            <PageImage uri={uri} label={`Manual page ${number}`} aspectRatio={aspectRatio} />
        </Pressable>
    )
}

const styles = StyleSheet.create({
    flex: { flex: 1 },
    hero: { paddingHorizontal: space.md, paddingTop: space.sm },
    strip: { flexDirection: 'row', flexWrap: 'wrap', gap: space.xs },
    stripItem: { width: 96, minHeight: touchTarget },
})
