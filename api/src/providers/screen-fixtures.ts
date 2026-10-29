import { SCREEN_LIMITS, wordCount } from '@truebuild/contracts'

import type { ScreenFixtureGenerator, ScreenFixtureRequest } from '../server/screens/service'
import {
    CAMERA_CUES,
    CAMERA_PILLS,
    EMPTY_LIBRARY_TEXT,
    FACT_CANCEL_LABELS,
    FACT_EDITOR_LABELS,
    FACT_PROMPTS,
    FACT_SAVE_LABELS,
    QUESTION_PROMPTS,
    QUESTION_SUBMIT_LABELS,
    SOURCE_LABELS,
    TIP_COPY,
} from '../server/screens/ui-copy'

/**
 * Synthetic screen compositions for the isolated fixture runtime (`PROVIDER_MODE=fixture`) and tests. This is NOT a
 * model and not a fallback for one: it is wired only by the explicit fixture runtime (or an injected test option), its
 * documents are labeled `synthetic-fixture`, and they claim no model, effort, timing or usage. The layouts are the
 * Muse composition proposals (one per screen kind, and two different guide shapes for two different manuals); the
 * words are only ever the exact facts the server supplies for that screen, so every composition takes the same
 * validation, grounding, repair and fallback path as a real model proposal.
 *
 * Deterministic scenarios (documented in api-interface.md):
 * - the step after the first of any manual takes `STEP_DELAY_MS` per step, so a precompute shows partial progress;
 * - the question screen of the `treadmill-monitor-arm` manual is invalid on both attempts (forced invalid, then the
 *   per-screen fallback).
 */
export const STEP_DELAY_MS = 600
export const INVALID_QUESTIONS_MANUAL = 'treadmill-monitor-arm'

type Block = Record<string, unknown>

interface Fact {
    id: string
    kind: string
    text: string
    sources: number[]
    safety?: boolean
}
interface ManualFactView {
    id: string
    kind: string
    basis: string
    text: string
}
interface Ui {
    library?: { entries: { manualId: string }[]; soleManualId: string | null } | null
    pages?: { items: unknown[] } | null
    review?: { currentQuestion: { kind: 'orientation' | 'checks'; reason: string | null } | null } | null
    capture?: { captureId: string } | null
    sections?: string[] | null
}
interface View {
    manual: { title: string; steps: number } | null
    screen: {
        captureId: string | null
        step: {
            order: number
            of: number
            title: string
            parts: { partId: string; name: string; quantity: number | null }[]
        } | null
        sources: { index: number; pageId: string; region: unknown }[]
        facts: Fact[]
        manualFacts: ManualFactView[]
        figures: { pageIds: string[]; partIds: string[] }
        result: { regionParts?: { next: string | null; target: string | null; observed?: boolean } } | null
        ui: Ui | null
    }
}

const intent = (name: string, target: string): { intent: string; target: string } => ({ intent: name, target })
const label = (
    text: string,
    to: { intent: string; target: string },
    type: 'PrimaryAction' | 'SecondaryAction',
    icon: string | null,
): Block => ({
    type,
    label: text,
    icon,
    intent: to,
})
const fits = (
    text: string,
    words = SCREEN_LIMITS.instructionWords,
    characters = SCREEN_LIMITS.instructionChars,
): boolean => wordCount(text) <= words && Array.from(text).length <= characters

function readView(request: ScreenFixtureRequest): View {
    const stable = request.view.stable as { manual: View['manual'] }
    const dynamic = request.view.dynamic as { screen: View['screen'] }
    return { manual: stable.manual, screen: dynamic.screen }
}

const instruction = (
    text: string,
    emphasis: 'strong' | 'normal' | 'quiet' = 'normal',
    citations: number[] = [],
): Block => ({
    type: 'Instruction',
    text,
    emphasis,
    citations,
})
const tip = (target: keyof typeof TIP_COPY): Block => ({ type: 'Tip', targetId: target, ...TIP_COPY[target] })

function header(
    request: ScreenFixtureRequest,
    subtitle: string | null,
    trailing: { intent: string; target: string } | null,
): Block {
    return { type: 'ScreenHeader', title: request.copy.titles[0] ?? 'Home', subtitle, trailing }
}
const bar = (primary: Block, secondary: Block | null = null): Block => ({
    primary,
    secondary,
})
const primary = (text: string, to: { intent: string; target: string }, icon: string | null = null): Block =>
    label(text, to, 'PrimaryAction', icon)
