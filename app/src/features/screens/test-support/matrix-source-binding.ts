import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
const involved = [
    'app/src/features/screens/coverage-matrix.test.tsx',
    'app/src/features/documents/origin-inheritance.test.tsx',
    'app/src/features/screens/test-support/strict-origin-audit.ts',
    'app/src/features/screens/test-support/strict-origin-audit.test.ts',
    'app/src/features/screens/test-support/rendered-documents.ts',
    'app/src/features/screens/test-support/matrix-source-binding.ts',
    'app/src/features/screens/test-support/catalog-origin-fixtures.tsx',
    'app/src/features/screens/test-support/fixture-server.ts',
    'app/src/features/screens/test-support/flow.tsx',
    'app/src/features/screens/test-support/route-harness.ts',
    'app/src/features/capture/document-surface.tsx',
    'app/src/features/capture/document-inputs.ts',
    'app/src/features/capture/route-screens.tsx',
    'app/src/features/capture/screen-layout.tsx',
    'app/src/features/document-runtime/store.ts',
    'app/src/features/document-runtime/use-document.ts',
    'app/src/features/document-runtime/recorded-runtime.ts',
    'app/src/features/documents/native-document.tsx',
    'app/src/features/documents/document-renderer.tsx',
    'app/src/features/documents/ownership.tsx',
    'app/src/features/onboarding/coach-root.tsx',
    'app/src/features/onboarding/coach-provider.tsx',
    'app/src/features/onboarding/coach-types.ts',
    'app/src/features/onboarding/coach-overlay.tsx',
    'app/src/ui/sheet.tsx',
    'app/src/ui/meter-roots.tsx',
    'app/src/ui/render-origin.tsx',
    'app/src/ui/native-meter-markers.ts',
    'packages/contracts/src/document-v2.ts',
    'packages/contracts/src/document-v2-assemble.ts',
    'packages/contracts/src/document-v2-fallback.ts',
    'packages/contracts/src/document-v2-verify.ts',
    'packages/contracts/src/document-v2-rebind.ts',
    'packages/contracts/src/document-v2-recorded.ts',
] as const
export function matrixSourceBinding(): {
    readonly at: string
    readonly head: string
    readonly files: Readonly<Record<string, string>>
} {
    const root = resolve(__dirname, '../../../../..')
    return {
        at: execFileSync('/bin/date', ['-u', '+%Y-%m-%dT%H:%M:%SZ'], { encoding: 'utf8' }).trim(),
        head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
        files: Object.fromEntries(
            [
                ...involved,
                ...readdirSync(resolve(root, 'app/src/features/documents/recorded'))
                    .filter((name) => name.endsWith('.json'))
                    .sort()
                    .map((name) => `app/src/features/documents/recorded/${name}`),
            ].map((path) => [
                path,
                createHash('sha256')
                    .update(readFileSync(resolve(root, path)))
                    .digest('hex'),
            ]),
        ),
    }
}
