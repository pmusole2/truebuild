import type { ReactElement } from 'react'
import { DocumentRouteBoundary } from '../src/features/documents/ownership'
import { CompareScreen } from '../src/features/screens/compare'

// Judge-only comparison of two parsed manuals, reached from About this check in More.
export default function CompareRoute(): ReactElement {
    return (
        <DocumentRouteBoundary>
            <CompareScreen />
        </DocumentRouteBoundary>
    )
}
