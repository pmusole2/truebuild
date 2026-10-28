// Keep the language actually submitted for each manual's reading attempt. Picker drafts do not affect another read.
// This is presentation state only; the controller continues validating the submitted language.
const submitted = new Map<string, string>()
export function setReadingLanguage(manualId: string, code: string): void {
    submitted.set(manualId, code)
}
export function readingLanguage(manualId: string): string {
    return submitted.get(manualId) ?? 'en'
}
