import { describe, expect, it } from 'vitest'
import { buildFallbackDocumentV2 } from '@truebuild/contracts'
import { sha256Hex } from '../../documents/sha256'
import { auditDocumentHosts, type AuditHostTree } from './strict-origin-audit'
const document = buildFallbackDocumentV2(
    { kind: 'home', session: null, stepId: null, captureId: null, result: null, failure: null },
    { sha256Hex, now: () => new Date('2026-10-30T00:00:00Z'), reason: 'disabled', evidence: 'synthetic-fixture' },
)
const host = (nativeID?: string, children: readonly (AuditHostTree | string)[] = [], type = 'View'): AuditHostTree => ({
    type,
    props: { nativeID },
    children,
})
const root = (children: readonly (AuditHostTree | string)[]): AuditHostTree =>
    host(`truebuild-document-root:${document.screenId}|truebuild-render-origin:fallback`, children)
describe('strict composed-marker host audit', () => {
    it('inherits only a declared origin under a schema-valid document and retains raw leaves separately', () => {
        const result = auditDocumentHosts(root([host(undefined, ['words'], 'Text')]), [document])
        expect(result.failures).toEqual([])
        expect(result.counts).toEqual({ generated: 0, fallback: 2, shell: 0, total: 2 })
        expect(result.rawTextCounts.fallback).toBe(1)
        expect(result.hosts[1]?.originSource).toBe('inherited-document-marker')
    })
    it('does not let an origin-only ancestor mint document ownership', () => {
        const result = auditDocumentHosts(host('truebuild-render-origin:generated', [host()]), [document])
        expect(result.failures.map((problem) => problem.reason)).toContain('unowned-host')
        expect(result.status).toBe('unavailable')
    })
    it('clears navigation inheritance at a route boundary so unrelated route content fails', () => {
        const tree = host(`truebuild-document-navigation:${document.screenId}|truebuild-render-origin:fallback`, [
            host(`truebuild-document-content-boundary:${document.screenId}|truebuild-render-origin:fallback`, [
                host(undefined, [], 'Text'),
                root([host()]),
            ]),
        ])
        const result = auditDocumentHosts(tree, [document])
        expect(result.failures).toContainEqual(expect.objectContaining({ path: '$/0/0', reason: 'unowned-host' }))
        expect(result.failures).toContainEqual(expect.objectContaining({ path: '$/0/0', reason: 'unattributed-host' }))
    })
    it.each([
        'truebuild-document-root:unknown|truebuild-render-origin:generated',
        'truebuild-render-origin:generated|truebuild-render-origin:fallback',
        'truebuild-document-root:',
    ])('rejects untrusted or invalid composed marker %s', (id) => {
        expect(auditDocumentHosts(host(id), [document]).failures.length).toBeGreaterThan(0)
    })
    it('excludes actual image/camera pixels only, still parses internals, and never excludes a marked layout View', () => {
        const good = auditDocumentHosts(
            root([
                host('truebuild-capability-internals:ManualPage', [], 'Image'),
                host('truebuild-capability-internals:CameraView', [], 'CameraView'),
            ]),
            [document],
        )
        expect(good.failures).toEqual([])
        expect(good.exclusions.ManualPage.total).toBe(1)
        expect(good.exclusions.CameraView.total).toBe(1)
        expect(good.counts.total).toBe(1)
        expect(
            auditDocumentHosts(root([host('truebuild-capability-internals:ManualPage')]), [document]).failures,
        ).toContainEqual(expect.objectContaining({ reason: 'invalid-capability-boundary' }))
        expect(
            auditDocumentHosts(
                root([
                    host(
                        'truebuild-capability-internals:ManualPage',
                        [host('truebuild-render-origin:unknown')],
                        'Image',
                    ),
                ]),
                [document],
            ).status,
        ).toBe('unavailable')
    })
    it('retains explicit shell counts and their marker path rather than coercing them to the document source', () => {
        const result = auditDocumentHosts(root([host('truebuild-render-origin:shell')]), [document])
        expect(result.failures).toEqual([])
        expect(result.counts).toEqual({ generated: 0, fallback: 1, shell: 1, total: 2 })
        expect(result.hosts[1]).toMatchObject({ origin: 'shell', originSource: 'explicit-marker', originPath: '$/0' })
    })
    it('rejects a generated marker forged onto a schema-valid fallback document identity', () => {
        const tree = host(`truebuild-document-root:${document.screenId}|truebuild-render-origin:generated`, [host()])
        expect(auditDocumentHosts(tree, [document]).failures).toContainEqual(
            expect.objectContaining({ reason: 'document-source-mismatch' }),
        )
    })
    it('does not silently turn a missing origin into shell', () => {
        const result = auditDocumentHosts(host(`truebuild-document-root:${document.screenId}`, [host()]), [document])
        expect(result.failures.map((problem) => problem.reason)).toContain('unattributed-host')
        expect(result.counts.shell).toBe(0)
    })
})
