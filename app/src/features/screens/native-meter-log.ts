let sequence = 0

/** iOS unified logging truncates long lines. Fragments preserve the exact safe census record for offline collection. */
export function logNativeCheckpoint(record: Record<string, unknown>, log: (line: string) => void = console.info): void {
    const value = JSON.stringify(record)
    if (value.length > 700) {
        const id = ++sequence
        const size = 240
        const total = Math.ceil(value.length / size)
        for (let index = 0; index < total; index += 1) {
            log(
                JSON.stringify({
                    event: 'render_origin_fragment',
                    id,
                    index,
                    total,
                    data: value.slice(index * size, (index + 1) * size),
                }),
            )
        }
    }
    // Kept for consumers whose native log transport preserves complete records.
    log(value)
}
