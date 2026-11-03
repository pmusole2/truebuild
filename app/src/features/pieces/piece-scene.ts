import {
    Box3,
    BoxGeometry,
    CapsuleGeometry,
    ConeGeometry,
    CylinderGeometry,
    DirectionalLight,
    ExtrudeGeometry,
    Group,
    HemisphereLight,
    LatheGeometry,
    Mesh,
    MeshStandardMaterial,
    PerspectiveCamera,
    Scene,
    Shape,
    SphereGeometry,
    SRGBColorSpace,
    TorusGeometry,
    Vector2,
    Vector3,
    WebGLRenderer,
    type BufferGeometry,
    type Material,
} from 'three'
import type { ExpoWebGLRenderingContext } from 'expo-gl'
import type { PieceSpec } from '@truebuild/contracts'

export interface PieceScene {
    /** True only while a drag's target orientation still needs another rendered frame. */
    draw(): boolean
    rotate(horizontal: number, vertical: number): void
    zoom(factor: number): void
    reset(): void
    dispose(): void
}

function geometry(part: PieceSpec['parts'][number]): BufferGeometry {
    switch (part.type) {
        case 'box':
            return new BoxGeometry(part.dimensions.width, part.dimensions.height, part.dimensions.depth)
        case 'cylinder':
            return new CylinderGeometry(part.dimensions.radius, part.dimensions.radius, part.dimensions.height, 32)
        case 'sphere':
            return new SphereGeometry(part.dimensions.radius, 32, 20)
        case 'cone':
            return new ConeGeometry(part.dimensions.radius, part.dimensions.height, 32)
        case 'torus':
            return new TorusGeometry(part.dimensions.radius, part.dimensions.tube, 16, 40)
        case 'capsule':
            return new CapsuleGeometry(part.dimensions.radius, part.dimensions.length, 12, 24)
        case 'lathe': {
            const profile = part.profile.map(([r, y]) => new Vector2(r, y))
            const first = profile[0]!
            const last = profile[profile.length - 1]!
            // Close a profile to its axis so nonzero endpoint radii still make a solid rather than an open tube.
            if (first.x > 0) profile.unshift(new Vector2(0, first.y))
            if (last.x > 0) profile.push(new Vector2(0, last.y))
            const area = profile.reduce((sum, point, index) => {
                const next = profile[(index + 1) % profile.length]!
                return sum + point.x * next.y - next.x * point.y
            }, 0)
            // Three's meridian normals face outward when the radial profile winds bottom-to-top.
            if (area < 0) profile.reverse()
            return new LatheGeometry(profile, part.segments)
        }
        case 'extrude': {
            const shape = new Shape(part.outline.map(([x, y]) => new Vector2(x, y)))
            const bevel = part.bevel ?? 0
            return new ExtrudeGeometry(shape, {
                depth: part.depth,
                bevelEnabled: bevel > 0,
                bevelThickness: bevel,
                bevelSize: bevel,
                bevelSegments: 2,
                curveSegments: 8,
                steps: 1,
            })
        }
    }
}

/**
 * Closed shapes in the caller's own frame, with no centring. A caller that shares one world frame across several groups
 * (step motion) keeps that frame; a piece centres itself below.
 */
export function createShapeGroup(parts: readonly PieceSpec['parts'][number][], color: string): Group {
    const object = new Group()
    try {
        for (const part of parts) {
            const mesh = new Mesh(geometry(part), new MeshStandardMaterial({ color, roughness: 0.58, metalness: 0.14 }))
            mesh.position.set(...part.position)
            mesh.rotation.set(...part.rotation)
            object.add(mesh)
        }
        return object
    } catch (error) {
        disposePieceObject(object)
        throw error
    }
}

/** Closed, bounded-resolution parts only: no loaders, scripts, URLs or unbounded tessellation. */
export function createPieceObject(piece: PieceSpec): Group {
    const object = createShapeGroup(piece.parts, piece.color)
    try {
        const center = new Box3().setFromObject(object).getCenter(new Vector3())
        object.position.sub(center)
        // Keep centering inside a pivot so dragging rotates around the piece, not its source coordinates.
        const pivot = new Group()
        pivot.add(object)
        return pivot
    } catch (error) {
        disposePieceObject(object)
        throw error
    }
}

/** Three does not release geometry/material allocations merely because their meshes leave the scene. */
export function disposePieceObject(object: Group): void {
    const geometries = new Set<BufferGeometry>()
    const materials = new Set<Material>()
    object.traverse((child) => {
        if (!(child instanceof Mesh)) return
        geometries.add(child.geometry)
        for (const material of Array.isArray(child.material) ? child.material : [child.material])
            materials.add(material)
    })
    geometries.forEach((value) => value.dispose())
    materials.forEach((value) => value.dispose())
    object.clear()
}

/** expo-gl owns the context. This adapter supplies only the canvas members Three r160 uses on native. */
export function canvasFor(gl: ExpoWebGLRenderingContext): HTMLCanvasElement {
    if (gl.canvas) return gl.canvas as HTMLCanvasElement
    const canvas = {
        width: gl.drawingBufferWidth,
        height: gl.drawingBufferHeight,
        style: {},
        addEventListener: (): void => undefined,
        removeEventListener: (): void => undefined,
        setAttribute: (): void => undefined,
        getContext: (): ExpoWebGLRenderingContext => gl,
    }
    // Native has no HTMLCanvasElement; WebGLRenderer's documented existing-context boundary needs this shim.
    return canvas as unknown as HTMLCanvasElement
}

