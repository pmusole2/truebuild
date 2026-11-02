import type { ComponentProps, ReactElement } from 'react'
import type { NativeCapabilityType } from '../../ui/native-meter-markers'
import { NativeDocumentRenderer } from './native-document'

export const CAPABILITY_INTERNALS_NAMESPACE = 'truebuild-capability-internals'

/** Only actual native camera pixels/manual image internals may carry a strict exclusion marker. */
export function capabilityInternalsId(catalogType: NativeCapabilityType): string {
    return `${CAPABILITY_INTERNALS_NAMESPACE}:${catalogType}`
}

export type DocumentRendererProps = ComponentProps<typeof NativeDocumentRenderer>

/** The canonical v2 document remains intact through the one native renderer. */
export function DocumentRenderer(props: DocumentRendererProps): ReactElement {
    return <NativeDocumentRenderer {...props} />
}

/** Full document ownership: header, scrolling body, fixed bar and document-owned overlays. */
export function DocumentRoot(props: DocumentRendererProps): ReactElement {
    return <DocumentRenderer {...props} />
}
