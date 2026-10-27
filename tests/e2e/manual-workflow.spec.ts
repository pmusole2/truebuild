import { Buffer } from 'node:buffer'
import { expect, test, type Page, type Response } from '@playwright/test'
import { apiResultSchema, checkResultSchema } from '@truebuild/contracts'

// Real product path: the browser file chooser and normalizer, the app client, the Hono API and the documented Meta HTTP
// mock. Nothing here intercepts or answers an API request; responses are read from the real network.
const API = process.env.TRUEBUILD_E2E_API_ORIGIN ?? 'http://127.0.0.1:31071'
const WEB = `http://localhost:${process.env.TRUEBUILD_E2E_WEB_PORT ?? '18071'}`
const SCENARIO = process.env.TRUEBUILD_E2E_SCENARIO ?? 'reversed'
const SECOND_OPINION = process.env.TRUEBUILD_E2E_SECOND_OPINION
const VERDICT: Record<string, string> = { correct: 'Pass', reversed: 'Refuse', uncertain: 'Cannot verify' }
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
    await expect(page.getByText('No manuals yet.', { exact: true })).toBeVisible({ timeout: 60_000 })
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
    await page.getByRole('button', { name: 'Move page 2 up', exact: true }).click()
    const parse = page.waitForResponse(
        (response) => response.url() === `${API}/api/manuals/parse` && response.request().method() === 'POST',
    )
    await page.getByRole('button', { name: 'Read manual', exact: true }).click()
    return parse
}

async function confirmFactsAndContinue(page: Page): Promise<void> {
    await expect(page.getByRole('checkbox')).toBeVisible({ timeout: 120_000 })
    await page.getByRole('checkbox').click()
    await page.getByRole('button', { name: 'Confirm reviewed facts', exact: true }).click()
    await expect(page.getByText('Facts confirmed by you.', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Continue assembly', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Take new photo and check', exact: true })).toBeVisible()
}

