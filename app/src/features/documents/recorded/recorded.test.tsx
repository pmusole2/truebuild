import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import {
    BUSY_COPY_V2,
    COACH_COPY_V2,
    coachTargetsForV2,
    documentMaterialV2,
    createDemoManual,
    screenProposalV2Schema,
    verifyDocumentAgainstInputsV2,
    type ScreenContextInputsV2,
    type ScreenDocumentV2,
} from '@truebuild/contracts'
import { sha256Hex } from '../sha256'
import { barTestId } from '../../screens/bar-ids'
import { recordedDocumentForTest } from './test-support'

const read = (name: string): unknown => JSON.parse(readFileSync(join(__dirname, name), 'utf8'))

describe('synthetic Sol proposal', () => {
    it('validates as a strict v2 generated home document with complete origins', () => {
        const doc = recordedDocumentForTest('recorded-home')
        expect(doc.kind).toBe('home')
        expect(doc.metadata.source).toBe('generated')
        expect(doc.metadata.origins['header']).toBe('generated')
        expect(doc.metadata.origins['bar.primary']).toBe('generated')
        const prov = JSON.parse(readFileSync(join(__dirname, 'recorded-home.provenance.json'), 'utf8')) as {
            model: null
            effort: null
            authoring: { model: string; effort: string }
            tokens: unknown
        }
        expect(prov.model).toBeNull()
        expect(prov.authoring.model).toBe('gpt-6.1-sol')
        expect(prov.effort).toBeNull()
        expect(prov.authoring.effort).toBe('ultra')
        expect(prov.tokens).toBeNull()
    })
})

const ARTIFACTS = [
    'recorded-home',
    'recorded-home-library-single',
    'recorded-home-library-multiple',
    'recorded-add-empty',
    'recorded-pages',
    'recorded-pages-cancelled',
    'recorded-reading',
    'recorded-reading-active',
    'recorded-home-saving',
    'recorded-home-library-single-saving',
    'recorded-home-library-multiple-saving',
    'recorded-add-empty-saving',
    'recorded-pages-saving',
    'recorded-pages-cancelled-saving',
    'recorded-reading-saving',
] as const

/** Literal texts one variant shows: its header title plus every literal body node, in order. */
function variantLiteralTexts(doc: ScreenDocumentV2, name: string): string[] {
    const variant = name === 'ready' ? doc : doc.states[name as keyof typeof doc.states]
    if (variant === null || variant === undefined) return []
    const texts: string[] = variant.header.title.kind === 'literal' ? [variant.header.title.text] : []
    const walk = (node: unknown): void => {
        const item = node as { type?: string; content?: { kind?: string; text?: string }; children?: unknown[] }
        if (item.type === 'Text' && item.content?.kind === 'literal' && item.content.text !== undefined)
            texts.push(item.content.text)
        item.children?.forEach(walk)
    }
    walk(variant.body)
    return texts
}

const VARIANT_NAMES = ['ready', 'busy', 'pending', 'empty', 'error', 'recovery', 'confirming'] as const

