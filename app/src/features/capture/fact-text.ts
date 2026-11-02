import type { Fact } from '@truebuild/contracts'

export function factText<T>(fact: Fact<T>, display: (value: T) => string): string {
    return fact.state === 'known' ? display(fact.value) : `Unknown: ${fact.reason}`
}
