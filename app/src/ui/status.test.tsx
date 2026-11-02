import { describe, expect, it } from '@jest/globals'
import { render, screen } from '@testing-library/react-native'
import { contrastRatio } from '../theme/contrast'
import { darkColors, lightColors } from '../theme/tokens'
import { ThemeProvider } from '../theme/theme'
import { Notice, StatusTag, VerdictTag, type Verdict } from './status'

const VERDICT_LABELS: readonly (readonly [Verdict, string])[] = [
    ['pass', 'Looks right'],
    ['refuse', 'Not yet'],
    ['cannot_verify', 'Can’t tell'],
]

describe('verdict tags', () => {
    it.each(VERDICT_LABELS)('%s is named by its text label, not by colour alone', async (verdict, label) => {
        await render(<VerdictTag verdict={verdict} />)
        expect(screen.getByText(label)).toBeTruthy()
    })

    it('a refusal and a pass use different tones', async () => {
        await render(
            <>
                <VerdictTag verdict="pass" />
                <VerdictTag verdict="refuse" />
            </>,
        )
        expect(screen.getByText('Looks right')).toHaveStyle({ color: lightColors.pass })
        expect(screen.getByText('Not yet')).toHaveStyle({ color: lightColors.refuse })
    })

    it.each([
        ['light', lightColors],
        ['dark', darkColors],
    ] as const)(
        'the simulated tone is a readable labelled marker that does not outshine a verdict in %s',
        async (scheme, colors) => {
            await render(
                <ThemeProvider scheme={scheme}>
                    <StatusTag label="Simulated result" tone="simulated" icon="info" />
                    <VerdictTag verdict="pass" />
                </ThemeProvider>,
            )
            // Ink on the raised surface stays well above the 4.5 text threshold; the filled strong pairing is gone.
            expect(screen.getByText('Simulated result')).toHaveStyle({ color: colors.ink })
            expect(contrastRatio(colors.ink, colors.surfaceRaised)).toBeGreaterThan(7)
            expect(screen.getByText('Simulated result')).not.toHaveStyle({ color: colors.fillStrongInk })
            expect(screen.getByText('Looks right')).toHaveStyle({ color: colors.pass })
        },
    )
})

describe('notices', () => {
    it('an error notice is announced as an alert', async () => {
        await render(<Notice tone="error" text="Camera access was not allowed." />)
        expect(screen.getByRole('alert')).toBeTruthy()
    })

    it('an informational notice is read in place and does not interrupt', async () => {
        await render(<Notice text="Nothing was analysed." />)
        expect(screen.queryByRole('alert')).toBeNull()
        expect(screen.getByText('Nothing was analysed.')).toBeTruthy()
    })
})
