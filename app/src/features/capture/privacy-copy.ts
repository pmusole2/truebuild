// One privacy contract for every surface. Each sentence matches what the controller actually sends.
export const PRIVACY_COPY = {
    stayOnDevice: 'Pages and photos stay on this device until you read the manual, check a step, or ask a question.',
    read: 'Reading sends the manual pages you chose to your TrueBuild API to extract the plan.',
    check: 'A check sends the frozen photo with the manual pages it is checked against, up to 20 pages.',
    ask: 'A question sends the frozen photo with the manual pages it is answered from, up to 20 pages.',
    camera: 'The camera opens only when you choose to photograph a manual page or an assembly step.',
} as const