const secondary = (text: string, to: { intent: string; target: string }, icon: string | null = null): Block =>
    label(text, to, 'SecondaryAction', icon)

const factsOf = (view: View, ...kinds: string[]): Fact[] =>
    view.screen.facts.filter((fact) => kinds.includes(fact.kind) && !fact.id.includes('#'))

/** The step's manual facts named by id: safety first, then the given kinds, then manual order. The server writes the words. */
function directions(view: View, lead: string[] = [], emphasis: 'strong' | 'normal' | 'quiet' = 'normal'): Block[] {
    const rank = (kind: string): number => (kind === 'safety' ? 0 : lead.includes(kind) ? 1 : 2)
    const ids = view.screen.manualFacts
        .map((fact, index) => ({ fact, index }))
        .sort((a, b) => rank(a.fact.kind) - rank(b.fact.kind) || a.index - b.index)
        .map((entry) => entry.fact.id)
    return ids.length === 0 ? [] : [{ type: 'ManualDirections', factIds: ids, emphasis }]
}

/** The first few supplied sources as a collapsed look at the manual pages. */
function sourceDetails(view: View, open = false): Block[] {
    const sources = view.screen.sources.slice(0, 3).map((source) => source.index)
    return sources.length === 0
        ? []
        : [{ type: 'SourceDetails', label: SOURCE_LABELS[0], sources, fit: 'contain', initiallyOpen: open }]
}

function parts(view: View): Block[] {
    const items = (view.screen.step?.parts ?? [])
        .slice(0, SCREEN_LIMITS.listItems)
        .filter((part) => part.name.length <= 60)
    return items.length === 0
        ? []
        : [
              {
                  type: 'PartList',
                  showQuantities: true,
                  items: items.map((part) => ({ partId: part.partId, label: part.name, quantity: part.quantity })),
              },
          ]
}

/** A figure naming an existing manual source by index; the box (if the source has one) is the manual's, not ours. */
function figure(view: View, caption: Fact | undefined, fit: 'cover' | 'contain'): Block[] {
    const source = view.screen.sources.find((candidate) => candidate.region !== null) ?? view.screen.sources[0]
    if (!source) return []
    return [
        {
            type: 'HeroFigure',
            source: 'page',
            refId: source.pageId,
            caption:
                caption !== undefined && Array.from(caption.text).length <= SCREEN_LIMITS.caption ? caption.text : null,
            fit,
            sourceRefIndex: source.region === null ? null : source.index,
        },
    ]
}

const camera = (tipTarget: 'camera-shutter' | 'guide-hero-frame' | null, arm: boolean): Block => ({
    type: 'CameraGuidance',
    cue: CAMERA_CUES[arm ? 1 : 0],
    pill: arm ? CAMERA_PILLS[1] : null,
    tipTarget,
})

