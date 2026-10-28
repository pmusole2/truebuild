import type { WorkflowController } from './workflow-types'
import type { LibraryEntry } from './library'
import { stopFor } from './plain-copy'

/**
 * Navigation the screens ask for that is more than one controller operation. Production wires these to the native
 * router (native-routes.tsx). Previews and tests use `defaultNav`, which only calls the controller, so every screen
 * renders without a router.
 */
export type ScreenNav = {
    // Resume the furthest stop for a manual: Add, Quick check, Guide or Done.
    readonly openStop: (entry: LibraryEntry) => void
    // Confirm the whole manual (one explicit tap), then open the guide.
    readonly startBuilding: () => Promise<void>
    // Mark the last step done by hand and show Done.
    readonly finish: () => Promise<void>
    // Back to the list of builds without touching any workflow state.
    readonly allBuilds: () => void
    // Back to the pages of the manual being read.
    readonly editPages: () => void
    // Leave a finished build for Home.
    readonly leave: () => void
    // One screen back, keeping whatever the workflow holds.
    readonly back: () => void
}

export function defaultNav(controller: WorkflowController): ScreenNav {
    return {
        openStop: (entry): void => {
            const stop = stopFor(entry)
            void controller.open(entry.session.manualId, stop === 'done' ? 'guide' : stop)
        },
        startBuilding: async (): Promise<void> => {
            await controller.confirm()
            controller.navigate('guide')
        },
        finish: async (): Promise<void> => {
            await controller.completeStep()
        },
        allBuilds: (): void => controller.home(),
        editPages: (): void => controller.navigate('pages'),
        leave: (): void => controller.home(),
        back: (): void => controller.navigate('pages'),
    }
}