/** Fit every current transformed part bound with a 20% viewport margin, including after a drag or resize. */
export function framePieceCamera(
    camera: PerspectiveCamera,
    object: Group,
    width: number,
    height: number,
    zoom: number,
): void {
    object.updateWorldMatrix(true, true)
    const points: Vector3[] = []
    const bounds = new Box3()
    object.traverse((child) => {
        if (!(child instanceof Mesh)) return
        if (child.geometry.boundingBox === null) child.geometry.computeBoundingBox()
        const box = child.geometry.boundingBox!
        for (const x of [box.min.x, box.max.x])
            for (const y of [box.min.y, box.max.y])
                for (const z of [box.min.z, box.max.z]) {
                    const point = new Vector3(x, y, z).applyMatrix4(child.matrixWorld)
                    points.push(point)
                    bounds.expandByPoint(point)
                }
    })
    const center = bounds.getCenter(new Vector3())
    const radius = Math.max(bounds.getSize(new Vector3()).length() / 2, 0.001)
    camera.aspect = Math.max(1, width) / Math.max(1, height)
    const verticalLimit = Math.tan((camera.fov * Math.PI) / 360) * 0.8
    const horizontalLimit = verticalLimit * camera.aspect
    let distance = 0
    for (const point of points)
        distance = Math.max(
            distance,
            point.z - center.z + Math.abs(point.x - center.x) / horizontalLimit,
            point.z - center.z + Math.abs(point.y - center.y) / verticalLimit,
        )
    // Keep the camera outside the complete bounding sphere even when the user zooms in.
    const cameraDistance = Math.max(radius * 1.2, distance / zoom)
    camera.position.set(center.x, center.y, center.z + cameraDistance)
    camera.near = radius * 0.005
    camera.far = cameraDistance + radius * 20
    camera.updateProjectionMatrix()
    camera.lookAt(center)
    camera.updateMatrixWorld()
}

export function createPieceScene(gl: ExpoWebGLRenderingContext, piece: PieceSpec, background: string): PieceScene {
    const renderer = new WebGLRenderer({ canvas: canvasFor(gl), context: gl, antialias: true, alpha: false })
    let allocated: Group | null = null
    try {
        renderer.outputColorSpace = SRGBColorSpace
        renderer.setClearColor(background, 1)
        const scene = new Scene()
        const camera = new PerspectiveCamera(35, 1, 0.001, 10000)
        const pivot = createPieceObject(piece)
        allocated = pivot
        scene.add(pivot, new HemisphereLight(0xeaf1ff, 0x8d8172, 2.2))
        const key = new DirectionalLight(0xffffff, 3)
        key.position.set(3, 5, 4)
        const fill = new DirectionalLight(0xd7e8ff, 1)
        fill.position.set(-4, 2, -3)
        const underside = new DirectionalLight(0xffead2, 2)
        underside.position.set(1, -4, 3)
        const rim = new DirectionalLight(0xdceaff, 1.6)
        rim.position.set(-3, 1, -4)
        scene.add(key, fill, underside, rim)
        let disposed = false,
            zoom = 1,
            width = 0,
            height = 0,
            targetPitch = -0.24,
            targetYaw = 0.48,
            lastFrameAt = performance.now()
        const wrappedAngle = (value: number): number => Math.atan2(Math.sin(value), Math.cos(value))
        const reset = (): void => {
            targetPitch = -0.24
            targetYaw = 0.48
            pivot.rotation.set(targetPitch, targetYaw, 0)
            zoom = 1
            lastFrameAt = performance.now()
        }
        reset()
        return {
            draw: (): boolean => {
                if (disposed) return false
                // Briefly ease sparse drag events into their actual target; there is no spin or idle animation.
                const now = performance.now()
                const deltaSeconds = Math.max(0.001, Math.min(1 / 30, (now - lastFrameAt) / 1000))
                lastFrameAt = now
                const blend = 1 - Math.exp(-deltaSeconds / 0.055)
                pivot.rotation.x += (targetPitch - pivot.rotation.x) * blend
                pivot.rotation.y += wrappedAngle(targetYaw - pivot.rotation.y) * blend
                const moving =
                    Math.abs(targetPitch - pivot.rotation.x) > 0.0005 ||
                    Math.abs(wrappedAngle(targetYaw - pivot.rotation.y)) > 0.0005
                if (!moving) pivot.rotation.set(targetPitch, targetYaw, 0)
                const w = Math.max(1, gl.drawingBufferWidth),
                    h = Math.max(1, gl.drawingBufferHeight)
                if (w !== width || h !== height) {
                    width = w
                    height = h
                    renderer.setSize(w, h, false)
                }
                framePieceCamera(camera, pivot, w, h, zoom)
                renderer.render(scene, camera)
                gl.endFrameEXP()
                return moving
            },
            rotate: (horizontal, vertical): void => {
                if (!Number.isFinite(horizontal) || !Number.isFinite(vertical)) return
                targetYaw = wrappedAngle(targetYaw + horizontal)
                targetPitch = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, targetPitch + vertical))
            },
            zoom: (factor): void => {
                if (Number.isFinite(factor) && factor > 0) zoom = Math.max(0.55, Math.min(3, zoom * factor))
            },
            reset,
            dispose: (): void => {
                if (disposed) return
                disposed = true
                try {
                    disposePieceObject(pivot)
                } finally {
                    scene.clear()
                    renderer.dispose()
                }
            },
        }
    } catch (error) {
        try {
            if (allocated !== null) disposePieceObject(allocated)
        } finally {
            renderer.dispose()
        }
        throw error
    }
}
