import { fireEvent, render, screen } from '@testing-library/react-native'
import { createDemoManual, requiredManualFacts } from '@truebuild/contracts'
import { ThemeProvider } from '../../theme/theme'
import { View } from 'react-native'
import { FeedbackProvider } from '../../ui/feedback'
import { parseOrigin, RenderOriginProvider, type RenderOrigin } from '../../ui/render-origin'
import { Fact, MandatoryFacts } from './mandatory'
import { measureRenderOriginTree } from '../../ui/test-support/render-origin-coverage'

jest.mock('react-native-reanimated', () => jest.requireActual('../../ui/test-support/reanimated-mock'))

const session = createDemoManual()
const fact = requiredManualFacts(session, 'step-1')[0]!
it.each<RenderOrigin>(['generated', 'fallback'])('citation chrome follows its actual %s fact node', async (origin) => {
    await render(
        <ThemeProvider>
            <FeedbackProvider reduceMotion>
                <RenderOriginProvider origin={origin}>
                    <Fact fact={fact} emphasis="normal" session={session} pageUris={{}} />
                </RenderOriginProvider>
            </FeedbackProvider>
        </ThemeProvider>,
    )
    const citation = screen.getByTestId('fact-source')
    expect(parseOrigin(citation.props.nativeID)).toBe(origin)
    await fireEvent.press(citation)
    expect(parseOrigin(screen.getByTestId('fact-source-content').props.nativeID)).toBe(origin)
})

it('deterministic mandatory facts retain fallback citation chrome inside an otherwise generated document', async () => {
    await render(
        <ThemeProvider>
            <FeedbackProvider reduceMotion>
                <RenderOriginProvider origin="generated">
                    <MandatoryFacts session={session} stepId="step-1" enabled />
                </RenderOriginProvider>
            </FeedbackProvider>
        </ThemeProvider>,
    )
    for (const citation of screen.getAllByTestId('fact-source'))
        expect(parseOrigin(citation.props.nativeID)).toBe('fallback')
})

it.each([null, 'generated', 'fallback'] as const)(
    'native fact-parent origin %s remains the only inherited source without a provider',
    async (origin) => {
        const view = await render(
            <ThemeProvider>
                <FeedbackProvider reduceMotion>
                    <View nativeID={origin === null ? undefined : `truebuild-render-origin:${origin}`}>
                        <Fact fact={fact} emphasis="normal" session={session} pageUris={{}} />
                    </View>
                </FeedbackProvider>
            </ThemeProvider>,
        )
        expect(screen.getByTestId('fact-source').props.nativeID).toBeUndefined()
        const sample = measureRenderOriginTree(view.toJSON(), {
            sessionId: 'citation-parent',
            screen: 'guide',
            checkpointId: 'source',
            platform: 'ios',
            evidence: 'synthetic-fixture',
        })
        expect(sample.status).toBe('measured')
        if (sample.status !== 'measured') throw new Error('missing_fact_tree')
        expect(sample.counts[origin ?? 'shell']).toBe(sample.counts.total)
    },
)
