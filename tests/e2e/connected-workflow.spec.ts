import { expect, test, type Page } from '@playwright/test'
import { manualSessionSchema } from '@truebuild/contracts'
import sharp from 'sharp'
import { z } from 'zod'
import { ConnectedBackendFixture, SYNTHETIC_OWNER_TOKEN } from './fixtures/connected-backend'

// These are software integration checks with scripted model-shaped replies, never provider or accuracy evidence.
async function chooseImage(page: Page, label: string, color: string): Promise<void> {
    const image = await sharp({ create: { width: 64, height: 48, channels: 3, background: color } })
        .png()
        .toBuffer()
    const chooser = page.waitForEvent('filechooser')
    await page.getByRole('button', { name: label, exact: true }).click()
    await (await chooser).setFiles({ name: 'synthetic.png', mimeType: 'image/png', buffer: image })
}

async function connect(page: Page, backend: ConnectedBackendFixture): Promise<void> {
    await page.getByRole('button', { name: 'Live backend connection', exact: true }).click()
    await page.getByLabel('Owner session token', { exact: true }).fill(SYNTHETIC_OWNER_TOKEN)
    await page.getByRole('button', { name: 'Connect', exact: true }).click()
    await expect(page.getByLabel('Owner session token', { exact: true })).toHaveValue('')
    expect(backend.calls).toHaveLength(0)
    await page.getByRole('button', { name: 'Check session', exact: true }).click()
    await expect(page.getByText(/The backend reports a model key is configured/)).toBeVisible()
    expect(backend.count('session')).toBe(1)
    expect(backend.calls).toHaveLength(1)
    await page.getByRole('button', { name: 'Back to manuals', exact: true }).click()
    await expect(page).toHaveURL('http://localhost:8081/')
    await expect(page.getByRole('heading', { name: 'Manual workspace', exact: true })).toBeVisible()
}

test('an imported manual cannot extract or dispatch a model request without a connection', async ({ page }) => {
    const backend = new ConnectedBackendFixture(page)
    await backend.install()
    await page.goto('/')
    await chooseImage(page, 'Choose manual pages', '#e2dcc9')
    await expect(page.getByRole('heading', { name: /Imported manual/ })).toBeVisible()
    await page.getByRole('checkbox', { name: 'Select page 1 for extraction', exact: true }).check()
    await expect(page.getByRole('button', { name: 'Extract selected pages', exact: true })).toBeDisabled()
    expect(backend.calls).toHaveLength(0)
})

