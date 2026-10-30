import { screenDocumentV2Schema, type ScreenDocumentV2 } from '@truebuild/contracts'
import {
    parseNativeMeterMarkers,
    nativeMeterOriginInheritance,
    type NativeMeterMarkers,
    type NativeMeterOrigin,
} from '../../../ui/native-meter-markers'
import type { RenderOriginCounts } from '../../../ui/test-support/render-origin-coverage'

export interface AuditHostTree {
    readonly type: string
    readonly props: Readonly<Record<string, unknown>>
    readonly children: readonly (AuditHostTree | string)[]
}
export interface AuditedHost {
    readonly path: string
    readonly hostType: string
    readonly testID: string | null
    readonly owner: string | null
    readonly origin: NativeMeterOrigin | null
    readonly originSource: 'explicit-marker' | 'inherited-document-marker' | 'navigation-boundary' | null
    readonly originPath: string | null
    readonly exclusion: 'CameraView' | 'ManualPage' | null
    /** Server/fixture fallback cause when available. Explicit local shell/fallback markers do not invent a cause. */
    readonly documentFallbackReason: string | null
}
export interface HostAuditFailure {
    readonly path: string
    readonly hostType: string
    readonly reason:
        | 'invalid-marker'
        | 'unknown-document'
        | 'unowned-host'
        | 'unattributed-host'
        | 'document-source-mismatch'
        | 'invalid-capability-boundary'
}
export interface StrictHostAudit {
    readonly status: 'measured' | 'unavailable'
    readonly counts: RenderOriginCounts
    readonly rawTextCounts: RenderOriginCounts
    readonly hosts: readonly AuditedHost[]
    readonly failures: readonly HostAuditFailure[]
    readonly exclusions: Readonly<Record<'CameraView' | 'ManualPage', RenderOriginCounts>>
}
const counts = (): RenderOriginCounts => ({ generated: 0, fallback: 0, shell: 0, total: 0 })
function count(target: RenderOriginCounts, origin: NativeMeterOrigin | null): void {
    target.total++
    if (origin !== null) target[origin]++
}
const svgRoot = (type: string): boolean => /^(?:RN:)?RNSVGSvgView(?:Android)?$/u.test(type)
const svgPixels = (type: string): boolean => /^(?:RN:)?RNSVG[A-Za-z]+$/u.test(type)
const pixels = (type: string, capability: 'CameraView' | 'ManualPage'): boolean =>
    /^(?:RN:)?(?:Image|RCTImageView)$/u.test(type) ||
    (capability === 'ManualPage' ? svgRoot(type) : /^(?:RN:)?(?:CameraView|ExpoCamera|ExpoCameraView)$/u.test(type))
const navigation = (type: string): boolean => /^(?:RN:)?(?:RNSScreen.*|RNCSafeArea.*|RCTRootView|RootView)$/u.test(type)
interface State {
    readonly owner: string | null
    readonly navigationOwner: boolean
    readonly origin: NativeMeterOrigin | null
    readonly originPath: string | null
    readonly exclusion: 'CameraView' | 'ManualPage' | null
    readonly manualSvg: boolean
}
/**
 * Synthetic host membership audit, not a native meter. No default shell, source conversion, or origin-only ownership.
 * A route boundary clears inherited authority for its children. Native navigation owns only known mechanics or the
 * path leading to an actual validated document root; an arbitrary leaf cannot hide behind its ancestor marker.
 */
