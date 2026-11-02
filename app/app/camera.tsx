import type { ReactElement } from 'react'
import { DocumentRouteBoundary } from '../src/features/documents/ownership'
import { CameraRoute } from '../src/features/capture/route-screens'

export default function Route(): ReactElement {
    return (
        <DocumentRouteBoundary>
            <CameraRoute />
        </DocumentRouteBoundary>
    )
}
