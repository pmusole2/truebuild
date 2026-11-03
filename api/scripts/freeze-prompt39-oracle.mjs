/** Rebuild the test-only fc7b706 oracle from local Git objects, without network access or current workspace aliases. */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, relative } from 'node:path'
import { build, version } from 'esbuild'

const root = process.cwd()
const commit = execFileSync('git', ['rev-parse', 'fc7b706'], { encoding: 'utf8' }).trim()
const temporary = mkdtempSync(join(tmpdir(), 'truebuild-frozen39-'))
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex')
const prefix = 'packages/contracts/src/'
const wrapper = `import { createHash } from 'node:crypto'
import { screenDocumentV2Schema } from './packages/contracts/src/document-v2'
import { verifyDocumentAgainstInputsV2 } from './packages/contracts/src/document-v2-verify'
import { screensV2ResultSchema } from './packages/contracts/src/model'
export function checkPrompt39Response(body) { return screensV2ResultSchema.safeParse(body).success }
export function checkPrompt39(cases) { const hash = (text) => createHash('sha256').update(text).digest('hex'); return cases.map(({ body, inputs }) => ({ response: screensV2ResultSchema.safeParse(body).success, document: screenDocumentV2Schema.safeParse(body.value.document).success, issues: verifyDocumentAgainstInputsV2(body.value.document, inputs, hash) })) }
`
try {
    const paths = execFileSync('git', ['ls-tree', '-r', '--name-only', commit, '--', prefix], { encoding: 'utf8' })
        .trim()
        .split('\n')
    for (const path of paths.filter((path) => !path.includes('.test.'))) {
        const target = join(temporary, path)
        mkdirSync(dirname(target), { recursive: true })
        writeFileSync(target, execFileSync('git', ['show', `${commit}:${path}`]))
    }
    writeFileSync(join(temporary, 'oracle.ts'), wrapper)
    writeFileSync(
        join(temporary, 'tsconfig.json'),
        '{"compilerOptions":{"target":"ES2022","module":"ESNext","moduleResolution":"Bundler"}}',
    )
    const result = await build({
        absWorkingDir: temporary,
        entryPoints: [join(temporary, 'oracle.ts')],
        tsconfig: join(temporary, 'tsconfig.json'),
        bundle: true,
        format: 'esm',
        platform: 'node',
        target: 'node24',
        external: ['zod', 'node:crypto'],
        minify: true,
        metafile: true,
        write: false,
        plugins: [
            {
                name: 'frozen-contracts-only',
                setup(builder) {
                    builder.onResolve({ filter: /^@truebuild\/contracts(?:\/model)?$/ }, (args) => ({
                        path: join(temporary, prefix, args.path.endsWith('/model') ? 'model.ts' : 'index.ts'),
                    }))
                },
            },
        ],
        banner: {
            js: '/* eslint-disable @typescript-eslint/no-unused-vars, @typescript-eslint/no-unused-expressions -- Frozen generated fc7b706 oracle; never hand-edit old checker code. */\n// Test-only generated oracle. See checker-provenance.json and api/scripts/freeze-prompt39-oracle.mjs.',
        },
    })
    const sources = Object.keys(result.metafile.inputs)
        .filter((path) => path !== 'oracle.ts')
        .map((path) => {
            const absolute = resolve(temporary, path)
            const repositoryPath = relative(temporary, absolute)
            if (
                !repositoryPath.startsWith(prefix) ||
                repositoryPath.includes('..') ||
                repositoryPath.endsWith('/wait-copy.ts')
            )
                throw new Error(`Unexpected oracle input: ${repositoryPath}`)
            const bytes = readFileSync(absolute)
            const authoritative = execFileSync('git', ['show', `${commit}:${repositoryPath}`])
            if (!bytes.equals(authoritative)) throw new Error(`Non-frozen source: ${repositoryPath}`)
            return { path: repositoryPath, sha256: digest(bytes) }
        })
    const output = result.outputFiles[0].contents
    const directory = join(root, prefix, 'fixtures/prompt39')
    writeFileSync(join(directory, 'checker.mjs'), output)
    writeFileSync(
        join(directory, 'checker.d.mts'),
        'export function checkPrompt39(cases: unknown[]): unknown\nexport function checkPrompt39Response(body: unknown): boolean\n',
    )
    writeFileSync(
        join(directory, 'checker-provenance.json'),
        JSON.stringify(
            {
                commit,
                generator: `esbuild ${version}`,
                entry: 'Unmodified old schema and request-bound checker. Only the test wrapper is new.',
                external: ['zod', 'node:crypto'],
                wrapperSha256: digest(wrapper),
                sources,
                bundleSha256: digest(output),
            },
            null,
            4,
        ) + '\n',
    )
    process.stdout.write(
        `Frozen oracle: ${sources.length}/${sources.length} source bytes verified against ${commit}; ${output.length} bytes\n`,
    )
} finally {
    rmSync(temporary, { recursive: true, force: true })
}
