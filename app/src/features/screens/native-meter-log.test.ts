import { expect, it } from 'vitest'
import { logNativeCheckpoint } from './native-meter-log'

it('reconstructs the exact census through bounded iOS log fragments', () => {
    const record = {
        event: 'render_origin_checkpoint',
        methods: { focused: { label: 'a "quote" 🌿'.repeat(200), counts: { generated: 30, shell: 1 } } },
    }
    const lines: string[] = []
    logNativeCheckpoint(record, (line): void => {
        lines.push(line)
    })
    const parts = lines
        .slice(0, -1)
        .map((line) => JSON.parse(line) as { id: number; index: number; total: number; data: string })
    expect(parts.length).toBeGreaterThan(1)
    expect(new Set(parts.map((part) => part.id)).size).toBe(1)
    expect(parts.map((part) => part.index)).toEqual(parts.map((_, index) => index))
    expect(parts.every((part) => part.total === parts.length)).toBe(true)
    expect(lines.slice(0, -1).every((line) => Buffer.byteLength(line) < 900)).toBe(true)
    expect(JSON.parse(parts.map((part) => part.data).join(''))).toEqual(record)
    expect(JSON.parse(lines.at(-1)!)).toEqual(record)
})
