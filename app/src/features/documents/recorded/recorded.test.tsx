import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import {
    BUSY_COPY_V2,
    waitCopyV2,
    canonicalJson,
    cameraSpineV2,
    CAMERA_TIPS_V2,
    CAMERA_ACCESS_COPY_V2,
    cameraAccessV2,
    COACH_COPY_V2,
    coachTargetsForV2,
    documentMaterialV2,
    createDemoManual,
    screenProposalV2Schema,
    verifyDocumentAgainstInputsV2,
    variantsOfV2,
    visitVariantNodesV2,
    type ScreenContextInputsV2,
    type ScreenDocumentV2,
} from '@truebuild/contracts'
import { sha256Hex } from '../sha256'
import { barTestId } from '../../screens/bar-ids'
import { recordedDocumentForTest } from './test-support'

const read = (name: string): unknown => JSON.parse(readFileSync(join(__dirname, name), 'utf8'))

describe('synthetic test fixture proposal', () => {
    it('validates as a strict v2 generated home document with complete origins', () => {
        const doc = recordedDocumentForTest('recorded-home')
        expect(doc.kind).toBe('home')
        expect(doc.metadata.source).toBe('generated')
        expect(doc.metadata.origins['header']).toBe('generated')
        expect(doc.metadata.origins['bar.primary']).toBe('generated')
        const prov = read('recorded-home.provenance.json')
        expect(prov).toEqual({
            fixtureId: 'recorded-home-sol-v1',
            schemaVersion: 1,
            description: expect.any(String),
        })
        expect(doc.metadata.authoring?.model).toBe('Test fixture')
        expect(doc.metadata.model).toBeNull()
        expect(doc.metadata.effort).toBeNull()
        expect(Object.values(doc.metadata.usage).every((value) => value === null)).toBe(true)
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
    'recorded-reading-notice',
    'recorded-reading-active',
    'recorded-home-saving',
    'recorded-home-library-single-saving',
    'recorded-home-library-multiple-saving',
    'recorded-add-empty-saving',
    'recorded-pages-saving',
    'recorded-pages-cancelled-saving',
    'recorded-reading-saving',
    'recorded-more-global',
    'recorded-judge-global',
    'recorded-camera-page',
    'recorded-camera-page-saving',
    'recorded-camera-page-allow',
    'recorded-camera-page-allow-saving',
    'recorded-camera-page-settings',
    'recorded-camera-page-settings-saving',
    'recorded-camera-page-retry',
    'recorded-camera-page-retry-saving',
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

it.each(ARTIFACTS.filter((name) => name.startsWith('recorded-camera-page')))(
    '%s keeps the original Back control on every camera state',
    (name) => {
        const document = recordedDocumentForTest(name)
        for (const state of VARIANT_NAMES) {
            const variant = state === 'ready' ? document : document.states[state]
            if (variant === null) continue
            expect(variant.header.back).toMatchObject({
                label: 'Back',
                intent: { intent: 'navigate', target: 'back' },
            })
        }
    },
)

describe('synthetic test fixture state proposals (explicit raw trees)', () => {
    it.each(ARTIFACTS)('%s matches its complete canonical publication pin', (name) => {
        const hashes = read('publication-hashes.json') as Record<string, string>
        expect(sha256Hex(canonicalJson(recordedDocumentForTest(name)))).toBe(hashes[name])
    })
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
        const runtime = read(`${name}.runtime.json`) as Record<string, unknown>
        expect(provenance).toEqual({
            fixtureId: `${name}-sol-v1`,
            schemaVersion: 1,
            description: expect.any(String),
        })
        expect(provenance.description).not.toMatch(/[\r\n]/u)
        expect(runtime.rawJsonSha256).toBe(sha256Hex(readFileSync(join(__dirname, `${name}.proposal.json`), 'utf8')))
        expect(runtime.proposalSha256).toBe(sha256Hex(canonicalJson(proposal)))
        expect(doc.metadata.generatedAt).toBe(runtime.recordedAt)
        expect(doc.metadata.authoring).toEqual(runtime.authoring)
        expect(doc.metadata.authoring?.model).toBe('Test fixture')
        expect(doc.metadata.fixtureId).toBeUndefined()
        expect(Object.values(doc.metadata.timing).every((value) => value === null)).toBe(true)
        expect(Object.values(doc.metadata.usage).every((value) => value === null)).toBe(true)
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

    it.each(ARTIFACTS)('%s uses its screen preparation copy in pending', (name) => {
        const doc = recordedDocumentForTest(name)
        const copy = waitCopyV2(doc.kind)
        expect(doc.states.pending?.header.title).toEqual({ kind: 'literal', text: copy.heading })
        const texts = variantLiteralTexts(doc, 'pending')
        if (copy.detail !== '') expect(texts).toContain(copy.detail)
        expect(texts).not.toContain('')
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
            ...(BUSY_COPY_V2.saving.detail === '' ? [] : [BUSY_COPY_V2.saving.detail]),
            ...(base === 'recorded-home'
                ? [
                      'How it works',
                      'Photograph your manual.',
                      'Build one step at a time.',
                      'Check with a photo.',
                      'Ask when you need help.',
                  ]
                : base === 'recorded-add-empty'
                  ? ['Keep all four corners in view.', 'Check that the words are clear.']
                  : []),
            ...(base === 'recorded-reading'
                ? ['What we look for', 'Steps', 'Parts', 'Safety notes', 'Unclear details']
                : []),
        ])
        expect(raw.states.busy?.bar).toEqual({
            ...original.states.busy!.bar,
            primary: { ...original.states.busy!.bar.primary, label: waitCopyV2(doc.kind, 'saving').action },
        })
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
    it.each(ARTIFACTS)('%s ships only fixture metadata and integrity pins', (name) => {
        expect(existsSync(join(__dirname, `${name}.runtime.json`))).toBe(true)
        const publicMetadata = read(`${name}.provenance.json`) as Record<string, unknown>
        const runtime = read(`${name}.runtime.json`) as Record<string, unknown>
        expect(Object.keys(publicMetadata).sort()).toEqual(['description', 'fixtureId', 'schemaVersion'])
        expect(runtime).toEqual({
            evidence: 'synthetic-fixture',
            model: null,
            effort: null,
            authoring: {
                model: 'Test fixture',
                effort: 'ultra',
                fixtureId: publicMetadata.fixtureId,
                recordedAt: runtime.recordedAt,
            },
            recordedAt: expect.any(String),
            promptVersion: 0,
            repaired: false,
            rawJsonSha256: sha256Hex(readFileSync(join(__dirname, `${name}.proposal.json`), 'utf8')),
            proposalSha256: sha256Hex(canonicalJson(read(`${name}.proposal.json`))),
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

it('ships all twenty-six raw families without derived document build artifacts', () => {
    const names = readdirSync(__dirname)
    expect(
        names
            .filter((name) => name.endsWith('.proposal.json'))
            .map((name) => name.replace('.proposal.json', ''))
            .sort(),
    ).toEqual([...ARTIFACTS].sort())
    expect(names.filter((name) => name.endsWith('.proposal.json'))).toHaveLength(26)
    expect(
        names.filter(
            (name) =>
                name.endsWith('.json') &&
                name !== 'publication-hashes.json' &&
                !/\.(proposal|inputs|provenance|runtime)\.json$/u.test(name),
        ),
    ).toEqual([])
})

describe('authored first-use guidance across ready and waiting screens', () => {
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
            for (const state of ['busy', 'pending'] as const) {
                const waiting = raw.states[state]
                if (waiting?.body.type !== 'Scroll') throw new Error('Expected complete waiting scroll')
                const waitingColumn = waiting.body.children[0]
                if (waitingColumn?.type !== 'Stack') throw new Error('Expected complete waiting column')
                expect(waitingColumn.children.at(-1)).toEqual(card)
            }
            for (const state of ['empty', 'error', 'recovery', 'confirming'] as const)
                expect(JSON.stringify(raw.states[state])).not.toContain(text)
        }
        if (kind === 'add')
            expect(column.children[2]).toMatchObject({
                type: 'Section',
                children: [
                    { type: 'Text', content: { kind: 'bound', key: 'privacy-stay' } },
                    { type: 'Text', content: { kind: 'bound', key: 'privacy-read' } },
                ],
            })
    })
})

describe('authored initial manual-page camera', () => {
    it.each(['recorded-camera-page', 'recorded-camera-page-saving'] as const)(
        '%s keeps its genuine framing guidance and camera spine stable while waiting',
        (name) => {
            const raw = screenProposalV2Schema.parse(read(`${name}.proposal.json`))
            const readySpine = cameraSpineV2(raw)
            expect(readySpine).not.toBeNull()
            let readyCard: unknown
            for (const state of ['ready', 'busy', 'pending'] as const) {
                const variant = state === 'ready' ? raw : raw.states[state]
                if (variant?.body.type !== 'Scroll') throw new Error('Expected complete camera scroll')
                const column = variant.body.children[0]
                if (column?.type !== 'Stack') throw new Error('Expected camera column')
                expect(cameraSpineV2(variant)).toBe(readySpine)
                expect(column.children[0]).toMatchObject({ type: 'CameraView', mode: 'manual-page' })
                const card = column.children[1]
                if (card?.type !== 'Card') throw new Error('Expected one real capture-guidance card')
                expect(card.children).toHaveLength(2)
                for (const [index, text] of CAMERA_TIPS_V2['manual-page'].entries()) {
                    const row = card.children[index]
                    if (row?.type !== 'Row') throw new Error('Expected a compact icon/text row')
                    expect(row.children).toHaveLength(2)
                    expect(row.children[0]).toMatchObject({ type: 'Icon', name: index === 0 ? 'image' : 'search' })
                    expect(row.children[1]).toMatchObject({ type: 'Text', content: { kind: 'literal', text } })
                }
                if (state === 'ready') readyCard = card
                else expect(card).toEqual(readyCard)
                expect(column.children[2]).toMatchObject({
                    type: 'Text',
                    content: { kind: 'bound', key: 'privacy-camera' },
                })
            }
            expect(raw.states.pending!.bar.primary.intent).toEqual({ intent: 'capture', target: 'take-photo' })
            expect(raw.overlays.map((overlay) => overlay.anchor)).toEqual(['camera-shutter', 'guide-hero-frame'])
            for (const state of ['error', 'recovery'] as const) {
                expect(cameraSpineV2(raw.states[state]!)).toBeNull()
            }
        },
    )
})

describe('authored manual-page camera consent paths', () => {
    it.each(['allow', 'settings', 'retry'] as const)(
        '%s and its saving sibling earn only the current camera permission action',
        (access) => {
            const name = `recorded-camera-page-${access}`
            const base = screenProposalV2Schema.parse(read(`${name}.proposal.json`))
            const saving = screenProposalV2Schema.parse(read(`${name}-saving.proposal.json`))
            expect({ ...saving, states: { ...saving.states, busy: null } }).toEqual({
                ...base,
                states: { ...base.states, busy: null },
            })
            const expectedBusy = structuredClone(base.states.busy!)
            const savingCopy = waitCopyV2('camera', 'saving')
            visitVariantNodesV2(expectedBusy, '', ({ node }) => {
                if (!('children' in node)) return
                for (let index = node.children.length - 1; index >= 0; index -= 1) {
                    const child = node.children[index]!
                    if (
                        child.type === 'Text' &&
                        child.content.kind === 'literal' &&
                        child.content.text === waitCopyV2('camera').detail
                    ) {
                        if (savingCopy.detail === '') node.children.splice(index, 1)
                        else child.content.text = savingCopy.detail
                    }
                }
            })
            expectedBusy.bar.primary.label = savingCopy.action
            expect({ ...saving.states.busy, header: null }).toEqual({ ...expectedBusy, header: null })
            expect(variantLiteralTexts(recordedDocumentForTest(`${name}-saving`), 'busy')).not.toContain('')
            expect(saving.states.busy!.header).toEqual({
                ...base.states.busy!.header,
                title: { kind: 'literal', text: BUSY_COPY_V2.saving.heading },
            })
            for (const suffix of ['', '-saving']) {
                const family = `${name}${suffix}`
                const inputs = read(`${family}.inputs.json`) as ScreenContextInputsV2
                const raw = suffix === '' ? base : saving
                const doc = recordedDocumentForTest(family)
                expect(cameraAccessV2(inputs.uiState?.camera)).toBe(access)
                expect(inputs.uiState?.camera?.mode).toBe('manual-page')
                expect(doc.facts).toEqual([])
                expect(raw.header.title).toEqual({ kind: 'literal', text: CAMERA_ACCESS_COPY_V2[access].heading })
                expect(raw.bar.primary.intent).toEqual(
                    access === 'allow'
                        ? { intent: 'confirm', target: 'camera-permission' }
                        : access === 'settings'
                          ? { intent: 'open-details', target: 'device-settings' }
                          : { intent: 'retry', target: 'camera' },
                )
                let readyCard: unknown
                for (const state of ['ready', 'busy', 'pending'] as const) {
                    const variant = state === 'ready' ? raw : raw.states[state]
                    if (variant?.body.type !== 'Scroll') throw new Error('Expected complete access scroll')
                    const column = variant.body.children[0]
                    if (column?.type !== 'Stack') throw new Error('Expected access column')
                    const card = column.children[0]
                    if (card?.type !== 'Card') throw new Error('Expected one access explanation')
                    expect(card.children).toHaveLength(2)
                    expect(card.children[1]).toMatchObject({
                        type: 'Text',
                        content: { kind: 'literal', text: CAMERA_ACCESS_COPY_V2[access].detail },
                    })
                    expect(column.children[1]).toMatchObject({
                        type: 'Text',
                        content: { kind: 'bound', key: 'privacy-camera' },
                    })
                    if (state === 'ready') readyCard = card
                    else expect(card).toEqual(readyCard)
                }
                for (const { variant, prefix } of variantsOfV2(raw)) {
                    expect(variant.overlays).toEqual([])
                    visitVariantNodesV2(variant, prefix, ({ node }) => expect(node.type).not.toBe('CameraView'))
                }
                if (access === 'retry') {
                    expect(raw.states.error!.bar.primary.intent).toEqual({ intent: 'retry', target: 'camera' })
                    expect(raw.states.recovery!.bar.primary.intent).toEqual({ intent: 'retry', target: 'camera' })
                }
            }
        },
    )
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
        },
    )
})
