/** Exact legacy wait vocabulary, retained as fixture data for the app-only compatibility boundary. */
const legacyWaitCopy = {
    headings: ['Working on it'],
    details: ['One moment, please.'],
    actions: ['Working…', 'Please wait'],
    activities: {
        saving: { heading: 'Saving…', detail: 'This only takes a moment.' },
        checking: { detail: 'This only takes a moment.' },
        asking: { detail: 'This only takes a moment.' },
        'second-opinion': { detail: 'A closer look can take a little longer.' },
        'question-waiting': { detail: 'Thanks for waiting.' },
    },
}

export default legacyWaitCopy
