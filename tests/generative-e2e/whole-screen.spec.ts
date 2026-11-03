import { expect, test, type Page } from '@playwright/test'
import { modelScreensV2MetadataSchema, screensV2ResultSchema } from '@truebuild/contracts/model'

// Browser integration evidence only. Real controller, capture IO seam, client, multipart, API and catalog renderer.
// The fixture server has no inference transport. No route intercepts or answers an application request.
const API = 'http://127.0.0.1:3101'
const mode = process.env.TRUEBUILD_E2E_GENERATIVE_UI ?? 'full'

function isDocumentUrl(value: string): boolean {
    const url = new URL(value)
    const capability = url.searchParams.getAll('guideRepair')
    return url.origin === API && url.pathname === '/api/screens/v2' && capability.length === 1 && capability[0] === '1'
}

async function photographPage(page: Page, first: boolean): Promise<void> {
    await page.getByTestId(first ? 'take-page-photo' : 'add-page').click()
    await expect(page.getByTestId('camera-shutter')).toBeEnabled()
    await page.getByTestId('camera-shutter').click()
    await expect(page.getByTestId('read-manual')).toBeEnabled()
}

// Fresh startup only: accepts the visible AI consent once, through its own control. Nothing is pre-accepted or skipped.
async function acceptAiConsentOnce(page: Page): Promise<void> {
    const agree = page.getByRole('button', { name: 'Agree and continue', exact: true })
    await agree
        .or(page.getByTestId('home-add'))
        .or(page.getByRole('button', { name: 'Try again', exact: true }))
        .first()
        .waitFor({ state: 'visible', timeout: 60_000 })
    if (await agree.isVisible()) await agree.click()
}

/** Consent can first appear at Read; observe dispatch before clicking so filming opt-in and ordinary users both work. */
async function readManualWithConsent(page: Page): Promise<void> {
    const sent = page.waitForRequest(
        (request) => request.url() === `${API}/api/manuals/parse?stepKinds=remove` && request.method() === 'POST',
        { timeout: 60_000 },
    )
    const agree = page.getByRole('button', { name: 'Agree and continue', exact: true })
    const prompted = agree.waitFor({ state: 'visible', timeout: 60_000 }).then(() => true)
    const outcome = Promise.race([sent.then(() => false), prompted])
    void outcome.catch(() => undefined)
    await page.getByTestId('read-manual').click()
    if (await outcome) await agree.click()
    await sent
}

