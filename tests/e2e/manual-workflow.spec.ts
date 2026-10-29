import { Buffer } from 'node:buffer'
import { expect, test, type Page, type Response } from '@playwright/test'
import { apiResultSchema, checkResultSchema } from '@truebuild/contracts'

// Real product path: the browser file chooser and normalizer, the app client, the Hono API and the documented Meta HTTP
// mock. Nothing here intercepts or answers an API request; responses are read from the real network.
const API = process.env.TRUEBUILD_E2E_API_ORIGIN ?? 'http://127.0.0.1:31071'
const WEB = `http://localhost:${process.env.TRUEBUILD_E2E_WEB_PORT ?? '18071'}`
const SCENARIO = process.env.TRUEBUILD_E2E_SCENARIO ?? 'reversed'
const SECOND_OPINION = process.env.TRUEBUILD_E2E_SECOND_OPINION
// The hero sentence starts with the verdict in plain words; the tag in More names it again.
const VERDICT_SENTENCE: Record<string, RegExp> = {
    correct: /^Looks right\./u,
    reversed: /^Not yet\./u,
    uncertain: /^We can't tell from this photo\./u,
}
const DECISION: Record<string, string> = { correct: 'pass', reversed: 'refuse', uncertain: 'cannot_verify' }

// Synthetic 1x1 PNG: browser decoding, normalization and storage run for real.
const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jfasAAAAASUVORK5CYII=',
    'base64',
)

test.beforeEach(async ({ context }) => {
    await context.grantPermissions(['camera'], { origin: WEB })
})

async function openFreshLibrary(page: Page): Promise<void> {
    await page.goto('/')
    await expect(page.getByText('Build furniture with step-by-step help.', { exact: true })).toBeVisible({
        timeout: 60_000,
    })
}

async function addTwoPagesAndRead(page: Page): Promise<Response> {
    await page.getByRole('button', { name: 'Add manual', exact: true }).click()
    const chooser = page.waitForEvent('filechooser')
    await page.getByRole('button', { name: 'Choose pages from photos', exact: true }).click()
    await (
        await chooser
    ).setFiles([
        { name: 'page-1.png', mimeType: 'image/png', buffer: png },
        { name: 'page-2.png', mimeType: 'image/png', buffer: png },
    ])
    await expect(page.getByText('Page 2', { exact: true })).toBeVisible()
    // Page tools live in the page's sheet, not on the Add screen.
    await page.getByRole('button', { name: 'View page 2', exact: true }).click()
    // Moving a page closes its sheet.
    await page.getByRole('button', { name: 'Move page 2 up', exact: true }).click()
    const parse = page.waitForResponse(
        (response) => response.url() === `${API}/api/manuals/parse` && response.request().method() === 'POST',
    )
    await page.getByRole('button', { name: 'Read my manual', exact: true }).click()
    return parse
}

async function startBuilding(page: Page): Promise<void> {
    // Reading ends on Quick check. Nothing is unclear in the mock plan, so the only step left is one explicit tap.
    await expect(page.getByText('Thanks. Your steps are ready.', { exact: true })).toBeVisible({ timeout: 120_000 })
    await page.getByRole('button', { name: 'Start building', exact: true }).click()
    await expect(page.getByTestId('guide-primary')).toBeVisible()
}

async function openMore(page: Page): Promise<void> {
    await page.getByRole('button', { name: 'More', exact: true }).click()
    await expect(page.getByText('More about this step', { exact: true })).toBeVisible()
}

test('real path: pages are read by the API, the plan is started, the guide restores after reload, and a check returns the scenario verdict', async ({
    page,
}) => {
    await openFreshLibrary(page)
    const parse = await addTwoPagesAndRead(page)
    expect((await parse).status()).toBe(200)
    await startBuilding(page)

    // The address is the guide's own: a reload opens the same build at the same step.
    await page.reload()
    await expect(page.getByTestId('guide-primary')).toBeVisible({ timeout: 60_000 })
    // And from Home, the one primary resumes it.
    await page.goto('/')
    await page.getByRole('button', { name: 'Keep building', exact: true }).click()

    await page.getByTestId('guide-primary').click()
    const capture = page.getByRole('button', { name: 'Capture photo', exact: true })
    await expect(capture).toBeEnabled({ timeout: 60_000 })
    // Read immediately when headers arrive: closing the camera route can evict Chromium's response body before
    // capture.click() settles. This still reads the real API response without intercepting the request.
    const check = page
        .waitForResponse((response) => response.url() === `${API}/api/checks` && response.request().method() === 'POST')
        .then(async (response) => ({
            status: response.status(),
            body: (await response.json()) as { status: string; value: { decision: string } },
        }))
    await capture.click()
    const response = await check
    expect(response.status).toBe(200)
    const body = response.body
    expect(body.status).toBe('ok')
    expect(body.value.decision).toBe(DECISION[SCENARIO])
    await expect(page.getByText(VERDICT_SENTENCE[SCENARIO] ?? /$^/u)).toBeVisible({ timeout: 90_000 })
})

