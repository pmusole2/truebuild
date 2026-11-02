import type { ReactElement } from 'react'
import { DocumentRouteBoundary } from '../src/features/documents/ownership'
import { HomeRoute } from '../src/features/capture/route-screens'

export default function IndexRoute(): ReactElement {
    return (
        <DocumentRouteBoundary>
            <HomeRoute />
        </DocumentRouteBoundary>
    )
}