async function prepareGuide(page: Page, alreadyHome = false): Promise<void> {
    if (!alreadyHome) {
        await page.goto('/')
        await acceptAiConsentOnce(page)
    }
    await page.getByTestId('home-add').click()
    await photographPage(page, true)
    const parse = page
        .waitForResponse((response) => response.url() === `${API}/api/manuals/parse?stepKinds=remove`)
        .then(async (response) => ({ status: response.status(), body: await response.json() }))
    await readManualWithConsent(page)
    expect((await parse).status).toBe(200)
    await expect(page.getByTestId('quick-check-start')).toBeEnabled()
    await page.getByTestId('quick-check-start').click()
    await expect(page.getByTestId('guide-primary')).toBeEnabled()
    await expect(page).toHaveURL(/\/guide\//u)
}

async function checkPhoto(page: Page): Promise<{ decision: string; captureId: string }> {
    await page.getByTestId('guide-primary').click()
    await expect(page.getByTestId('camera-shutter')).toBeEnabled()
    const check = page
        .waitForResponse((response) => response.url() === `${API}/api/checks`)
        .then(async (response) => {
            expect(response.status()).toBe(200)
            return (await response.json()) as {
                binding: { captureId: string }
                value: { decision: string; evidence: string; model?: string }
            }
        })
    await page.getByTestId('camera-shutter').click()
    const response = await check
    expect(response.value.evidence).toBe('synthetic-fixture')
    expect(response.value.model).toBeUndefined()
    return { decision: response.value.decision, captureId: response.binding.captureId }
}

test('a complete document owns the frame; off stays local and full publishes honestly synthetic metadata', async ({
    page,
}) => {
    let documentRequests = 0
    page.on('request', (request) => {
        if (isDocumentUrl(request.url())) documentRequests++
    })
    // Consume the first complete response before navigating. Chromium may discard a response body when its route leaves.
    const firstDocument =
        mode !== 'off'
            ? page
                  .waitForResponse(async (response) => {
                      if (!isDocumentUrl(response.url()) || response.status() !== 200) return false
                      const published = screensV2ResultSchema.parse(await response.json())
                      return (
                          published.status === 'ok' &&
                          [published.value.document, ...published.value.documents].some(
                              (document) => document?.metadata.source === 'generated',
                          )
                      )
                  })
                  .then((response) => response.json())
            : null
    await page.goto('/')
    await acceptAiConsentOnce(page)
    // Launch recordings intentionally serve Home without a request; factual manual routes still use the API.
    await prepareGuide(page, true)
    if (firstDocument !== null) {
        const published = screensV2ResultSchema.parse(await firstDocument)
        expect(published).toMatchObject({ status: 'ok', mode: 'fixture' })
        if (published.status !== 'ok') throw new Error('Expected a published document')
        expect([published.value.document, ...published.value.documents]).toContainEqual(
            expect.objectContaining({
                metadata: expect.objectContaining({
                    source: 'generated',
                    evidence: 'synthetic-fixture',
                    model: null,
                    effort: null,
                }),
            }),
        )
        await expect(page.getByTestId('guide-screen')).toHaveAttribute(
            'id',
            /(?:^|\|)truebuild-render-origin:generated(?:\||$)/u,
        )
    }
    await expect(page.getByTestId('guide-screen').getByTestId('bottom-bar')).toHaveCount(1)
    await expect(
        page.getByTestId('guide-screen').getByRole('img', { name: 'Picture from your manual' }).first(),
    ).toBeVisible()
    // Guide directions are visible immediately, including explicitly classified directions.
    await expect(page.getByText('Groove faces inward toward the divider.', { exact: true }).first()).toBeVisible()
    if (mode !== 'off') {
        expect(documentRequests).toBeGreaterThan(0)
    } else expect(documentRequests).toBe(0)
    await page.reload()
    await expect(page.getByTestId('guide-primary')).toBeEnabled()
    await expect(page).toHaveURL(/\/guide\//u)
})

test('the verdict shows its held photo before a late overlay is collected', async ({ page }) => {
    await prepareGuide(page)
    const overlay =
        mode === 'full' ? page.waitForResponse((response) => response.url() === `${API}/api/checks/overlay`) : null
    const collected =
        mode === 'full'
            ? page.waitForResponse(
                  (response) => response.url() === `${API}/api/checks/overlay/result` && response.status() === 200,
              )
            : null
    const result = await checkPhoto(page)
    expect(result.decision).toBe('pass')
    await expect(page.getByTestId('frozen-photo-image')).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Looks right', exact: true })).toBeVisible()
    if (overlay !== null) {
        expect((await overlay).status()).toBe(202)
        expect(await (await collected!).json()).toMatchObject({
            status: 'ok',
            value: { evidence: 'synthetic-fixture' },
        })
        await expect(page.getByRole('heading', { name: 'Looks right', exact: true })).toBeVisible()
    }
})

test('reading cancellation is an authored confirmation and Keep preserves the running parse', async ({ page }) => {
    await page.goto('/')
    await acceptAiConsentOnce(page)
    await page.getByTestId('home-add').click()
    await photographPage(page, true)
    await readManualWithConsent(page)
    await page.getByRole('button', { name: 'Back', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Stop reading', exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Keep reading', exact: true }).click()
    await expect(page.getByTestId('quick-check-start')).toBeEnabled()
})

test('a closer look, slow question and retained More use the same photo; a fresh passing check completes the build', async ({
    page,
}) => {
    let retainQuestion!: (response: { status: number; body: unknown }) => void
    const questionResponse = new Promise<{ status: number; body: unknown }>((resolve) => {
        retainQuestion = resolve
    })
    await page.exposeBinding(
        'truebuildRetainQuestionResponse',
        (_source, response: { status: number; body: unknown }) => {
            retainQuestion(response)
        },
    )
    // Retain the actual wire body before the application can act on its 202 and change the Modal/navigation state.
    // DevTools may release that response body after the transition; this neither intercepts nor changes the response.
    await page.addInitScript((questionUrl: string) => {
        const fetch = window.fetch.bind(window)
        window.fetch = async (...args: Parameters<typeof window.fetch>): Promise<Response> => {
            const response = await fetch(...args)
            if (response.url === questionUrl) {
                const retain: unknown = Reflect.get(window, 'truebuildRetainQuestionResponse')
                if (typeof retain !== 'function') throw new Error('Question response observer is unavailable')
                await retain({ status: response.status, body: (await response.clone().json()) as unknown })
            }
            return response
        }
    }, `${API}/api/questions`)
    // Arm before preparation: the destination may arrive by direct generation or precompute progress.
    // The fixture's later Guide takes five seconds; navigation retains the real Result until it is ready.
    const nextGuide =
        mode !== 'off'
            ? page
                  .waitForResponse(async (response) => {
                      if (!isDocumentUrl(response.url()) || response.status() !== 200) return false
                      const request = response.request()
                      const body = request.postDataBuffer()
                      if (body === null) return false
                      const form = await new Response(new Uint8Array(body), {
                          headers: { 'content-type': request.headers()['content-type']! },
                      }).formData()
                      const metadata = modelScreensV2MetadataSchema.parse(JSON.parse(String(form.get('metadata'))))
                      if (metadata.uiState?.busy != null) return false
                      if (
                          metadata.op === 'generate' &&
                          (metadata.kind !== 'guide' || metadata.stepId !== 'step-2' || metadata.captureId !== null)
                      )
                          return false
                      if (!['generate', 'precompute', 'progress'].includes(metadata.op)) return false
                      const published = screensV2ResultSchema.parse(await response.json())
                      return (
                          published.status === 'ok' &&
                          [published.value.document, ...published.value.documents].some(
                              (document) =>
                                  document?.kind === 'guide' &&
                                  document.bound.stepId === 'step-2' &&
                                  document.bound.captureId === null &&
                                  document.metadata.source === 'generated',
                          )
                      )
                  })
                  .then(async (response) => screensV2ResultSchema.parse(await response.json()))
            : null
    await prepareGuide(page)
    const manualId = decodeURIComponent(new URL(page.url()).pathname.split('/').at(-1)!)
    await checkPhoto(page)
    await expect(page.getByRole('heading', { name: 'Looks right', exact: true })).toBeVisible()
    // Read the prefetched body while its route still owns the request; leaving can discard an unread body.
    const published = nextGuide === null ? null : await nextGuide
    await page.getByTestId('guide-primary').click()
    if (published !== null) {
        if (published.status !== 'ok') throw new Error('Expected next Guide')
        const document = [published.value.document, ...published.value.documents].find(
            (candidate) =>
                candidate?.kind === 'guide' &&
                candidate.bound.manualId === manualId &&
                candidate.bound.stepId === 'step-2' &&
                candidate.bound.captureId === null,
        )
        expect(document).toMatchObject({
            kind: 'guide',
            bound: { manualId, stepId: 'step-2', captureId: null },
            metadata: { source: 'generated', evidence: 'synthetic-fixture' },
        })
        if (document == null) throw new Error('Expected current next Guide')
        await expect(page.getByTestId('guide-screen')).toHaveAttribute(
            'id',
            new RegExp(`(?:^|\\|)truebuild-document-root:${document.screenId}(?:\\||$)`, 'u'),
        )
    }
    await expect(page.getByRole('heading', { name: 'Step 2 of 2', exact: true })).toBeVisible()
    const secondPass = page
        .waitForResponse((response) => response.url() === `${API}/api/checks/second-opinion`)
        .then(async (response) => ({ status: response.status(), body: (await response.json()) as unknown }))
    const primary = await checkPhoto(page)
    expect(primary.decision).toBe('cannot_verify')
    await expect(page.getByTestId('document-check-result')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Retake photo', exact: true })).toBeEnabled()
    expect(await secondPass).toMatchObject({ status: 200, body: { status: 'ok', value: { decision: 'refuse' } } })
    await expect(page.getByRole('heading', { name: 'Not quite right', exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'More', exact: true }).click()
    const more = page.getByTestId('more-sheet')
    await expect(more.getByTestId('frozen-photo-image')).toBeVisible()
    await expect(more.getByRole('img', { name: 'Picture from your manual', exact: true }).first()).toBeVisible()
    await expect(more.getByTestId('document-check-result')).toContainText(
        'Check the connection against the manual picture.',
    )
    await more.getByRole('button', { name: 'Ask about this step', exact: true }).click()
    await more
        .getByRole('button', { name: 'Choose a point in your photo. Double tap to choose the middle.', exact: true })
        .click()
    await more.getByLabel('Your question', { exact: true }).fill('How should this connection face?')
    let questionDispatches = 0
    page.on('request', (request) => {
        if (request.url() === `${API}/api/questions`) questionDispatches++
    })
    await more.getByRole('button', { name: 'Ask', exact: true }).click()
    // The API's actual pending response confirms which held capture it accepted. Chromium omits blob multipart postData.
    expect(await questionResponse).toMatchObject({
        status: 202,
        body: { status: 'pending', binding: { captureId: primary.captureId } },
    })
    expect(questionDispatches).toBe(1)
    await expect(more.getByRole('heading', { name: 'Still thinking…', exact: true }).first()).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Answer', exact: true })).toBeVisible()
    expect(questionDispatches).toBe(1)
    await page.getByRole('button', { name: 'More', exact: true }).click()
    await expect(more.getByText('How should this connection face?', { exact: true })).toBeVisible()
    await expect(more.getByTestId('document-check-result')).toContainText(
        'Check the connection against the manual picture.',
    )
    await expect(more.getByTestId('document-question-result')).toContainText(
        'Divider is horizontal and square to the upright panel.',
    )
    await expect(more.getByText('Looks right', { exact: true })).toHaveCount(0)
    await more.getByTestId('close-sheet').click()
    await page.getByTestId('guide-primary').click()
    await expect(page.getByTestId('guide-primary')).toBeEnabled()
    const fresh = await checkPhoto(page)
    expect(fresh.decision).toBe('pass')
    expect(fresh.captureId).not.toBe(primary.captureId)
    await expect(page.getByRole('heading', { name: 'Looks right', exact: true })).toBeVisible()
    await page.getByTestId('guide-primary').click()
    await expect(page).toHaveURL(/\/done\//u)
    await expect(page.getByRole('heading', { name: 'All steps done', exact: true })).toBeVisible()
})