test('refusal shows the expected diagram and your photo side by side in More, and a question is requested from the API', async ({
    page,
}) => {
    test.skip(SCENARIO !== 'reversed', 'refusal layout is scenario-specific')
    await openFreshLibrary(page)
    await addTwoPagesAndRead(page)
    await startBuilding(page)
    await page.getByTestId('guide-primary').click()
    await expect(page.getByRole('button', { name: 'Capture photo', exact: true })).toBeEnabled({ timeout: 60_000 })
    await page.getByRole('button', { name: 'Capture photo', exact: true }).click()
    await expect(page.getByText(/^Not yet\./u)).toBeVisible({ timeout: 90_000 })
    await openMore(page)
    await expect(page.getByText('Manual diagram', { exact: true })).toBeVisible()
    await expect(page.getByText('Your photo', { exact: true })).toBeVisible()
    await expect(page.getByText('Not yet', { exact: true })).toBeVisible()

    // A point chosen on the refused photo itself, without retaking it, is a valid question target.
    await page.getByRole('button', { name: 'Your photo: tap a point to ask about it', exact: true }).click()
    // Asking is an early row in the same More sheet; the chosen point is kept when it switches to the question.
    await page.getByRole('button', { name: 'Ask about this step', exact: true }).click()
    await expect(page.getByText('Selected point in photo.', { exact: true })).toBeVisible()
    await page.getByLabel('Question about your photo').fill('Which way should this part face?')
    const question = page.waitForResponse(
        (response) => response.url() === `${API}/api/questions` && response.request().method() === 'POST',
    )
    await page.getByRole('button', { name: 'Send question', exact: true }).click()
    expect((await question).status()).toBe(200)
    await expect(page.getByText('TEST MOCK ONLY: consult the cited diagram.', { exact: false }).first()).toBeVisible({
        timeout: 60_000,
    })
    // A returned answer closes the composer and reads neutrally on the Guide; retained check details stay in More.
    await expect(page.getByLabel('Question about your photo')).toHaveCount(0)
    await expect(page.getByTestId('result-icon')).toHaveCount(0)
    await openMore(page)
    // The answer is neutral: the refused check stays refused and no "Looks right" verdict appears.
    await expect(page.getByText('Answer', { exact: true })).toBeVisible()
    await expect(page.getByText('Not yet', { exact: true })).toBeVisible()
    await expect(page.getByText('Looks right', { exact: true })).toHaveCount(0)
})

test('the library shows its restoring state while it loads, before any manual is listed', async ({ page }) => {
    // Development-build query parameter: delays only the first restore, so the loading state is observable.
    await page.goto('/?truebuildTestRestoreDelayMs=3000')
    await expect(page.getByLabel('Getting your builds ready.')).toBeVisible({ timeout: 60_000 })
    await expect(page.getByText('Build furniture with step-by-step help.', { exact: true })).toBeVisible({
        timeout: 60_000,
    })
})

