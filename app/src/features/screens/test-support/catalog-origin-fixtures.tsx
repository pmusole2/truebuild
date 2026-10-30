import { Image } from 'react-native'
import {
    screenDocumentV2Schema,
    verifyDocumentAgainstInputsV2,
    type ScreenContextInputsV2,
    type ScreenKindV2,
    type ScreenNodeV2,
} from '@truebuild/contracts'
import { documentInputs } from '../../capture/document-inputs'
import { defaultNav } from '../../capture/screen-nav'
import { editableQuestions } from '../../capture/quick-check-model'
import { resolveIntent } from '../intents'
import type { QuickProgress } from '../quick-progress'
import { CompareColumns } from '../../documents/compare-columns'
import type { FrameBindings } from '../../documents/types'
import { sha256Hex } from '../../documents/sha256'
import { documentForV2 } from './fixture-server'
import { entry, runtime, source } from './route-harness'

const noop = (): void => undefined
/** Purposeful catalog substitutions: actual step status/checklist/navigation, not hidden nodes or metric filler. */
function catalogNodes(inputs: ScreenContextInputsV2): readonly ScreenNodeV2[] {
    if (inputs.kind !== 'guide') return []
    return [
        {
            type: 'Row',
            gap: 'sm',
            align: 'center',
            justify: 'start',
            wrap: true,
            children: [
                { type: 'Icon', name: 'info', tone: 'neutral', size: 'sm' },
                { type: 'Badge', label: { kind: 'bound', key: 'step-position' }, tone: 'neutral' },
            ],
        },
        { type: 'Checklist', items: [{ label: { kind: 'bound', key: 'step-title' }, state: 'todo' }] },
        { type: 'Meter', binding: 'build', label: null, tone: 'neutral' },
        { type: 'Stepper', binding: 'steps', label: null },
        { type: 'ManualPage', sources: [0], fit: 'contain', label: null, initiallyOpen: true },
        { type: 'Divider', inset: true },
        { type: 'Spacer', size: 'sm' },
    ]
}
export async function catalogOriginFixture(kind: ScreenKindV2): Promise<{
    readonly inputs: ScreenContextInputsV2
    readonly document: ReturnType<typeof documentForV2>
    readonly documents: readonly ReturnType<typeof documentForV2>[]
    readonly bindings: FrameBindings
    readonly dispose: () => void
}> {
    const seed = entry(
        'catalog-manual',
        kind === 'add' || kind === 'pages' || kind === 'reading'
            ? 'unparsed'
            : kind === 'quick-check'
              ? 'unreviewed'
              : 'reviewed',
        2,
    )
    if (kind === 'add') seed.session.pages = []
    if (kind === 'quick-check') {
        seed.session.reviewedSteps[0]!.orientation = {
            state: 'unknown',
            reason: 'The direction is unclear in the supplied page.',
        }
        if (seed.session.rawExtraction !== null)
            seed.session.rawExtraction.steps[0]!.orientation = seed.session.reviewedSteps[0]!.orientation
    }
    if (kind === 'completion') seed.completedStepIds = seed.session.reviewedSteps.map((step) => step.stepId)
    const second = entry('catalog-second', 'reviewed', 2, 'Second')
    const ports = await runtime(
        kind === 'compare' ? [seed, second] : [seed],
        kind === 'recovery' ? { failCheck: true } : {},
    )
    await ports.controller.restore()
    if (kind !== 'home' && kind !== 'compare' && kind !== 'judge' && kind !== 'error')
        await ports.controller.open(
            seed.session.manualId,
            kind === 'add' || kind === 'pages' || kind === 'reading'
                ? 'pages'
                : kind === 'quick-check'
                  ? 'overview'
                  : 'guide',
        )
    if (['result', 'questions', 'answer', 'more', 'recovery'].includes(kind)) {
        ports.controller.camera({ kind: 'check' })
        await ports.controller.shutter(async () => source)
        if (kind === 'answer' || kind === 'more') {
            ports.controller.targetChanged({ kind: 'part', partId: 'side-panel' })
            ports.controller.questionChanged('Which way?')
            await ports.controller.ask()
        }
    }
    if (kind === 'camera') ports.controller.camera({ kind: 'check' })
    const state = ports.controller.getSnapshot()
    const selected = ports.controller.current
    const questions = selected === undefined ? [] : editableQuestions(selected.session)
    const quick: QuickProgress = {
        questions,
        current: questions[0],
        position: questions.length === 0 ? 0 : 1,
        total: questions.length,
        skipped: [],
        skip: noop,
        unskip: noop,
        label: questions.length === 0 ? undefined : `Question 1 of ${questions.length}`,
    }
    const inputs = documentInputs(kind, { state, entry: selected }, quick, kind === 'more')
    if (kind === 'camera')
        inputs.uiState = {
            ...inputs.uiState,
            camera: { mode: 'build-photo', permission: 'granted', failed: false, canAskAgain: true },
        }
    const document = screenDocumentV2Schema.parse(
        documentForV2(inputs, {
            generated: [kind],
            arrange: (proposal) => ({
                ...proposal,
                body:
                    catalogNodes(inputs).length === 0
                        ? proposal.body
                        : {
                              type: 'Stack',
                              gap: 'md',
                              align: 'stretch',
                              children: [...catalogNodes(inputs), proposal.body],
                          },
            }),
        }),
    )
    const issues = verifyDocumentAgainstInputsV2(document, inputs, sha256Hex)
    if (issues.length > 0) throw new Error(`invalid_catalog_fixture:${kind}:${issues.join(',')}`)
    const more = { open: false, mode: 'details' as const, show: noop, hide: noop }
    const nav = defaultNav(ports.controller)
    const bindings: FrameBindings = {
        resolve: (intent) =>
            resolveIntent(intent, {
                kind: kind === 'camera' || kind === 'judge' || kind === 'compare' ? 'guide' : kind,
                state,
                entry: selected,
                controller: ports.controller,
                nav,
                extras: { showMore: noop, contextualMore: kind === 'more' },
            }),
        live: {
            state,
            entry: selected,
            controller: ports.controller,
            nav,
            more,
            quick,
            pages: { open: noop, arriving: new Set() },
            closeSheet: noop,
        },
        session: selected?.session,
        pageUris: state.pageUris,
        pageImageStatus: 'ready',
        capture: state.capture,
        marks: [],
        heroMode: 'inline',
        inspect: false,
        toggles: { 'built-view': { value: false, onChange: noop } },
        language: { value: 'en', onChange: noop },
        camera:
            kind === 'camera'
                ? {
                      preview: (
                          <Image
                              nativeID="truebuild-capability-internals:CameraView"
                              source={{ uri: 'data:image/png;base64,synthetic' }}
                          />
                      ),
                      capture: noop,
                      ready: true,
                      permission: 'granted',
                  }
                : undefined,
    }
    const documents = [document]
    if (kind === 'compare') {
        const panes = await Promise.all(
            [seed, second].map(async (manual) => {
                const paneInputs: ScreenContextInputsV2 = {
                    kind: 'guide',
                    session: manual.session,
                    stepId: manual.session.reviewedSteps[0]!.stepId,
                    captureId: null,
                    result: null,
                    failure: null,
                }
                const pane = screenDocumentV2Schema.parse(documentForV2(paneInputs, { generated: ['guide'] }))
                const errors = verifyDocumentAgainstInputsV2(pane, paneInputs, sha256Hex)
                if (errors.length > 0) throw new Error(`invalid_compare_fixture:${errors.join(',')}`)
                documents.push(pane)
                return {
                    manualId: manual.session.manualId,
                    title: manual.session.title,
                    note: 'Synthetic validated guide',
                    document: pane,
                    bindings: {
                        ...bindings,
                        session: manual.session,
                        pageUris: await ports.controller.pageImages(manual.session.manualId, manual.session.revision),
                    },
                }
            }),
        )
        return {
            inputs,
            document,
            documents,
            bindings: { ...bindings, compare: <CompareColumns panes={panes} /> },
            dispose: () => ports.controller.dispose(),
        }
    }
    return { inputs, document, documents, bindings, dispose: () => ports.controller.dispose() }
}
