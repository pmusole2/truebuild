import type { TestInstance } from 'test-renderer'
import { screenDocumentV2Schema, type ScreenDocumentV2 } from '@truebuild/contracts'
import { DocumentRenderer } from '../../documents/document-renderer'
import { parseNativeMeterMarkers } from '../../../ui/native-meter-markers'

/** Test-renderer component props establish the registry; a host's self-declared id is never its own authority. */
export function renderedDocuments(container: TestInstance): readonly ScreenDocumentV2[] {
    const documents = new Map<string, ScreenDocumentV2>()
    for (const host of container.queryAll((node) => {
        try {
            return parseNativeMeterMarkers(node.props.nativeID).documentRoot !== null
        } catch {
            return false
        }
    })) {
        for (let fiber = host.unstable_fiber; fiber !== null; fiber = fiber.return) {
            if (fiber.type !== DocumentRenderer) continue
            const document = screenDocumentV2Schema.parse(fiber.memoizedProps.document)
            documents.set(document.screenId, document)
            break
        }
    }
    return [...documents.values()]
}