test('an unknown critical fact is asked as one honest question and blocks starting until it is answered', async ({
    page,
}) => {
    await openFreshLibrary(page)
    const parse = await addTwoPagesAndRead(page)
    expect((await parse).status()).toBe(200)
    await expect(page.getByText('Thanks. Your steps are ready.', { exact: true })).toBeVisible({ timeout: 120_000 })
    // Test-only, schema-valid local edit of the stored plan: step 1 orientation becomes an unknown critical fact.
    await page.evaluate(() => {
        const key = 'truebuild/library/v1'
        const manifest = JSON.parse(localStorage.getItem(key) ?? '{}')
        for (const entry of manifest.entries) {
            entry.session.reviewedSteps[0].orientation = {
                state: 'unknown',
                reason: 'Arrow is not visible in the photo.',
            }
        }
        localStorage.setItem(key, JSON.stringify(manifest))
    })
    // The address is the Quick check's own: reloading opens it with the stored plan.
    await page.reload()
    await expect(page.getByText('Which way should it face?', { exact: true })).toBeVisible({
        timeout: 60_000,
    })
    await expect(page.getByRole('progressbar', { name: 'Question 1 of 1', exact: true })).toBeVisible()
    await expect(page.getByText('The manual says: Arrow is not visible in the photo.', { exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Start building', exact: true })).toHaveCount(0)
    // The default card is the picture, the question and Let me fix it: no form until that is tapped.
    await expect(page.getByRole('button', { name: 'Let me fix it', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Save', exact: true })).toHaveCount(0)
    await page.getByRole('button', { name: 'Let me fix it', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeVisible()
})

test('a cancelled reading says that nothing more is shown, and the reading is not repeated automatically', async ({
    page,
    context,
}) => {
    test.skip(SCENARIO !== 'reversed', 'latency path needs one scenario only')
    await openFreshLibrary(page)
    await page.getByRole('button', { name: 'Add manual', exact: true }).click()
    const chooser = page.waitForEvent('filechooser')
    await page.getByRole('button', { name: 'Choose pages from photos', exact: true }).click()
    await (await chooser).setFiles([{ name: 'page-1.png', mimeType: 'image/png', buffer: png }])
    await expect(page.getByText('Page 1', { exact: true })).toBeVisible()
    const cdp = await context.newCDPSession(page)
    await cdp.send('Network.enable')
    await cdp.send('Network.emulateNetworkConditions', {
        offline: false,
        latency: 6000,
        downloadThroughput: -1,
        uploadThroughput: -1,
    })
    await page.getByRole('button', { name: 'Read my manual', exact: true }).click()
    await expect(page.getByText('Reading your manual. This can take a minute.', { exact: true })).toBeVisible()
    // Cancel asks first, then stops the same request the old Cancel did and returns to the pages.
    await page.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(page.getByText('Stop reading? You can start again.', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Stop reading', exact: true }).click()
    // Home stays mounted under Add and reads the same notice, so the screen on top is the last match.
    await expect(page.getByText('Stopped, so nothing more will be shown.', { exact: true }).last()).toBeVisible()
    await expect(page.getByRole('button', { name: 'Read my manual', exact: true })).toBeVisible()
    await cdp.send('Network.emulateNetworkConditions', {
        offline: false,
        latency: 0,
        downloadThroughput: -1,
        uploadThroughput: -1,
    })
    await expect(page.getByText('Thanks. Your steps are ready.', { exact: true })).toHaveCount(0)
})

test('camera access is requested only on demand: without permission the screen explains it and returns to the pages', async ({
    page,
    context,
}) => {
    await context.clearPermissions()
    await openFreshLibrary(page)
    await page.getByRole('button', { name: 'Add manual', exact: true }).click()
    await page.getByRole('button', { name: 'Take photo', exact: true }).click()
    await expect(
        page.getByText('We need the camera for photos of your manual and work.', { exact: true }),
    ).toBeVisible()
    await page.getByRole('button', { name: 'Go back', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Choose pages from photos', exact: true })).toBeVisible()
})

test('a local library that cannot be read keeps its data, says so, and offers an explicit retry', async ({ page }) => {
    await page.addInitScript(() => {
        const probe = { reads: 0, writes: 0 }
        Object.defineProperty(window, '__truebuildStorageProbe', { value: probe })
        const originalSet = Storage.prototype.setItem
        Storage.prototype.setItem = function (key: string, value: string): void {
            if (String(key).startsWith('truebuild/')) {
                probe.writes += 1
            }
            originalSet.call(this, key, value)
        }
        const original = Storage.prototype.getItem
        Storage.prototype.getItem = function (key: string): string | null {
            if (String(key).startsWith('truebuild/')) {
                probe.reads += 1
                throw new Error('storage unavailable (test fault injection)')
            }
            return original.call(this, key)
        }
    })
    await page.goto('/')
    await expect(page.getByText('Saving is paused until your saved builds open again.', { exact: true })).toBeVisible({
        timeout: 60_000,
    })
    const retry = page.getByRole('button', { name: 'Try again', exact: true })
    await expect(retry).toHaveCount(1)
    await expect(page.getByTestId('bottom-bar').getByRole('button', { name: 'Try again', exact: true })).toBeVisible()
    const writeCount = (): Promise<number> =>
        page.evaluate(
            () => (window as unknown as { __truebuildStorageProbe: { writes: number } }).__truebuildStorageProbe.writes,
        )
    expect(await writeCount()).toBe(0)
    const readCount = (): Promise<number> =>
        page.evaluate(
            () => (window as unknown as { __truebuildStorageProbe: { reads: number } }).__truebuildStorageProbe.reads,
        )
    const readsBeforeRetry = await readCount()
    await retry.click()
    await expect(retry).toBeEnabled()
    expect(await readCount()).toBeGreaterThan(readsBeforeRetry)
    expect(await writeCount()).toBe(0)
})

test('More on Home describes storage, what leaves the phone and camera access', async ({ page }) => {
    await openFreshLibrary(page)
    await page.getByRole('button', { name: 'More', exact: true }).click()
    await expect(page.getByText('What leaves this phone', { exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Open device settings', exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Close sheet', exact: true }).click()
    await expect(page.getByText('Build furniture with step-by-step help.', { exact: true })).toBeVisible()
})

test('keyboard focus is visible on a control on web', async ({ page }) => {
    await openFreshLibrary(page)
    const add = page.getByRole('button', { name: 'Add manual', exact: true })
    await add.focus()
    const shadow = await add.evaluate((element) => getComputedStyle(element).boxShadow)
    expect(shadow).toContain('0, 87, 194')
})

if (SECOND_OPINION !== undefined) {
    test(`second opinion: ${SECOND_OPINION} retains primary until the separate HTTP request finishes`, async ({
        page,
    }) => {
        test.setTimeout(90_000)
        await openFreshLibrary(page)
        await addTwoPagesAndRead(page)
        await startBuilding(page)
        const paths: string[] = []
        page.on('request', (request) => {
            if (request.method() === 'POST' && request.url().startsWith(`${API}/api/checks`)) {
                paths.push(new URL(request.url()).pathname)
            }
        })
        await page.getByTestId('guide-primary').click()
        const capture = page.getByRole('button', { name: 'Capture photo', exact: true })
        await expect(capture).toBeEnabled({ timeout: 60_000 })
        const primaryResponse = page.waitForResponse(
            (response) => response.url() === `${API}/api/checks` && response.request().method() === 'POST',
        )
        let secondaryFinished = false
        const secondaryResponse = page.waitForResponse(
            (response) =>
                response.url() === `${API}/api/checks/second-opinion` && response.request().method() === 'POST',
        )
        void secondaryResponse.then(() => {
            secondaryFinished = true
        })
        await capture.click()
        const primary = apiResultSchema(checkResultSchema).parse(await (await primaryResponse).json())
        expect(primary).toMatchObject({
            status: 'ok',
            value: {
                decision: 'cannot_verify',
                model: 'muse-spark-1.3',
                secondOpinion: { status: 'available', model: 'muse-wonder-1.0' },
            },
        })
        if (Number(process.env.TRUEBUILD_E2E_SECOND_OPINION_DELAY_MS ?? 0) >= 9_000) {
            await expect(page.getByText(/^We can't tell from this photo\./u)).toBeVisible()
            await expect(page.getByText('Taking a second look…', { exact: true })).toBeVisible()
            // The primary result is kept; Cancel and the model details are in More.
            await openMore(page)
            await expect(page.getByText('Can’t tell', { exact: true })).toBeVisible()
            await expect(page.getByRole('button', { name: 'Cancel', exact: true })).toBeVisible()
            await page.getByTestId('judge-entry').click()
            await expect(page.getByText('Model: muse-spark-1.3', { exact: true })).toBeVisible()
            expect(secondaryFinished).toBe(false)
            await page.getByRole('button', { name: 'Close sheet', exact: true }).click()
        }
        const response = await secondaryResponse
        expect(response.status()).toBe(200)
        const secondary = apiResultSchema(checkResultSchema).parse(await response.json())
        expect(secondary.requestId).toBe(primary.requestId)
        expect(secondary.binding).toEqual(primary.binding)
        const refused = SECOND_OPINION === 'reversed'
        expect(secondary).toMatchObject({
            status: 'ok',
            value: {
                decision: refused ? 'refuse' : 'cannot_verify',
                model: refused ? 'muse-wonder-1.0' : 'muse-spark-1.3',
                secondOpinion: {
                    model: 'muse-wonder-1.0',
                    status: SECOND_OPINION === 'failed' ? 'unavailable' : 'completed',
                },
            },
        })
        await expect(page.getByText(refused ? /^Not yet\./u : /^We can't tell from this photo\./u)).toBeVisible()
        await expect(page.getByText(/^Looks right\./u)).toHaveCount(0)
        await expect(page.getByText('Taking a second look…', { exact: true })).toHaveCount(0)
        await openMore(page)
        await expect(page.getByText('Looks right', { exact: true })).toHaveCount(0)
        await page.getByTestId('judge-entry').click()
        if (secondary.status === 'ok') {
            await expect(page.getByText(`Model: ${secondary.value.model}`, { exact: true })).toBeVisible()
            for (const note of secondary.value.modelNotes ?? []) {
                await expect(page.getByText(`Model note: ${note}`, { exact: true })).toBeVisible()
            }
            if (SECOND_OPINION === 'failed') {
                expect(secondary.value.modelNotes?.length).toBeGreaterThan(0)
                if (primary.status === 'ok') expect(secondary.value.reason).toBe(primary.value.reason)
            }
            if (refused) {
                expect(secondary.value.sourceRefs.length).toBeGreaterThan(0)
                await expect(page.getByText('Manual diagram', { exact: true })).toBeVisible()
                await expect(page.getByText('Your photo', { exact: true })).toBeVisible()
            }
        }
        expect(paths).toEqual(['/api/checks', '/api/checks/second-opinion'])
    })
}
