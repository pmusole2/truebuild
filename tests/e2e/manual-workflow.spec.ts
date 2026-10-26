import { expect, test } from '@playwright/test'

test('demo check, correction and recheck stay explicitly simulated', async ({ page }) => {
    const dispatchedChecks: string[] = []
    page.on('request', (request): void => {
        if (request.url() === 'http://127.0.0.1:3001/api/checks' && request.method() === 'POST') {
            dispatchedChecks.push(request.url())
        }
    })
    await page.goto('/')
    await page.getByRole('button', { name: 'Open Demo data — simulated results', exact: true }).click()
    await page.getByRole('button', { name: 'Step 2: Seat the divider in the groove', exact: true }).click()
    await page.getByRole('button', { name: 'Open step check', exact: true }).click()
    await page.getByRole('radio', { name: 'Wrong', exact: true }).click()
    await page.getByRole('button', { name: 'Run check', exact: true }).click()
    await expect(page.getByText('Refuse (simulated)', { exact: true })).toBeVisible()
    const resultPanel = page.getByRole('heading', { name: 'Result', exact: true }).locator('..')
    await expect(resultPanel.getByText('Demo data — simulated results', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Mark correction applied', exact: true }).click()
    await expect(page.getByText('Refuse (simulated)', { exact: true })).toHaveCount(0)
    await page.getByRole('radio', { name: 'Correct', exact: true }).click()
    await page.getByRole('button', { name: 'Run check', exact: true }).click()
    await expect(page.getByText('Pass (simulated)', { exact: true })).toBeVisible()
    await page.getByRole('radio', { name: 'Unclear', exact: true }).click()
    await expect(page.getByText('Pass (simulated)', { exact: true })).toHaveCount(0)
    await page.getByRole('button', { name: 'Run check', exact: true }).click()
    await expect(page.getByText('Cannot verify (simulated)', { exact: true })).toBeVisible()
    await page.getByRole('radio', { name: 'Live model', exact: true }).click()
    await page.getByRole('button', { name: 'Run check', exact: true }).click()
    await expect(
        page.getByText('Live checks are not configured. No request was sent and no model was called.'),
    ).toBeVisible()
    expect(dispatchedChecks).toHaveLength(3)
    await expect(page.getByText('Pass (simulated)', { exact: true })).toHaveCount(0)
})

test('fixture API preserves simulated decisions and unavailable model mode', async ({ request }) => {
    const binding = {
        kind: 'capture',
        manualId: 'demo-divider',
        revision: 1,
        stepId: 'step-2',
        captureId: 'browser-capture-1',
    }

    for (const [scenario, decision] of [
        ['wrong', 'refuse'],
        ['correct', 'pass'],
        ['unclear', 'cannot_verify'],
    ]) {
        const response = await request.post('http://127.0.0.1:3001/api/checks', {
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

    const unavailable = await request.post('http://127.0.0.1:3001/api/checks', {
        data: { mode: 'model', requestId: 'browser-model', binding, scenario: 'correct' },
    })

    expect(await unavailable.json()).toMatchObject({ status: 'unavailable', code: 'unconfigured' })
})

test('manual pages persist as actual bytes through rename, reload and deletion', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByRole('heading', { name: 'Manual workspace' })).toBeVisible()

    const chooser = page.waitForEvent('filechooser')
    await page.getByRole('button', { name: 'Choose manual pages' }).click()
    await (
        await chooser
    ).setFiles({
        name: 'synthetic-manual.png',
        mimeType: 'image/png',
        buffer: Buffer.from(
            'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lXcAAAAASUVORK5CYII=',
            'base64',
        ),
    })

    await expect(page.getByRole('heading', { name: /Imported manual/ })).toBeVisible()
    await expect(page.getByRole('img', { name: 'Manual page', exact: true })).toBeVisible()
    await page.getByLabel('Manual title', { exact: true }).fill('Local fixture manual')
    await page.getByRole('button', { name: 'Rename', exact: true }).click()
    await page.getByLabel('New step title', { exact: true }).fill('Read the source diagram')
    await page.getByRole('button', { name: 'Add step', exact: true }).click()
    await page.getByRole('button', { name: 'Save to device', exact: true }).click()
    await expect(page.getByText(/saved on this device\./)).toBeVisible()
    await page.goBack()
    await expect(page.getByRole('button', { name: 'Open Local fixture manual', exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Open Local fixture manual', exact: true }).click()
    await expect(page).toHaveURL(/\/manual\/[^/?]+$/)
    await expect(page.getByRole('heading', { name: 'Local fixture manual', exact: true })).toBeVisible()
    await page.reload()

    await expect(page.getByRole('heading', { name: 'Local fixture manual', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Step 1: Read the source diagram', exact: true })).toBeVisible()
    await expect(page.getByRole('img', { name: 'Manual page', exact: true })).toBeVisible()
    await expect(page.getByText('Unreviewed', { exact: true }).first()).toBeVisible()
    await page.getByRole('button', { name: 'Delete manual', exact: true }).click()
    await page.getByRole('button', { name: 'Confirm delete', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Manual workspace' })).toBeVisible()
    await page.reload()
    await expect(page.getByRole('button', { name: 'Open Local fixture manual', exact: true })).toHaveCount(0)

    const counts = await page.evaluate(async (): Promise<{ sessions: number; assets: number }> => {
        return await new Promise((resolve, reject) => {
            const open = indexedDB.open('truebuild')

            open.onerror = (): void => reject(new Error('Could not inspect local persistence'))
            open.onsuccess = (): void => {
                const db = open.result
                const transaction = db.transaction(['sessions', 'assets'], 'readonly')
                const sessions = transaction.objectStore('sessions').count()
                const assets = transaction.objectStore('assets').count()

                transaction.oncomplete = (): void => {
                    db.close()
                    resolve({ sessions: sessions.result, assets: assets.result })
                }
                transaction.onerror = (): void => reject(new Error('Could not inspect local persistence'))
            }
        })
    })

    expect(counts).toEqual({ sessions: 0, assets: 0 })
})
