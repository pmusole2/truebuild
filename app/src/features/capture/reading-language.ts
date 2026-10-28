// The language picked on Add manual, kept so Try again on Reading reads in the same language. Presentation state only:
// it is never stored, and the controller still validates whatever it is given.
let current = 'en'
export function setReadingLanguage(code: string): void {
    current = code
}
export function readingLanguage(): string {
    return current
}