test('real path: pages are read by the API, facts are confirmed, the library restores after reload, and a check returns the scenario verdict', async ({
    page,
}) => {
    await openFreshLibrary(page)
    const parse = await addTwoPagesAndRead(page)
    expect((await parse).status()).toBe(200)
    await confirmFactsAndContinue(page)

    await page.reload()
    await page.getByRole('button', { name: 'Open Untitled manual', exact: true }).click()
    await expect(page.getByText('Facts confirmed by you.', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Continue assembly', exact: true }).click()

    await page.getByRole('button', { name: 'Take new photo and check', exact: true }).click()
    const capture = page.getByRole('button', { name: 'Capture photo', exact: true })
    await expect(capture).toBeEnabled({ timeout: 60_000 })
    const check = page.waitForResponse(
        (response) => response.url() === `${API}/api/checks` && response.request().method() === 'POST',
    )
    await capture.click()
    const response = await check
    expect(response.status()).toBe(200)
    const body = (await response.json()) as { status: string; value: { decision: string } }
    expect(body.status).toBe('ok')
    expect(body.value.decision).toBe(DECISION[SCENARIO])
    await expect(page.getByText(VERDICT[SCENARIO] ?? '', { exact: true })).toBeVisible({ timeout: 90_000 })
})

test('refusal shows the expected diagram and the frozen photo side by side, and a question is requested from the API', async ({
    page,
}) => {
    test.skip(SCENARIO !== 'reversed', 'refusal layout is scenario-specific')
    await openFreshLibrary(page)
    await addTwoPagesAndRead(page)
    await confirmFactsAndContinue(page)
    await page.getByRole('button', { name: 'Take new photo and check', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Capture photo', exact: true })).toBeEnabled({ timeout: 60_000 })
    await page.getByRole('button', { name: 'Capture photo', exact: true }).click()
    await expect(page.getByText('Manual diagram', { exact: true })).toBeVisible({ timeout: 90_000 })
    await expect(page.getByText('Your photo', { exact: true })).toBeVisible()
    await expect(page.getByText('Refuse', { exact: true })).toBeVisible()

    // A point chosen on the refused photo itself, without retaking it, is a valid question target.
    await page.getByRole('button', { name: 'Your photo: tap a point to ask about it', exact: true }).click()
    await expect(page.getByText('Selected point in photo.', { exact: true })).toBeVisible()
    await page.getByLabel('Question about frozen photo').fill('Which way should this part face?')
    const question = page.waitForResponse(
        (response) => response.url() === `${API}/api/questions` && response.request().method() === 'POST',
    )
    await page.getByRole('button', { name: 'Send question', exact: true }).click()
    expect((await question).status()).toBe(200)
    await expect(page.getByText('TEST MOCK ONLY: consult the cited diagram.', { exact: false })).toBeVisible({
        timeout: 60_000,
    })
    // The answer is neutral: the refused check stays refused and no Pass verdict appears.
    await expect(page.getByText('Answer', { exact: true })).toBeVisible()
    await expect(page.getByText('Refuse', { exact: true })).toBeVisible()
    await expect(page.getByText('Pass', { exact: true })).toHaveCount(0)
})

test('the library shows its restoring state while it loads, before any manual is listed', async ({ page }) => {
    // Development-build query parameter: delays only the first restore, so the loading state is observable.
    await page.goto('/?truebuildTestRestoreDelayMs=3000')
    await expect(page.getByText('Restoring local library…', { exact: true })).toBeVisible({ timeout: 60_000 })
    await expect(page.getByText('No manuals yet.', { exact: true })).toBeVisible({ timeout: 60_000 })
})

test('an unknown critical fact is listed and blocks confirmation until the facts are resolved', async ({ page }) => {
    await openFreshLibrary(page)
    const parse = await addTwoPagesAndRead(page)
    expect((await parse).status()).toBe(200)
    await expect(page.getByRole('checkbox')).toBeVisible({ timeout: 120_000 })
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
    await page.reload()
    await page.getByRole('button', { name: 'Open Untitled manual', exact: true }).click()
    await expect(
        page.getByText('Unresolved critical fact: Step 1 orientation: Arrow is not visible in the photo.'),
    ).toBeVisible()
    await expect(page.getByRole('checkbox')).toBeDisabled()
    await expect(page.getByRole('button', { name: 'Confirm reviewed facts', exact: true })).toBeDisabled()
})

test('a cancelled reading says that no late reply is shown, and the reading is not repeated automatically', async ({
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
    await page.getByRole('button', { name: 'Read manual', exact: true }).click()
    await expect(page.getByText('Reading manual pages…', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(page.getByText('Cancelled. No late reply will be shown', { exact: false })).toBeVisible()
    await cdp.send('Network.emulateNetworkConditions', {
        offline: false,
        latency: 0,
        downloadThroughput: -1,
        uploadThroughput: -1,
    })
    await expect(page.getByRole('checkbox')).toHaveCount(0)
})

test('camera access is requested only on demand: without permission the page explains it and returns to the library', async ({
    page,
    context,
}) => {
    await context.clearPermissions()
    await openFreshLibrary(page)
    await page.getByRole('button', { name: 'Add manual', exact: true }).click()
    await page.getByRole('button', { name: 'Scan a page', exact: true }).click()
    await expect(page.getByText('Camera permission is needed', { exact: false })).toBeVisible()
    await page.getByRole('button', { name: 'Back', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Choose pages from photos', exact: true })).toBeVisible()
})

test('a local library that cannot be read keeps its data, says so, and offers an explicit retry', async ({ page }) => {
    await page.addInitScript(() => {
        const original = Storage.prototype.getItem
        Storage.prototype.getItem = function (key: string): string | null {
            if (String(key).startsWith('truebuild/')) {
                throw new Error('storage unavailable (test fault injection)')
            }
            return original.call(this, key)
        }
    })
    await page.goto('/')
    await expect(page.getByText('Saved library unavailable', { exact: true })).toBeVisible({ timeout: 60_000 })
    await expect(page.getByRole('button', { name: 'Retry local library', exact: true })).toBeVisible()
})

test('settings describe storage, what leaves the phone and camera access', async ({ page }) => {
    await openFreshLibrary(page)
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    await expect(page.getByText('What leaves this phone', { exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Open device settings', exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Back', exact: true }).click()
    await expect(page.getByText('No manuals yet.', { exact: true })).toBeVisible()
})

test('keyboard focus is visible on a control on web', async ({ page }) => {
    await openFreshLibrary(page)
    const add = page.getByRole('button', { name: 'Add manual', exact: true })
    await add.focus()
    const shadow = await add.evaluate((element) => getComputedStyle(element).boxShadow)
    expect(shadow).toContain('154, 75, 7')
})

if (SECOND_OPINION !== undefined) {
    test(`second opinion: ${SECOND_OPINION} retains primary until the separate HTTP request finishes`, async ({
        page,
    }) => {
        test.setTimeout(90_000)
        await openFreshLibrary(page)
        await addTwoPagesAndRead(page)
        await confirmFactsAndContinue(page)
        const paths: string[] = []
        page.on('request', (request) => {
            if (request.method() === 'POST' && request.url().startsWith(`${API}/api/checks`)) {
                paths.push(new URL(request.url()).pathname)
            }
        })
        await page.getByRole('button', { name: 'Take new photo and check', exact: true }).click()
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
            await expect(page.getByText('Cannot verify', { exact: true })).toBeVisible()
            await expect(page.getByText('Model: muse-spark-1.3', { exact: true })).toBeVisible()
            await expect(page.getByText('Second opinion pending (muse-wonder-1.0)…', { exact: true })).toBeVisible()
            await expect(page.getByRole('button', { name: 'Cancel', exact: true })).toBeVisible()
            expect(secondaryFinished).toBe(false)
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
        await expect(page.getByText(refused ? 'Refuse' : 'Cannot verify', { exact: true })).toBeVisible()
        await expect(page.getByText('Pass', { exact: true })).toHaveCount(0)
        await expect(page.getByText('Second opinion pending (muse-wonder-1.0)…', { exact: true })).toHaveCount(0)
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
