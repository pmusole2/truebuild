import type { ReactElement } from 'react'
import { DocumentRouteBoundary } from '../../src/features/documents/ownership'
import { DoneRoute } from '../../src/features/capture/route-screens'

export default function Route(): ReactElement {
    return (
        <DocumentRouteBoundary>
            <DoneRoute />
        </DocumentRouteBoundary>
    )
}
