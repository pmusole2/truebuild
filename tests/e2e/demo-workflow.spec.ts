import { expect, test } from '@playwright/test'

const API = process.env.TRUEBUILD_E2E_API_ORIGIN ?? 'http://127.0.0.1:31071'
const KEY = 'truebuild-fixture-demo'

test('parse action calls the fixture parse route and labels the result simulated', async ({ page }) => {
    const parseRequests: string[] = []
    page.on('request', (request): void => {
        if (request.url() === `${API}/api/manuals/parse` && request.method() === 'POST') {
            parseRequests.push(request.headers()['x-truebuild-key'] ?? '')
        }
    })
    await page.goto('/')
    await expect(page.getByText('Demo data — simulated results', { exact: false })).toBeVisible()
    await page.getByRole('button', { name: 'Photograph a manual', exact: true }).click()
    await expect(page.getByText('Simulated parse result', { exact: true })).toBeVisible()
    await expect(page.getByText('Your photo was not analysed.', { exact: false })).toBeVisible()
    expect(parseRequests).toEqual([KEY])
})

test('hero panel is refused with the actual cited image, a fresh correct photo passes, and an unclear photo cannot verify', async ({
    page,
}) => {
    await page.goto('/')
    await page.getByRole('button', { name: 'Photograph a manual', exact: true }).click()
    await expect(page.getByText('Simulated parse result', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Confirm expected facts', exact: true }).click()
    await expect(page.getByText('Plan confirmed.', { exact: false })).toBeVisible()
    await page.getByRole('button', { name: 'Simulated reversed panel', exact: true }).click()
    await expect(page.getByText('Refuse', { exact: true })).toBeVisible()
    await expect(page.getByRole('img', { name: 'Cited manual page' })).toBeVisible()

    await page.getByRole('button', { name: 'Simulated correct photo', exact: true }).click()
    await expect(page.getByText('Pass', { exact: true })).toBeVisible()
    await expect(page.getByText('Refuse', { exact: true })).toHaveCount(0)

    await page.getByRole('button', { name: 'Simulated unclear photo', exact: true }).click()
    await expect(page.getByText('Cannot verify', { exact: true })).toBeVisible()
    await expect(page.getByText('Pass', { exact: true })).toHaveCount(0)
})

test('Ask is visible and frozen SAM results reset on a new photo', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByRole('button', { name: 'Ask question', exact: true })).toBeVisible()

    await page.getByRole('button', { name: 'Simulated correct photo', exact: true }).click()
    await page.getByRole('button', { name: 'Ask about part Side panel', exact: true }).click()
    await page.getByLabel('Question about this step').fill('Which way should this part face?')
    await page.getByRole('button', { name: 'Ask question', exact: true }).click()
    await expect(page.getByText('Answer', { exact: true })).toBeVisible()
    await expect(page.getByText('Demo data — simulated results', { exact: false }).first()).toBeVisible()

    await page.getByLabel('Part to find in the photo').fill('side panel')
    await page.getByRole('button', { name: 'Find part in photo', exact: true }).click()
    await expect(page.getByText('Found 1 region in this frozen photo.', { exact: true })).toBeVisible()

    await page.getByRole('button', { name: 'Simulated correct photo', exact: true }).click()
    await expect(page.getByText('Found 1 region in this frozen photo.', { exact: true })).toHaveCount(0)
    await expect(page.getByText('Finds the named part in this one frozen photo.', { exact: false })).toBeVisible()
})

test('the direct demo has no manual editor, library, import or custody screens', async ({ page }) => {
    await page.goto('/')
    for (const name of ['Edit manual', 'Import pages', 'Library', 'Mark reviewed', 'Save manual', 'Open step check']) {
        await expect(page.getByRole('button', { name, exact: true })).toHaveCount(0)
    }
})

test('fixture API preserves simulated decisions when called with the shared key', async ({ request }) => {
    const binding = {
        kind: 'capture',
        manualId: 'demo-divider',
        revision: 1,
        stepId: 'step-1',
        captureId: 'browser-capture-1',
    }

    for (const [scenario, decision] of [
        ['wrong', 'refuse'],
        ['correct', 'pass'],
        ['unclear', 'cannot_verify'],
    ]) {
        const response = await request.post(`${API}/api/checks`, {
            headers: { 'x-truebuild-key': KEY },
            data: { mode: 'fixture', requestId: `browser-${scenario}`, binding, scenario },
        })

        expect(response.ok()).toBe(true)
        expect(await response.json()).toMatchObject({
            status: 'ok',
            mode: 'fixture',
            binding,
            value: { decision, reason: expect.stringContaining('Demo data — simulated results') },
        })
    }
})
