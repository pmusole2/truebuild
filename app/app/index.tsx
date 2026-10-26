import type { ReactElement } from 'react'
import { DemoScreen } from '../src/demo/demo-screen'
import { API_BASE_URL, API_SECRET, DEMO_MODE } from '../src/config'

export default function IndexRoute(): ReactElement {
    return <DemoScreen runtime={{ mode: DEMO_MODE, baseUrl: API_BASE_URL, secret: API_SECRET }} />
}