function compose(request: ScreenFixtureRequest): unknown {
    const view = readView(request)
    const { kind } = request
    // Two different manuals get two different compositions over the same catalog: order, density, emphasis, blocks.
    const arm = request.manualId === INVALID_QUESTIONS_MANUAL
    const ui = view.screen.ui
    const title = view.screen.step?.title ?? null
    const titleFact = factsOf(view, 'title')[0]
    const manualTitle = view.manual?.title ?? null
    const [copy = ''] = request.copy.instructions
    const orientation = factsOf(view, 'orientation')[0]
    const closing = (fallback: Block): Block => bar(fallback)

    switch (kind) {
        case 'home': {
            const library = ui?.library
                ? [
                      {
                          type: 'ManualLibrary',
                          entries:
                              arm && ui.library.entries.length > 1
                                  ? { manualIds: ui.library.entries.slice(0, 2).map((entry) => entry.manualId) }
                                  : 'recent',
                          layout: arm ? 'rows' : 'cards',
                          showProgress: !arm,
                          emptyText: arm ? EMPTY_LIBRARY_TEXT[0] : null,
                      },
                  ]
                : []
            const lead = instruction(copy, 'strong')
            return {
                header: header(request, manualTitle, intent('open-details', 'about-check')),
                body: [
                    ...(arm ? [lead, ...library] : [...library, lead]),
                    { type: 'Group', layout: 'stack', children: [tip('home-add')] },
                ],
                bar: view.manual
                    ? bar(
                          primary('Continue building', intent('navigate', 'guide'), 'arrowRight'),
                          secondary('Add a manual', intent('navigate', 'add'), 'plus'),
                      )
                    : closing(primary('Add a manual', intent('navigate', 'add'), 'plus')),
            }
        }
        case 'add':
            return {
                header: header(request, null, null),
                body: [
                    instruction(copy, 'strong'),
                    ...(ui?.pages && ui.pages.items.length > 0
                        ? [{ type: 'PageGallery', pages: 'session', layout: 'grid', showNumbers: true, action: null }]
                        : []),
                    {
                        type: 'ChoiceList',
                        prompt: null,
                        options: [
                            { label: 'Take a photo', intent: intent('capture', 'take-photo') },
                            { label: 'Choose photos', intent: intent('capture', 'choose-pages') },
                        ],
                    },
                    tip('choose-pages'),
                ],
                bar: bar(
                    primary('Take photo', intent('capture', 'take-photo'), 'camera'),
                    secondary('Choose photos', intent('capture', 'choose-pages'), 'image'),
                ),
            }
        case 'pages':
            return {
                header: header(request, manualTitle, intent('capture', 'add-page')),
                body: [
                    instruction(copy, 'strong'),
                    ...(ui?.pages
                        ? [
                              {
                                  type: 'PageGallery',
                                  pages: 'session',
                                  layout: arm ? 'grid' : 'list',
                                  showNumbers: !arm,
                                  action: intent('capture', 'add-page'),
                              },
                          ]
                        : []),
                    { type: 'Group', layout: 'stack', children: [tip('add-page')] },
                ],
                bar: bar(
                    primary('Read manual', intent('confirm', 'reading'), 'arrowRight'),
                    secondary('Add page', intent('capture', 'add-page'), 'plus'),
                ),
            }
        case 'reading':
            return {
                header: header(request, manualTitle, intent('retry', 'reading')),
                body: [instruction(copy, 'strong'), tip('read-manual')],
                bar: closing(primary('Back to pages', intent('navigate', 'pages'), 'chevronLeft')),
            }
        case 'quick-check': {
            const question = ui?.review?.currentQuestion ?? null
            const read = factsOf(view, 'title')[0]
            const reason =
                question?.reason !== null && question?.reason !== undefined && Array.from(question.reason).length <= 160
                    ? question.reason
                    : null
            return {
                header: header(request, manualTitle, intent('open-details', 'sources')),
                body: [
                    instruction(copy, 'strong'),
                    ...(question
                        ? [
                              {
                                  type: 'FactPrompt',
                                  questionRef: 'current',
                                  prompt: FACT_PROMPTS[question.kind][arm ? 1 : 0],
                                  detail: reason,
                                  citations: [],
                              },
                              {
                                  type: 'FactEditor',
                                  questionRef: 'current',
                                  kind: question.kind,
                                  label: FACT_EDITOR_LABELS[question.kind][arm ? 1 : 0],
                                  saveLabel: FACT_SAVE_LABELS[0],
                                  cancelLabel: FACT_CANCEL_LABELS[0],
                              },
                              tip('quick-check-fix'),
                          ]
                        : read === undefined || !(Array.from(read.text).length <= SCREEN_LIMITS.text)
                          ? []
                          : [
                                {
                                    type: 'ConfirmFact',
                                    text: read.text,
                                    confirm: intent('confirm', 'facts'),
                                    dismiss: intent('retry', 'reading'),
                                    citations: read.sources.slice(0, 3),
                                },
                            ]),
                    tip('quick-check-start'),
                ],
                bar: bar(
                    primary('Looks right', intent('confirm', 'facts'), 'check'),
                    secondary('Read again', intent('retry', 'reading'), 'refresh'),
                ),
            }
        }
        case 'guide': {
            const order = view.screen.step?.order ?? 1
            const lead =
                titleFact !== undefined && fits(titleFact.text)
                    ? [instruction(titleFact.text, 'strong', titleFact.sources.slice(0, 3))]
                    : []
            const progress = view.screen.step
                ? [{ type: 'StepProgress', current: order, total: view.screen.step.of, label: null }]
                : []
            // The first manual leads with progress and the diagram; the others lead with the words, the parts and the
            // complete directions, and keep the diagram last.
            return order % 2 === 1 && !arm
                ? {
                      header: header(request, title, intent('ask', 'about-step')),
                      body: [
                          ...progress,
                          ...figure(view, orientation, 'contain'),
                          ...lead,
                          ...parts(view),
                          ...directions(view, [], 'strong'),
                          camera('guide-hero-frame', false),
                          tip('guide-hero'),
                      ],
                      bar: bar(
                          primary('Take photo', intent('capture', 'take-photo'), 'camera'),
                          secondary('Ask about this step', intent('ask', 'about-step'), 'help'),
                      ),
                  }
                : {
                      header: header(request, title, intent('capture', 'take-photo')),
                      body: [
                          ...lead,
                          ...parts(view),
                          ...directions(view, ['correction', 'check']),
                          ...progress,
                          ...sourceDetails(view),
                          ...figure(view, orientation, 'cover'),
                          camera('camera-shutter', true),
                      ],
                      bar: bar(
                          primary('Check this step', intent('check', 'current-step'), 'check'),
                          secondary('Take photo', intent('capture', 'take-photo'), 'camera'),
                      ),
                  }
        }
        case 'result': {
            const verdict = view.screen.facts.find((fact) => fact.id === 'verdict')
            const regions = view.screen.result?.regionParts
            const decision = request.decision ?? 'cannot_verify'
            const photo =
                view.screen.captureId === null
                    ? []
                    : [
                          {
                              type: 'PhotoWithRegions',
                              captureId: view.screen.captureId,
                              showObserved: true,
                              regions: [
                                  ...(regions?.next ? [{ partId: regions.next, role: 'next' }] : []),
                                  ...(regions?.target ? [{ partId: regions.target, role: 'target' }] : []),
                              ],
                          },
                      ]
            const banner = {
                type: 'ResultBanner',
                verdict: decision,
                text: (verdict?.text ?? '').slice(0, SCREEN_LIMITS.text) || 'See the details.',
                citations: [],
            }
            return {
                header: header(request, title, intent('open-details', 'result')),
                body: arm
                    ? [banner, ...sourceDetails(view), ...photo, ...directions(view)]
                    : [
                          banner,
                          ...photo,
                          ...directions(view, ['safety']),
                          {
                              type: 'ActionLink',
                              label: 'See the manual',
                              icon: 'info',
                              intent: intent('open-details', 'sources'),
                              emphasis: 'quiet',
                          },
                      ],
                bar:
                    decision === 'pass'
                        ? bar(
                              primary('Next step', intent('confirm', 'step'), 'arrowRight'),
                              secondary('Ask about this step', intent('ask', 'about-step'), 'help'),
                          )
                        : bar(
                              primary('Retake photo', intent('capture', 'retake'), 'camera'),
                              secondary('Ask about this step', intent('ask', 'about-step'), 'help'),
                          ),
            }
        }
        case 'questions':
            if (request.manualId === INVALID_QUESTIONS_MANUAL) return { header: { type: 'ScreenHeader', title: '' } }
            return {
                header: header(request, title, intent('show-tips', 'screen')),
                body: [
                    instruction(copy, 'strong'),
                    ...(ui?.capture
                        ? [
                              {
                                  type: 'QuestionComposer',
                                  captureRef: 'current',
                                  prompt: QUESTION_PROMPTS[0],
                                  partScope: (view.screen.step?.parts.length ?? 0) > 0 ? 'step-parts' : 'none',
                                  submitLabel: QUESTION_SUBMIT_LABELS[0],
                              },
                          ]
                        : [
                              {
                                  type: 'ChoiceList',
                                  prompt: null,
                                  options: [
                                      { label: 'Ask about this step', intent: intent('ask', 'about-step') },
                                      { label: 'Ask about this part', intent: intent('ask', 'about-part') },
                                      { label: 'Take a photo', intent: intent('capture', 'take-photo') },
                                  ],
                              },
                          ]),
                    camera('camera-shutter', false),
                ],
                bar: bar(
                    primary('Ask', intent('ask', 'about-step'), 'help'),
                    secondary('Take photo', intent('capture', 'take-photo'), 'camera'),
                ),
            }
        case 'answer': {
            const answer = view.screen.facts.find((fact) => fact.id === 'answer')
            const missing = view.screen.facts.find((fact) => fact.kind === 'missing')
            return {
                header: header(request, title, intent('open-details', 'sources')),
                body: [
                    {
                        type: 'AnswerCard',
                        text: (answer?.text ?? '').slice(0, SCREEN_LIMITS.answer) || 'See the diagram.',
                        caveat: missing !== undefined && Array.from(missing.text).length <= 120 ? missing.text : null,
                        citations: [],
                    },
                    ...sourceDetails(view, true),
                    ...figure(view, orientation, 'contain'),
                    ...directions(view, ['safety']),
                ],
                bar: bar(
                    primary('Back to step', intent('navigate', 'guide'), 'chevronLeft'),
                    secondary('Ask another', intent('ask', 'about-step'), 'help'),
                ),
            }
        }
        case 'more': {
            const sections = ui?.sections ?? []
            return {
                header: header(request, null, intent('open-details', 'about-check')),
                body: [
                    instruction(copy, 'strong'),
                    ...(sections.includes('about-this-check')
                        ? [
                              {
                                  type: 'ActionLink',
                                  label: 'About this check',
                                  icon: 'info',
                                  intent: intent('open-details', 'about-check'),
                                  emphasis: 'normal',
                              },
                          ]
                        : []),
                    {
                        type: 'ActionLink',
                        label: 'See the manual',
                        icon: 'image',
                        intent: intent('open-details', 'sources'),
                        emphasis: 'normal',
                    },
                    ...(sections.includes('tips')
                        ? [
                              {
                                  type: 'ActionLink',
                                  label: 'Show tips',
                                  icon: 'help',
                                  intent: intent('show-tips', 'screen'),
                                  emphasis: 'quiet',
                              },
                          ]
                        : []),
                ],
                bar: closing(primary('Home', intent('navigate', 'home'), 'chevronLeft')),
            }
        }
        case 'completion':
            return {
                header: header(request, manualTitle, null),
                body: [instruction(copy, 'strong'), tip('keep-building')],
                bar: closing(primary('Home', intent('navigate', 'home'), 'check')),
            }
        case 'error':
            return {
                header: header(request, null, null),
                body: [instruction(copy, 'strong')],
                bar: bar(
                    primary('Try again', intent('retry', 'last-action'), 'refresh'),
                    secondary('Home', intent('navigate', 'home'), 'chevronLeft'),
                ),
            }
        case 'recovery': {
            const fix = factsOf(view, 'correction')[0]
            return {
                header: header(request, title, intent('ask', 'about-step')),
                body: [
                    ...(fix !== undefined && fits(fix.text)
                        ? [instruction(fix.text, 'strong', fix.sources.slice(0, 3))]
                        : [instruction(copy, 'strong')]),
                    ...figure(view, orientation, 'contain'),
                    ...directions(view, ['correction']),
                    camera('camera-shutter', arm),
                ],
                bar: bar(
                    primary('Retake photo', intent('capture', 'retake'), 'camera'),
                    secondary('Ask about this step', intent('ask', 'about-step'), 'help'),
                ),
            }
        }
    }
}

const sleep = (milliseconds: number, signal: AbortSignal): Promise<void> =>
    new Promise((resolve, reject) => {
        if (milliseconds <= 0) return resolve()
        const timer = setTimeout(() => {
            signal.removeEventListener('abort', onAbort)
            resolve()
        }, milliseconds)
        const onAbort = (): void => {
            clearTimeout(timer)
            reject(signal.reason)
        }
        signal.addEventListener('abort', onAbort, { once: true })
        timer.unref?.()
    })

export interface ScreenFixtureOptions {
    /** Per-step delay for steps after the first; shows partial progress. Tests may set 0. */
    stepDelayMs?: number
}

export function createScreenFixtureGenerator(options: ScreenFixtureOptions = {}): ScreenFixtureGenerator {
    const stepDelay = options.stepDelayMs ?? STEP_DELAY_MS
    return async (request, signal): Promise<unknown> => {
        const view = readView(request)
        const order = view.screen.step?.order ?? 1
        if (request.kind === 'guide') await sleep(Math.max(0, order - 1) * stepDelay, signal)
        return compose(request)
    }
}
