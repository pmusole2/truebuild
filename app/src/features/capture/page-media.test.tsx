import { render, screen } from '@testing-library/react-native'
import { Platform } from 'react-native'
import type { JsonElement } from 'test-renderer'
import { inlineSvgXml, ManualImage } from './page-media'

jest.mock('react-native-reanimated', () => jest.requireActual('../../ui/test-support/reanimated-mock'))

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>'
const SVG_URI = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(SVG)}`
const nativeIds = (node: JsonElement | string | null): string[] =>
    typeof node !== 'object' || node === null
        ? []
        : [
              ...(typeof node.props.nativeID === 'string' ? [node.props.nativeID] : []),
              ...node.children.flatMap(nativeIds),
          ]

describe('inlineSvgXml', () => {
    it('decodes only inline SVG data URIs', () => {
        expect(inlineSvgXml(SVG_URI)).toBe(SVG)
        expect(inlineSvgXml('data:image/png;base64,AAAA')).toBeNull()
        expect(inlineSvgXml('file:///page.jpg')).toBeNull()
        expect(inlineSvgXml('data:image/svg+xml;charset=utf-8,%E0%A4%A')).toBeNull()
    })
})

// React Native's own Image cannot decode SVG on iOS or Android, which left the synthetic fixture diagrams blank there.
describe('ManualImage', () => {
    it('draws an SVG fixture through react-native-svg on native, with its label', async () => {
        const view = await render(<ManualImage uri={SVG_URI} label="Expected diagram page 1" />)
        expect(screen.getByLabelText('Expected diagram page 1')).toBeTruthy()
        // The accessible element is the wrapper View, not an Image with a source.
        expect(screen.getByLabelText('Expected diagram page 1').props.source).toBeUndefined()
        expect(screen.getByLabelText('Expected diagram page 1').props.nativeID).toBeUndefined()
        expect(
            nativeIds(view.toJSON()).filter((id) => id === 'truebuild-capability-internals:ManualPage'),
        ).toHaveLength(1)
    })

    it('keeps raster pages on Image', async () => {
        await render(<ManualImage uri="data:image/png;base64,AAAA" label="Manual page 1" />)
        expect(screen.getByLabelText('Manual page 1').props.source).toEqual({ uri: 'data:image/png;base64,AAAA' })
        expect(screen.getByLabelText('Manual page 1').props.nativeID).toBe('truebuild-capability-internals:ManualPage')
    })

    it('leaves SVG to the browser Image on web', async () => {
        const platform = jest.replaceProperty(Platform, 'OS', 'web')
        try {
            await render(<ManualImage uri={SVG_URI} label="Expected diagram page 1" />)
            expect(screen.getByLabelText('Expected diagram page 1').props.source).toEqual({ uri: SVG_URI })
        } finally {
            platform.restore()
        }
    })
})
