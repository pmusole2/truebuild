import type { ReactElement } from 'react'
import { ErrorState } from '../../ui/states'
import { Screen } from './screen-chrome'

/** Presentation only; the app boundary decides when initialization failed. */
export function AppUnavailableScreen(): ReactElement {
    return (
        <Screen title="TrueBuild">
            <ErrorState
                title="Couldn’t open TrueBuild"
                body="Close and reopen the app. If this keeps happening, ask the person who shared this build for an updated version."
            />
        </Screen>
    )
}
