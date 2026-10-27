import { Buffer } from 'node:buffer'
import { expect, test } from '@playwright/test'
import { createDemoManual } from '@truebuild/contracts'

// Synthetic local PNG; browser image decoding/resize/storage run for real. Only the external API response is mocked.
const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jfasAAAAASUVORK5CYII=',
    'base64',
)

test('empty library creates and restores a manual, normalizes multiple pages, and requires fact confirmation', async ({
    page,
}) => {
    await page.route('http://127.0.0.1:3131/**', async (route): Promise<void> => {
        if (route.request().method() === 'OPTIONS') {
            await route.fulfill({
                status: 204,
                headers: {
                    'Access-Control-Allow-Origin': '*',
                    'Access-Control-Allow-Headers': 'x-truebuild-key,content-type',
                    'Access-Control-Allow-Methods': 'POST,OPTIONS',
                },
            })
            return
        }
        const body = route.request().postData() ?? ''
        const metadata = body.split('name="metadata"')[1]?.split('\r\n\r\n')[1]?.split('\r\n--')[0]
        const request = JSON.parse(metadata ?? '{}') as {
            requestId: string
            binding: unknown
            pages: { pageId: string }[]
        }
        const manual = createDemoManual()
        const value = JSON.parse(
            JSON.stringify({
                parts: manual.parts,
                steps: manual.reviewedSteps.map((step) => ({
                    ...step,
                    correction: step.correction === null ? null : { ...step.correction, reviewed: false },
                })),
                unknowns: [],
            }).replaceAll('demo-page-1', request.pages[0]!.pageId),
        ) as unknown
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            headers: { 'Access-Control-Allow-Origin': '*' },
            body: JSON.stringify({
                status: 'ok',
                mode: 'model',
                requestId: request.requestId,
                binding: request.binding,
                value,
            }),
        })
    })
    await page.goto('/')
    await expect(page.getByText('No manuals yet.', { exact: false })).toBeVisible()
    await expect(page.getByText('Use sample manual', { exact: false })).toHaveCount(0)
    await page.getByRole('button', { name: 'Add manual', exact: true }).click()
    const chooser = page.waitForEvent('filechooser')
    await page.getByRole('button', { name: 'Choose pages from photos', exact: true }).click()
    await (
        await chooser
    ).setFiles([
        { name: 'page1.png', mimeType: 'image/png', buffer: png },
        { name: 'page2.png', mimeType: 'image/png', buffer: png },
    ])
    await expect(page.getByText('Page 2', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Move page 2 up', exact: true }).click()
    await page.getByRole('button', { name: 'Read manual', exact: true }).click()
    await expect(page.getByRole('checkbox')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Confirm reviewed facts', exact: true })).toBeDisabled()
    await page.getByRole('checkbox').click()
    await page.getByRole('button', { name: 'Confirm reviewed facts', exact: true }).click()
    await expect(page.getByText('Facts confirmed by you.')).toBeVisible()
    await page.screenshot({ path: '/tmp/truebuild-track2-overview-390.png', fullPage: true })
    await page.reload()
    await page.getByRole('button', { name: 'Open Untitled manual', exact: true }).click()
    await expect(page.getByText('Facts confirmed by you.')).toBeVisible()
    await expect(page.getByRole('img', { name: 'Manual page 1', exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Continue assembly', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Take new photo and check', exact: true })).toBeVisible()
    await expect(page.getByText('Pass', { exact: true })).toHaveCount(0)
    await page.screenshot({ path: '/tmp/truebuild-track2-guide-390.png', fullPage: true })
})

test('camera permission denial leaves a usable route back to the manual library', async ({ page, context }) => {
    await context.clearPermissions()
    await page.goto('/')
    await page.getByRole('button', { name: 'Add manual', exact: true }).click()
    await page.getByRole('button', { name: 'Scan a page', exact: true }).click()
    await expect(page.getByText('Camera permission is needed', { exact: false })).toBeVisible()
    await page.getByRole('button', { name: 'Back', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Choose pages from photos', exact: true })).toBeVisible()
})
