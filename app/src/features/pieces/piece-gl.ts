import type { ComponentType } from 'react'
import type { GLViewProps } from 'expo-gl'
import type * as PieceSceneModule from './piece-scene'

/** The lazy external GL boundary keeps ordinary documents and unavailable devices independent of the native module. */
export async function loadPieceGL(): Promise<{ default: ComponentType<GLViewProps> }> {
    const module = await import('expo-gl')
    return { default: module.GLView }
}

/** Scene creation shares the lazy GPU boundary; ordinary documents never load Three eagerly. */
export async function loadPieceScene(): Promise<typeof PieceSceneModule> {
    return import('./piece-scene')
}
