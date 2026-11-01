import {
    Box3,
    BoxGeometry,
    CapsuleGeometry,
    ConeGeometry,
    CylinderGeometry,
    DirectionalLight,
    Group,
    HemisphereLight,
    Mesh,
    MeshStandardMaterial,
    PerspectiveCamera,
    Scene,
    SphereGeometry,
    SRGBColorSpace,
    TorusGeometry,
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
    }
}

/** Closed, fixed-resolution primitives only: no loaders, scripts, URLs or model-selected tessellation. */
export function createPieceObject(piece: PieceSpec): Group {
    const object = new Group()
    try {
        for (const part of piece.parts) {
            const mesh = new Mesh(
                geometry(part),
                new MeshStandardMaterial({ color: piece.color, roughness: 0.58, metalness: 0.14 }),
            )
            mesh.position.set(...part.position)
            mesh.rotation.set(...part.rotation)
            object.add(mesh)
        }
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
function canvasFor(gl: ExpoWebGLRenderingContext): HTMLCanvasElement {
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
        const bounds = new Box3().setFromObject(pivot)
        const radius = Math.max(bounds.getSize(new Vector3()).length() / 2, 0.001)
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
            framedDistance = 0,
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
        // Frame the actual starting pose rather than its much larger bounding sphere. Its projected extents occupy
        // about 80% of the viewport on each axis, so wide pieces use its width instead of shrinking to its height.
        pivot.updateWorldMatrix(true, true)
        const initial = new Box3()
        const framing: Vector3[] = []
        pivot.traverse((child) => {
            if (!(child instanceof Mesh)) return
            const positions = child.geometry.getAttribute('position')
            for (let index = 0; index < positions.count; index++) {
                const point = new Vector3().fromBufferAttribute(positions, index).applyMatrix4(child.matrixWorld)
                initial.expandByPoint(point)
                framing.push(point)
            }
        })
        const framedCenter = initial.getCenter(new Vector3())
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
                    camera.aspect = w / h
                    const vertical = (camera.fov * Math.PI) / 360
                    const horizontalLimit = Math.tan(vertical) * camera.aspect * 0.8
                    const verticalLimit = Math.tan(vertical) * 0.8
                    framedDistance = 0
                    for (const point of framing)
                        framedDistance = Math.max(
                            framedDistance,
                            point.z + Math.abs(point.x - framedCenter.x) / horizontalLimit,
                            point.z + Math.abs(point.y - framedCenter.y) / verticalLimit,
                        )
                }
                camera.position.set(framedCenter.x, framedCenter.y, Math.max(radius * 0.01, framedDistance / zoom))
                camera.near = radius * 0.005
                camera.far = camera.position.z + radius * 20
                camera.updateProjectionMatrix()
                camera.lookAt(framedCenter.x, framedCenter.y, 0)
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