describe('synthetic Sol state proposals (explicit raw trees)', () => {
    it.each(ARTIFACTS)('%s assembles schema-valid, verifies against its inputs, all origins generated', (name) => {
        const doc = recordedDocumentForTest(name)
        const inputs = read(`${name}.inputs.json`) as ScreenContextInputsV2
        expect(verifyDocumentAgainstInputsV2(doc, inputs, sha256Hex)).toEqual([])
        expect(doc.metadata.evidence).toBe('synthetic-fixture')
        expect(doc.metadata.model).toBeNull()
        expect(doc.metadata.effort).toBeNull()
        const origins = Object.values(doc.metadata.origins)
        expect(origins.length).toBeGreaterThan(10)
        expect(origins.every((origin) => origin === 'generated')).toBe(true)
        const rawProposal = read(`${name}.proposal.json`)
        const proposal = screenProposalV2Schema.parse(rawProposal)
        expect(proposal).toEqual(rawProposal)
        expect({
            header: doc.header,
            body: doc.body,
            bar: doc.bar,
            overlays: doc.overlays,
            states: doc.states,
        }).toEqual(proposal)
        const provenance = read(`${name}.provenance.json`) as Record<string, unknown>
        expect(provenance.evidence).toBe('synthetic-fixture')
        expect(provenance.model).toBeNull()
        expect(provenance.effort).toBeNull()
        expect(provenance.authoring).toEqual({
            model: 'gpt-6.1-sol',
            effort: 'ultra',
            recordedAt: provenance.recordedAt,
            fixtureId: `${name}-sol-v1`,
        })
        expect(provenance.inputPromptSha256).toBe(sha256Hex(provenance.inputPrompt as string))
        expect(provenance.rawJsonSha256).toBe(sha256Hex(readFileSync(join(__dirname, `${name}.proposal.json`), 'utf8')))
        expect(doc.metadata.generatedAt).toBe(provenance.recordedAt)
        expect(doc.metadata.authoring).toEqual(provenance.authoring)
        expect(doc.metadata.fixtureId).toBeUndefined()
        expect(provenance.tokens).toBeNull()
        expect(provenance.timingMs).toBeNull()
        expect(typeof provenance.inputPromptSha256).toBe('string')
        expect(typeof provenance.rawJsonSha256).toBe('string')
    })

    it('cancelled-reading pages states the bound notice once, with PageList, privacy and Read manual', () => {
        const doc = recordedDocumentForTest('recorded-pages-cancelled')
        const texts: string[] = []
        const walk = (node: unknown): void => {
            const item = node as { type?: string; content?: { kind?: string; key?: string }; children?: unknown[] }
            if (item.type === 'Text' && item.content?.kind === 'bound') texts.push(item.content.key ?? '')
            if (item.type === 'PageList') texts.push('PageList')
            item.children?.forEach(walk)
        }
        walk(doc.body)
        expect(texts.filter((key) => key === 'operation-notice')).toHaveLength(1)
        expect(texts).toContain('PageList')
        expect(texts.some((key) => key.startsWith('privacy-'))).toBe(true)
        expect(doc.bar.primary.intent).toEqual({ intent: 'confirm', target: 'reading' })
        expect(doc.bar.primary.label).toBe('Read manual')
    })

    it.each(ARTIFACTS)('%s states no visible literal twice in any variant', (name) => {
        const doc = recordedDocumentForTest(name)
        for (const variantName of VARIANT_NAMES) {
            const texts = variantLiteralTexts(doc, variantName)
            const duplicates = texts.filter((text, at) => texts.indexOf(text) !== at)
            expect({ variant: `${name}/${variantName}`, duplicates }).toEqual({
                variant: `${name}/${variantName}`,
                duplicates: [],
            })
        }
    })

    it('home library ordering is an authored choice: single leads, multiple lists first', () => {
        const firstType = (name: string): string => {
            const doc = recordedDocumentForTest(name)
            const stack = (doc.body as { children: { children: { type: string }[] }[] }).children[0]
            return stack?.children[0]?.type ?? ''
        }
        expect(firstType('recorded-home-library-single')).toBe('Text')
        expect(firstType('recorded-home-library-multiple')).toBe('ManualList')
    })

    it('publication reads the explicit trees without a fallback layout producer', () => {
        const source = readFileSync(join(__dirname, 'generate.ts'), 'utf8')
        expect(source).not.toMatch(/buildFallback|from ['"].*fallback/u)
        expect(source).toContain('.proposal.json')
        expect(source).toContain('assembleDocumentV2')
    })

    it.each(ARTIFACTS)('%s uses the calm generic wait in pending', (name) => {
        const doc = recordedDocumentForTest(name)
        expect(doc.states.pending?.header.title).toEqual({ kind: 'literal', text: 'Working on it' })
        const texts = variantLiteralTexts(doc, 'pending')
        expect(texts).toContain('One moment, please.')
        expect(texts).not.toContain('Getting this ready')
        expect(texts).not.toContain('Your screen will appear here.')
    })

    it('reading-active binds the actual in-flight reading inputs with exact busy copy', () => {
        const doc = recordedDocumentForTest('recorded-reading-active')
        const actual: ScreenContextInputsV2 = {
            kind: 'reading',
            session: createDemoManual(),
            stepId: null,
            captureId: null,
            result: null,
            failure: null,
            uiState: {
                reading: { cancellation: 'confirm-before-stop' },
                busy: { activity: 'reading' },
                failure: null,
            },
        }
        expect(verifyDocumentAgainstInputsV2(doc, actual, sha256Hex)).toEqual([])
        expect(doc.states.busy?.header.title).toEqual({
            kind: 'literal',
            text: BUSY_COPY_V2.reading.heading,
        })
        const busyBody = variantLiteralTexts(doc, 'busy').slice(1)
        expect(busyBody).toContain(BUSY_COPY_V2.reading.detail)
        expect(busyBody).not.toContain(BUSY_COPY_V2.reading.heading)
        const confirming = doc.states.confirming
        expect(confirming).not.toBeNull()
        const intents = [confirming!.bar.primary.intent, confirming!.bar.secondary?.intent]
        expect(intents).toContainEqual({ intent: 'navigate', target: 'reading' })
        expect(intents).toContainEqual({ intent: 'navigate', target: 'pages' })
    })

    it('reading carries a confirming variant with only Keep and Stop', () => {
        const doc = recordedDocumentForTest('recorded-reading')
        const confirming = doc.states.confirming
        expect(confirming).not.toBeNull()
        const intents = [confirming!.bar.primary.intent, confirming!.bar.secondary?.intent]
        expect(intents).toContainEqual({ intent: 'navigate', target: 'reading' })
        expect(intents).toContainEqual({ intent: 'navigate', target: 'pages' })
    })
})

describe('raw ready proposals retain first-open tours for their actual controls', () => {
    const cases = [
        ['recorded-home', ['home-add', 'header-more']],
        ['recorded-home-library-single', ['keep-building', 'home-add', 'header-more']],
        ['recorded-home-library-multiple', ['home-add', 'header-more']],
        ['recorded-add-empty', ['take-page-photo', 'choose-pages']],
        ['recorded-pages', ['read-manual', 'add-page']],
        ['recorded-pages-cancelled', ['read-manual', 'add-page']],
    ] as const

    it.each(cases)('%s authors exact closed coach copy in primary-first order', (name, targets) => {
        const raw = screenProposalV2Schema.parse(read(`${name}.proposal.json`))
        const inputs = read(`${name}.inputs.json`) as ScreenContextInputsV2
        expect(raw.overlays.map((overlay) => overlay.anchor)).toEqual(targets)
        const allowed = coachTargetsForV2(documentMaterialV2(inputs))
        const available = new Set<string>()
        if (inputs.kind === 'home' || inputs.kind === 'add' || inputs.kind === 'pages') {
            const primary = barTestId(inputs.kind, 'primary', raw.bar.primary.intent)
            const secondary =
                raw.bar.secondary === null ? undefined : barTestId(inputs.kind, 'secondary', raw.bar.secondary.intent)
            if (primary !== undefined) available.add(primary)
            if (secondary !== undefined) available.add(secondary)
        }
        if (raw.header.actions.some((action) => action.intent.target === 'more')) available.add('header-more')
        for (const [index, target] of targets.entries()) {
            expect(allowed).toContain(target)
            expect(available.has(target)).toBe(true)
            expect(raw.overlays[index]).toEqual({
                kind: 'tooltip',
                anchor: target,
                content: {
                    type: 'CoachMark',
                    targetId: target,
                    heading: COACH_COPY_V2[target]!.heading,
                    body: COACH_COPY_V2[target]!.body,
                    placement: 'auto',
                },
            })
        }
    })

    it.each(ARTIFACTS)('%s keeps every non-ready variant free of CoachMark content', (name) => {
        const raw = screenProposalV2Schema.parse(read(`${name}.proposal.json`))
        for (const state of Object.values(raw.states)) {
            if (state === null) continue
            expect(state.overlays).toEqual([])
            const walk = (node: typeof state.body): void => {
                expect(node.type).not.toBe('CoachMark')
                if ('children' in node) node.children.forEach(walk)
            }
            walk(state.body)
        }
        if (name === 'recorded-reading' || name === 'recorded-reading-active') expect(raw.overlays).toEqual([])
    })
})

const SAVING_BASES = [
    'recorded-home',
    'recorded-home-library-single',
    'recorded-home-library-multiple',
    'recorded-add-empty',
    'recorded-pages',
    'recorded-pages-cancelled',
    'recorded-reading',
] as const

describe('raw saving-context siblings', () => {
    it.each(SAVING_BASES)('%s-saving names the actual activity and preserves all other authored choices', (base) => {
        const name = `${base}-saving`
        expect(existsSync(join(__dirname, `${name}.proposal.json`))).toBe(true)
        const raw = screenProposalV2Schema.parse(read(`${name}.proposal.json`))
        const original = screenProposalV2Schema.parse(read(`${base}.proposal.json`))
        const inputs = read(`${name}.inputs.json`) as ScreenContextInputsV2
        const originalInputs = read(`${base}.inputs.json`) as ScreenContextInputsV2
        expect(inputs).toEqual({
            ...originalInputs,
            uiState: { ...originalInputs.uiState, busy: { activity: 'saving' } },
        })
        const doc = recordedDocumentForTest(name)
        expect(verifyDocumentAgainstInputsV2(doc, inputs, sha256Hex)).toEqual([])
        expect(raw.states.busy?.header.title).toEqual({ kind: 'literal', text: BUSY_COPY_V2.saving.heading })
        expect(variantLiteralTexts(doc, 'busy')).toEqual([
            BUSY_COPY_V2.saving.heading,
            'One moment, please.',
            ...(base === 'recorded-reading'
                ? ['What we look for', 'Steps', 'Parts', 'Safety notes', 'Unclear details']
                : []),
        ])
        expect(raw.states.busy?.bar).toEqual(original.states.busy?.bar)
        expect(raw.states.busy?.overlays).toEqual([])
        expect({ header: raw.header, body: raw.body, bar: raw.bar, overlays: raw.overlays }).toEqual({
            header: original.header,
            body: original.body,
            bar: original.bar,
            overlays: original.overlays,
        })
        expect({ ...raw.states, busy: null }).toEqual({ ...original.states, busy: null })
        expect(doc.metadata.evidence).toBe('synthetic-fixture')
        expect(doc.metadata.origins['states.busy.header']).toBe('generated')
    })
})

describe('minimal runtime recording metadata', () => {
    it.each(ARTIFACTS)('%s ships only the safe provenance projection with honest author identity', (name) => {
        expect(existsSync(join(__dirname, `${name}.runtime.json`))).toBe(true)
        const full = read(`${name}.provenance.json`) as Record<string, unknown>
        const runtime = read(`${name}.runtime.json`)
        expect(runtime).toEqual({
            evidence: full.evidence,
            model: full.model,
            effort: full.effort,
            authoring: full.authoring,
            recordedAt: full.recordedAt,
            promptVersion: full.promptVersion,
            repaired: full.repaired,
        })
        expect(JSON.stringify(runtime)).not.toMatch(/inputPrompt|taskReference|binding|\/Users\/|\/home\//u)
    })

    it('the runtime imports the minimal metadata instead of full authoring sidecars', () => {
        const source = readFileSync(join(__dirname, '../../document-runtime/recorded-runtime.ts'), 'utf8')
        expect(source).not.toContain('.provenance.json')
        const imports = [...source.matchAll(/from ['"]([^'"]+\.runtime\.json)['"]/gu)].map((match) => match[1])
        expect(imports).toHaveLength(ARTIFACTS.length)
        for (const name of ARTIFACTS) expect(imports).toContain(`../documents/recorded/${name}.runtime.json`)
    })
})

it('ships the fifteen raw families without derived document build artifacts', () => {
    const names = readdirSync(__dirname)
    expect(names.filter((name) => name.endsWith('.proposal.json'))).toHaveLength(15)
    expect(
        names.filter(
            (name) =>
                name.endsWith('.json') &&
                name !== 'publication-hashes.json' &&
                !/\.(proposal|inputs|provenance|runtime)\.json$/u.test(name),
        ),
    ).toEqual([])
})

describe('authored first-use guidance in ready screens', () => {
    it.each([
        ['recorded-home', 'home'],
        ['recorded-home-saving', 'home'],
        ['recorded-add-empty', 'add'],
        ['recorded-add-empty-saving', 'add'],
    ] as const)('%s places only useful capability or capture guidance before its existing controls', (name, kind) => {
        const raw = screenProposalV2Schema.parse(read(`${name}.proposal.json`))
        expect(raw.body.type).toBe('Scroll')
        if (raw.body.type !== 'Scroll') throw new Error('Expected existing scroll body')
        const column = raw.body.children[0]
        if (column?.type !== 'Stack') throw new Error('Expected existing ready column')
        expect(column.children.map((child) => child.type)).toEqual(
            kind === 'home' ? ['Text', 'Card'] : ['Text', 'Card', 'Section'],
        )
        expect(column.children[0]).toMatchObject({
            type: 'Text',
            content: {
                kind: 'literal',
                text:
                    kind === 'home'
                        ? 'Add a manual to start building.'
                        : 'Photograph each page of your manual, one at a time.',
            },
        })
        const card = column.children[1]
        if (card?.type !== 'Card') throw new Error('Expected one guidance card')
        expect(card.tone).toBe('neutral')
        const expected =
            kind === 'home'
                ? [
                      ['camera', 'Photograph your manual.'],
                      ['arrowRight', 'Build one step at a time.'],
                      ['search', 'Check with a photo.'],
                      ['help', 'Ask when you need help.'],
                  ]
                : [
                      ['image', 'Keep all four corners in view.'],
                      ['search', 'Check that the words are clear.'],
                  ]
        if (kind === 'home')
            expect(card.children[0]).toMatchObject({
                type: 'Text',
                role: 'heading',
                content: { kind: 'literal', text: 'How it works' },
            })
        const rows = kind === 'home' ? card.children.slice(1) : card.children
        expect(rows).toHaveLength(expected.length)
        for (const [index, [icon, text]] of expected.entries()) {
            const row = rows[index]
            if (row?.type !== 'Row') throw new Error('Expected one meaningful icon/text row per guidance line')
            expect(row.children).toHaveLength(2)
            expect(row.children[0]).toMatchObject({ type: 'Icon', name: icon })
            expect(row.children[1]).toMatchObject({ type: 'Text', role: 'body', content: { kind: 'literal', text } })
            expect(JSON.stringify(raw.states)).not.toContain(text)
        }
        if (kind === 'add')
            expect(column.children[2]).toMatchObject({
                type: 'Section',
                children: [
                    { type: 'Text', content: { kind: 'bound', key: 'privacy-stay' } },
                    { type: 'Text', content: { kind: 'bound', key: 'privacy-read' } },
                ],
            })
        expect((read(`${name}.provenance.json`) as Record<string, unknown>).taskReference).toContain('first-use polish')
    })
})

describe('authored Reading search categories', () => {
    it.each(['recorded-reading', 'recorded-reading-active', 'recorded-reading-saving'] as const)(
        '%s keeps one neutral search-goal card stable across ready, busy and pending',
        (name) => {
            const raw = screenProposalV2Schema.parse(read(`${name}.proposal.json`))
            const cards = []
            for (const state of ['ready', 'busy', 'pending'] as const) {
                const variant = state === 'ready' ? raw : raw.states[state]
                if (variant === null || variant.body.type !== 'Scroll')
                    throw new Error('Expected existing Reading variant')
                const column = variant.body.children[0]
                if (column?.type !== 'Stack') throw new Error('Expected existing Reading column')
                const card = column.children.at(-1)
                if (card?.type !== 'Card') throw new Error('Expected search-goal card after existing content')
                expect(card.surface).toBe('tinted')
                expect(card.tone).toBe('neutral')
                expect(card.children).toHaveLength(5)
                expect(card.children[0]).toMatchObject({
                    type: 'Text',
                    role: 'heading',
                    content: { kind: 'literal', text: 'What we look for' },
                })
                const expected = [
                    ['arrowRight', 'Steps'],
                    ['image', 'Parts'],
                    ['alert', 'Safety notes'],
                    ['help', 'Unclear details'],
                ]
                for (const [index, [icon, text]] of expected.entries()) {
                    const row = card.children[index + 1]
                    if (row?.type !== 'Row') throw new Error('Expected one icon/text row for each parser category')
                    expect(row.children).toHaveLength(2)
                    expect(row.children[0]).toMatchObject({ type: 'Icon', name: icon })
                    expect(row.children[1]).toMatchObject({
                        type: 'Text',
                        role: 'body',
                        content: { kind: 'literal', text },
                    })
                }
                cards.push(card)
            }
            expect(cards[0]).toEqual(cards[1])
            expect(cards[0]).toEqual(cards[2])
            for (const state of ['empty', 'error', 'recovery', 'confirming'] as const) {
                expect(JSON.stringify(raw.states[state])).not.toContain('What we look for')
            }
            expect((read(`${name}.provenance.json`) as Record<string, unknown>).taskReference).toContain(
                'Reading polish',
            )
        },
    )
})
