import type { ComponentType } from 'react'
import { Platform } from 'react-native'
import { requireOptionalNativeModule } from 'expo'
import type { GLViewProps } from 'expo-gl'
import type * as PieceSceneModule from './piece-scene'
import type * as StepMotionSceneModule from '../step-motion/step-motion-scene'

/** The lazy external GL boundary keeps ordinary documents and unavailable devices independent of the native module. */
export async function loadPieceGL(): Promise<{ default: ComponentType<GLViewProps> }> {
    const module = await import('expo-gl')
    return { default: module.GLView }
}

/** Scene creation shares the lazy GPU boundary; ordinary documents never load Three eagerly. */
export async function loadPieceScene(): Promise<typeof PieceSceneModule> {
    return import('./piece-scene')
}

/** Step motion shares the same lazy GPU boundary; a document without a motion hint never loads its Three scene. */
export async function loadStepMotionScene(): Promise<typeof StepMotionSceneModule> {
    return import('../step-motion/step-motion-scene')
}

/** Synchronous capability check, so a device without GL never mounts a surface that cannot start. */
export function isGLAvailable(): boolean {
    try {
        return Platform.OS === 'web'
            ? typeof WebGLRenderingContext !== 'undefined' || typeof WebGL2RenderingContext !== 'undefined'
            : requireOptionalNativeModule('ExpoGL') !== null
    } catch {
        return false
    }
}
