import { describe, expect, it } from '@jest/globals'
import { render, screen } from '@testing-library/react-native'
import { darkColors, lightColors } from '../theme/tokens'
import { ThemeProvider } from '../theme/theme'
import { Notice, StatusTag, VerdictTag, type Verdict } from './status'

const VERDICT_LABELS: readonly (readonly [Verdict, string])[] = [
    ['pass', 'Pass'],
    ['refuse', 'Refuse'],
    ['cannot_verify', 'Cannot verify'],
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
        expect(screen.getByText('Pass')).toHaveStyle({ color: lightColors.pass })
        expect(screen.getByText('Refuse')).toHaveStyle({ color: lightColors.refuse })
    })

    it('the simulated tone reads as a strong, labelled stamp in dark mode too', async () => {
        await render(
            <ThemeProvider scheme="dark">
                <StatusTag label="Simulated result" tone="simulated" icon="info" />
            </ThemeProvider>,
        )
        expect(screen.getByText('Simulated result')).toHaveStyle({ color: darkColors.fillStrongInk })
    })
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