export function auditDocumentHosts(
    tree: AuditHostTree | null,
    documents: readonly ScreenDocumentV2[],
): StrictHostAudit {
    const registry = new Map(
        documents.map((candidate) => {
            const document = screenDocumentV2Schema.parse(candidate)
            return [document.screenId, document] as const
        }),
    )
    const markers = new Map<AuditHostTree, NativeMeterMarkers | null>()
    const leadsToDocument = new Map<AuditHostTree, boolean>()
    const failures: HostAuditFailure[] = []
    function prepare(node: AuditHostTree, path: string): boolean {
        let parsed: NativeMeterMarkers | null = null
        try {
            parsed = parseNativeMeterMarkers(node.props.nativeID)
        } catch {
            failures.push({ path, hostType: node.type, reason: 'invalid-marker' })
        }
        markers.set(node, parsed)
        const childOwns = node.children
            .map((child, index) => (typeof child === 'string' ? false : prepare(child, `${path}/${index}`)))
            .some(Boolean)
        const owns = parsed?.documentRoot != null && registry.has(parsed.documentRoot)
        leadsToDocument.set(node, owns || childOwns)
        return owns || childOwns
    }
    if (tree !== null) prepare(tree, '$')
    const resultCounts = counts(),
        rawTextCounts = counts()
    const exclusions = { CameraView: counts(), ManualPage: counts() }
    const hosts: AuditedHost[] = []
    function visit(node: AuditHostTree | string, path: string, inherited: State): void {
        if (typeof node === 'string') {
            count(rawTextCounts, inherited.origin)
            return
        }
        if (node.type === '') {
            node.children.forEach((child, index) => visit(child, `${path}/${index}`, inherited))
            return
        }
        const parsed = markers.get(node) ?? null
        const explicitOwner =
            parsed?.documentRoot ?? parsed?.documentContentBoundary ?? parsed?.documentNavigation ?? null
        const document = explicitOwner === null ? undefined : registry.get(explicitOwner)
        if (explicitOwner !== null && document === undefined)
            failures.push({ path, hostType: node.type, reason: 'unknown-document' })
        let owner = document === undefined ? inherited.owner : explicitOwner
        const navigationOwner =
            parsed?.documentRoot != null || parsed?.documentContentBoundary != null
                ? false
                : parsed?.documentNavigation != null
                  ? true
                  : inherited.navigationOwner
        if (
            navigationOwner &&
            !navigation(node.type) &&
            leadsToDocument.get(node) !== true &&
            parsed?.documentNavigation == null
        )
            owner = null
        const explicit = parsed?.origin ?? null
        const effective =
            parsed === null
                ? { origin: inherited.origin ?? 'shell', childOrigin: inherited.origin ?? 'shell' }
                : nativeMeterOriginInheritance(parsed, inherited.origin ?? 'shell')
        const origin = explicit !== null || inherited.originPath !== null ? effective.origin : null
        const originPath = explicit === null ? inherited.originPath : path
        if (
            explicitOwner !== null &&
            document !== undefined &&
            explicit === 'generated' &&
            !Object.values(document.metadata.origins).includes(explicit)
        )
            failures.push({ path, hostType: node.type, reason: 'document-source-mismatch' })
        let exclusion = inherited.exclusion
        let manualSvg = inherited.manualSvg
        if (parsed?.capability === 'CameraView' || parsed?.capability === 'ManualPage') {
            if (!pixels(node.type, parsed.capability))
                failures.push({ path, hostType: node.type, reason: 'invalid-capability-boundary' })
            else {
                exclusion = parsed.capability
                manualSvg = parsed.capability === 'ManualPage' && svgRoot(node.type)
            }
        }
        if (exclusion !== null && !(pixels(node.type, exclusion) || (manualSvg && svgPixels(node.type))))
            failures.push({ path, hostType: node.type, reason: 'invalid-capability-boundary' })
        if (exclusion === null) {
            if (owner === null) failures.push({ path, hostType: node.type, reason: 'unowned-host' })
            if (origin === null) failures.push({ path, hostType: node.type, reason: 'unattributed-host' })
            count(resultCounts, origin)
        } else count(exclusions[exclusion], origin)
        hosts.push({
            path,
            hostType: node.type,
            testID: typeof node.props.testID === 'string' ? node.props.testID : null,
            owner,
            origin,
            originSource:
                explicit !== null
                    ? 'explicit-marker'
                    : origin === null
                      ? null
                      : inherited.navigationOwner
                        ? 'navigation-boundary'
                        : 'inherited-document-marker',
            originPath,
            exclusion,
            documentFallbackReason: owner === null ? null : (registry.get(owner)?.metadata.fallbackReason ?? null),
        })
        const boundary = parsed?.documentContentBoundary != null
        const state: State = boundary
            ? { owner: null, navigationOwner: false, origin: null, originPath: null, exclusion, manualSvg }
            : {
                  owner,
                  navigationOwner,
                  origin: originPath === null ? null : effective.childOrigin,
                  originPath,
                  exclusion,
                  manualSvg,
              }
        node.children.forEach((child, index) => visit(child, `${path}/${index}`, state))
    }
    if (tree !== null)
        visit(tree, '$', {
            owner: null,
            navigationOwner: false,
            origin: null,
            originPath: null,
            exclusion: null,
            manualSvg: false,
        })
    return {
        status: failures.length === 0 ? 'measured' : 'unavailable',
        counts: resultCounts,
        rawTextCounts,
        hosts,
        failures,
        exclusions,
    }
}