test('scripted connected workflow extracts, reviews, checks fresh captures, asks and localizes', async ({ page }) => {
    const backend = new ConnectedBackendFixture(page)
    await backend.install()
    await page.goto('/')
    await connect(page, backend)
    await chooseImage(page, 'Choose manual pages', '#e2dcc9')
    await expect(page.getByRole('heading', { name: /Imported manual/ })).toBeVisible()
    await page.getByLabel('Manual title', { exact: true }).fill('Connected software fixture')
    await page.getByRole('button', { name: 'Rename', exact: true }).click()
    await page.getByRole('checkbox', { name: 'Select page 1 for extraction', exact: true }).check()
    await page.getByRole('button', { name: 'Extract selected pages', exact: true }).click()
    await expect(page.getByText('Live model preview — not applied', { exact: true })).toBeVisible()
    expect(backend.count('parse')).toBe(1)
    expect(backend.count('check')).toBe(0)
    await page.getByRole('button', { name: 'Apply extraction preview', exact: true }).click()
    await page.getByRole('button', { name: 'Copy raw step 2 to draft', exact: true }).click()
    await page.getByRole('button', { name: /^Step \d+: Seat the divider in the groove$/ }).click()
    // A proposed model correction requires a distinct human confirmation against its source.
    await page.getByRole('button', { name: 'Mark reviewed', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Open step check', exact: true })).toBeDisabled()
    await page.getByRole('button', { name: 'Confirm correction against manual', exact: true }).click()
    await page.getByRole('button', { name: 'Mark reviewed', exact: true }).click()
    await page.getByRole('button', { name: 'Save to device', exact: true }).click()
    await expect(page.getByText(/saved on this device\./)).toBeVisible()
    const records = await page.evaluate(async (): Promise<unknown[]> => {
        return await new Promise((resolve, reject) => {
            const open = indexedDB.open('truebuild')
            open.onerror = (): void => reject(new Error('Could not read synthetic saved session'))
            open.onsuccess = (): void => {
                const db = open.result
                const transaction = db.transaction('sessions', 'readonly')
                const sessions = transaction.objectStore('sessions').getAll()
                transaction.oncomplete = (): void => {
                    db.close()
                    resolve(sessions.result)
                }
                transaction.onerror = (): void => reject(new Error('Could not read synthetic saved session'))
            }
        })
    })
    const saved = z.array(z.strictObject({ manualId: z.string(), session: manualSessionSchema })).parse(records)
    expect(saved).toHaveLength(1)
    const savedManual = saved[0]!.session
    expect(savedManual.extractionSourcePageIds).toEqual(savedManual.pages.map((item) => item.pageId))
    expect(savedManual.rawExtraction?.steps[1]?.correction?.reviewed).toBe(false)
    expect(savedManual.reviewedSteps[0]?.correction?.reviewed).toBe(true)
    await page.getByRole('button', { name: 'Open step check', exact: true }).click()
    await page.getByRole('radio', { name: 'Live model', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Run check', exact: true })).toBeDisabled()
    expect(backend.count('check')).toBe(0)

    backend.setCheckDecision('refuse')
    await chooseImage(page, 'Choose fresh photo', '#b64b38')
    await page.getByRole('button', { name: 'Run check', exact: true }).click()
    await expect(page.getByText('Refuse', { exact: true })).toBeVisible()
    const resultPanel = page.getByRole('heading', { name: 'Result', exact: true }).locator('..')
    await expect(
        resultPanel.getByText('Lift the divider and reseat its edge inside the groove.', { exact: true }),
    ).toBeVisible()
    const firstCheck = backend.calls.find((call) => call.operation === 'check')
    expect(firstCheck?.fileCounts).toEqual({ sources: 1, observations: 1, media: 0 })
    expect(firstCheck?.sourceHashes).toEqual(backend.calls.find((call) => call.operation === 'parse')?.sourceHashes)
    expect(firstCheck?.observationHash).not.toBe(firstCheck?.sourceHashes[0])

    await page.getByRole('button', { name: 'Mark correction applied', exact: true }).click()
    await expect(page.getByText('Refuse', { exact: true })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Run check', exact: true })).toBeDisabled()
    backend.setCheckDecision('pass')
    await chooseImage(page, 'Choose fresh photo', '#42745d')
    await page.getByRole('button', { name: 'Run check', exact: true }).click()
    await expect(page.getByText('Pass', { exact: true })).toBeVisible()
    const checks = backend.calls.filter((call) => call.operation === 'check')
    expect(checks).toHaveLength(2)
    expect(checks[1]?.requestId).not.toBe(checks[0]?.requestId)
    expect(checks[1]?.binding).not.toEqual(checks[0]?.binding)

    await page.getByLabel('Question about this step', { exact: true }).fill('Which way should this part face?')
    await page.getByRole('button', { name: 'Ask about part Divider shelf', exact: true }).click()
    await page.getByRole('button', { name: 'Ask question', exact: true }).click()
    await expect(
        page.getByText('Scripted browser fixture — no model called. Use the cited current-step source diagram.', {
            exact: true,
        }),
    ).toBeVisible()
    const questionPanel = page.getByRole('heading', { name: 'Ask about this step', exact: true }).locator('..')
    await expect(questionPanel.getByText('Cited: page 1', { exact: true })).toBeVisible()
    expect(backend.count('question')).toBe(1)
    expect(backend.calls.find((call) => call.operation === 'question')?.target).toMatchObject({ kind: 'part' })

    await page.getByLabel('Frozen photo of your assembly. Tap a spot to ask about it.', { exact: true }).click()
    await expect(questionPanel.getByText('Live model answer', { exact: true })).toHaveCount(0)
    await page.getByRole('button', { name: 'Ask question', exact: true }).click()
    await expect(questionPanel.getByText('Live model answer', { exact: true })).toBeVisible()
    const pointedQuestion = backend.calls.filter((call) => call.operation === 'question').at(-1)
    expect(backend.count('question')).toBe(2)
    expect(pointedQuestion?.target?.kind).toBe('point')
    if (pointedQuestion?.target?.kind !== 'point') {
        throw new Error('The scripted point question did not carry a normalized photo target')
    }
    expect(pointedQuestion.target.x).toBeCloseTo(0.5, 1)
    expect(pointedQuestion.target.y).toBeCloseTo(0.5, 1)

    await page.getByLabel('Part to find in the photo', { exact: true }).fill('divider shelf')
    await page.getByRole('button', { name: 'Find part in photo', exact: true }).click()
    await expect(page.getByText('Found 1 region in this frozen photo.', { exact: true })).toBeVisible()
    expect(backend.count('segment')).toBe(1)
    await expect(page.locator('svg rect[stroke-width="2"]:not([stroke-dasharray])')).toHaveCount(1)

    backend.setCheckDecision('cannot_verify')
    await chooseImage(page, 'Choose fresh photo', '#66717b')
    await expect(page.getByText('Pass', { exact: true })).toHaveCount(0)
    await expect(page.getByText('Live model answer', { exact: true })).toHaveCount(0)
    await expect(page.getByText('Found 1 region in this frozen photo.', { exact: true })).toHaveCount(0)
    await expect(page.locator('svg rect[stroke-width="2"]')).toHaveCount(0)
    await page.getByRole('button', { name: 'Run check', exact: true }).click()
    await expect(page.getByText('Cannot verify', { exact: true })).toBeVisible()
    expect(backend.count('check')).toBe(3)
    // A route remount must not reuse request identities against the durable backend ledger.
    await page.getByRole('button', { name: 'Back to manual', exact: true }).click()
    await page.getByRole('button', { name: 'Open step check', exact: true }).click()
    await page.getByRole('radio', { name: 'Live model', exact: true }).click()
    await chooseImage(page, 'Choose fresh photo', '#9a704a')
    await page.getByRole('button', { name: 'Run check', exact: true }).click()
    await expect(page.getByText('Cannot verify', { exact: true })).toBeVisible()
    const allChecks = backend.calls.filter((call) => call.operation === 'check')
    expect(allChecks).toHaveLength(4)
    expect(new Set(allChecks.map((call) => call.requestId)).size).toBe(4)
    expect(new Set(allChecks.map((call) => JSON.stringify(call.binding))).size).toBe(4)
})

test('owner connection stays out of persistent browser storage and is cleared by reload', async ({ page }) => {
    const backend = new ConnectedBackendFixture(page)
    await backend.install()
    await page.goto('/')
    await connect(page, backend)
    const persisted = await page.evaluate((token): boolean => {
        return [localStorage, sessionStorage].some((storage) =>
            Object.keys(storage).some((key) => (storage.getItem(key) ?? '').includes(token)),
        )
    }, SYNTHETIC_OWNER_TOKEN)
    expect(persisted).toBe(false)
    await page.reload()
    await page.getByRole('button', { name: 'Live backend connection', exact: true }).click()
    await expect(
        page.getByText('Not connected. The token is not stored anywhere; it is lost when the app reloads.', {
            exact: true,
        }),
    ).toBeVisible()
    await expect(page.getByRole('button', { name: 'Check session', exact: true })).toBeDisabled()
    expect(backend.count('session')).toBe(1)
    expect(backend.calls).toHaveLength(1)
})
