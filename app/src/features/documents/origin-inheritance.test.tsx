import { render } from '@testing-library/react-native'
import { recordedDocumentForTest } from './recorded/test-support'
import { ThemeProvider } from '../../theme/theme'
import { originId } from '../screens/render-origin'
import { DocumentRenderer } from './document-renderer'
import type { FrameBindings } from './types'
jest.mock('react-native-reanimated', () => jest.requireActual('../../ui/test-support/reanimated-mock'))
jest.mock(
    'react-native-safe-area-context',
    () => jest.requireActual<{ default: unknown }>('react-native-safe-area-context/jest/mock').default,
)
const bindings: FrameBindings = {
    resolve: () => ({ enabled: true, reason: null, run: (): void => undefined }),
    live: null,
    session: undefined,
    pageUris: {},
    capture: null,
    marks: [],
    heroMode: 'inline',
    inspect: false,
}
import { auditDocumentHosts } from '../screens/test-support/strict-origin-audit'

it.each(['recorded-home', 'recorded-add-empty', 'recorded-home-library-single', 'recorded-pages-cancelled'])(
    'audits every actual host of %s through the strict composed-marker protocol',
    async (name) => {
        const document = recordedDocumentForTest(name)
        const view = await render(
            <ThemeProvider>
                <DocumentRenderer document={document} bindings={bindings} />
            </ThemeProvider>,
        )
        const audit = auditDocumentHosts(view.toJSON(), [document])
        expect(audit.hosts.length).toBeGreaterThan(5)
        expect(audit.failures).toEqual([])
        expect(audit.counts.total).toBe(audit.counts.generated + audit.counts.fallback + audit.counts.shell)
        // Source remains exactly what the validated document recorded; explicit shell/fallback exceptions remain visible.
        expect(audit.hosts.filter((host) => host.origin === null)).toEqual([])
    },
)
it('origin segment protocol joins with | and parses back', () => {
    expect(originId('generated')).toBe('truebuild-render-origin:generated')
})
