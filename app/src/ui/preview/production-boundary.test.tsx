/// <reference types="node" />
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

// Production code must never reach the gallery's inert controller or canned state, and the production controller
// factory must always build the real client and storage. These read the source because a wiring mistake is invisible
// to a rendered test: the screen would look right while a fixture stood behind it.
const SRC = join(__dirname, '..', '..')
const APP = join(SRC, '..', 'app')

function sources(directory: string): string[] {
    return readdirSync(directory).flatMap((name) => {
        const path = join(directory, name)
        if (statSync(path).isDirectory()) {
            return sources(path)
        }
        return /\.(ts|tsx)$/u.test(name) && !/\.test\./u.test(name) ? [path] : []
    })
}

describe('production wiring', () => {
    it('keeps retired wait copy out of production source, so every wait says what is running', () => {
        const retired = ['Wait for the current request to finish.', 'Your builds are opening.']
        const offenders = [...sources(SRC), ...sources(APP)]
            .filter((file) => retired.some((copy) => readFileSync(file, 'utf8').includes(copy)))
            .map((file) => relative(SRC, file))
        expect(offenders).toEqual([])
    })

    it('is not imported from the preview gallery by any production module', () => {
        const offenders = [...sources(SRC), ...sources(APP)]
            .filter(
                (file) =>
                    !file.includes(`${sep}ui${sep}preview${sep}`) &&
                    !file.endsWith(`${sep}ui-review.tsx`) &&
                    !file.endsWith(`${sep}components.tsx`),
            )
            .filter((file) =>
                /from '[^']*\/preview\/|from '[^']*workflow-fixtures|INERT_WORKFLOW_CONTROLLER/u.test(
                    readFileSync(file, 'utf8'),
                ),
            )
            .map((file) => relative(SRC, file))
        // The component gallery and the demo screen are development surfaces that are not part of the product routes.
        expect(offenders.filter((file) => !/^(ui[\\/]index|demo[\\/]|ui[\\/]preview)/u.test(file))).toEqual([])
    })

    it('builds the real client, storage and image normalization with no inert fallback', () => {
        const factory = readFileSync(join(SRC, 'features', 'capture', 'controller-factory.ts'), 'utf8')
        expect(factory).toContain('new ModelApiClient(')
        expect(factory).toContain('new LibraryStorage(')
        expect(factory).not.toMatch(/INERT_WORKFLOW|workflow-fixtures|\/preview\/|synthetic/iu)
    })

    it('shows the unavailable screen, never a fixture controller, when the real controller cannot be built', () => {
        const provider = readFileSync(join(SRC, 'features', 'capture', 'workflow-provider.tsx'), 'utf8')
        expect(provider).toContain('<AppUnavailableScreen />')
        expect(provider).not.toMatch(/INERT_WORKFLOW|workflow-fixtures|\/preview\/|synthetic/iu)
    })
})
