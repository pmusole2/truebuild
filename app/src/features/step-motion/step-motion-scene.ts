import {
    Box3,
    DirectionalLight,
    Group,
    HemisphereLight,
    Matrix4,
    Mesh,
    MeshStandardMaterial,
    PerspectiveCamera,
    PlaneGeometry,
    Scene,
    SRGBColorSpace,
    Vector3,
    WebGLRenderer,
} from 'three'
import type { ExpoWebGLRenderingContext } from 'expo-gl'
import type { StepMotionScene } from '@truebuild/contracts'
import { canvasFor, createShapeGroup, disposePieceObject } from '../pieces/piece-scene'

/** Movers run one after another, each `moveMs` of eased motion; one `holdMs` rest follows the whole sequence, then the loop repeats. */
export const STEP_MOTION_TIMING = { moveMs: 2400, holdMs: 600, maxLoops: 3 } as const

type Motion = StepMotionScene['movers'][number]['motion']

/**
 * Where the sequence is. `mover` is the moving mover's index, or null during the terminal hold and once finished; then
 * every mover rests at its finished pose. `eased` is the moving mover's eased progress.
 */
export type StepMotionClock = { readonly finished: boolean; readonly mover: number | null; readonly eased: number }

export type StepMotionMover = {
    readonly group: Group
    readonly motion: Motion
    readonly actionIndex: number | null
    /** The mover's finished bounding-box centre, used by screw motion. */
    readonly center: Vector3
}

export type StepMotionObject = {
    readonly root: Group
    readonly movers: readonly StepMotionMover[]
    /** Bounding sphere of every pose on the path, so the camera can stay fixed for the whole sequence. */
    readonly frame: { readonly center: Vector3; readonly radius: number }
}

export type StepMotionGLScene = {
    /** Deterministic: the picture depends only on elapsedMs and the drawing-buffer size. Infinity is the finished pose. */
    draw(elapsedMs: number): StepMotionClock
    dispose(): void
}

const STILL_COLOR = '#7D8A9E'
const MOVER_COLOR = '#D9893B'
const GROUND_COLOR = '#DDE2EA'
const SWEEP_SAMPLES = 16
const FRAME_MARGIN = 1.15
const CAMERA_FOV = 35
// A gentle, fixed three-quarter view from above.
const CAMERA_YAW = 0.55
const CAMERA_PITCH = 0.42

const lerp = (from: number, to: number, progress: number): number => from + (to - from) * progress
const toRadians = (degrees: number): number => (degrees * Math.PI) / 180

function easeInOut(progress: number): number {
    return progress < 0.5 ? 4 * progress * progress * progress : 1 - Math.pow(-2 * progress + 2, 3) / 2
}

const translation = (x: number, y: number, z: number): Matrix4 => new Matrix4().makeTranslation(x, y, z)
const turn = (axis: Vector3, angle: number): Matrix4 => new Matrix4().makeRotationAxis(axis, angle)

/** Pure timeline: back-to-back mover motions, one terminal hold, then the next loop; three loops, then finished. */
export function stepMotionClock(moverCount: number, elapsedMs: number): StepMotionClock {
    const moves = moverCount * STEP_MOTION_TIMING.moveMs
    const loop = moves + STEP_MOTION_TIMING.holdMs
    const total = loop * STEP_MOTION_TIMING.maxLoops
    const elapsed = Number.isNaN(elapsedMs) ? 0 : Math.max(0, elapsedMs)
    if (elapsed >= total) return { finished: true, mover: null, eased: 1 }
    const within = elapsed % loop
    if (within >= moves) return { finished: false, mover: null, eased: 1 }
    const mover = Math.floor(within / STEP_MOTION_TIMING.moveMs)
    const inMove = within - mover * STEP_MOTION_TIMING.moveMs
    return { finished: false, mover, eased: easeInOut(inMove / STEP_MOTION_TIMING.moveMs) }
}

/** Movers before the moving one rest at their finished pose, and movers after it wait at their start pose. */
export function stepMotionProgress(clock: StepMotionClock, index: number): number {
    if (clock.mover === null || index < clock.mover) return 1
    return index === clock.mover ? clock.eased : 0
}

/**
 * The mover transform at eased progress t. Every motion ends at the identity: the shapes are modelled finished.
 * Rotate turns by (lerp(fromDeg, toDeg, t) - toDeg) about pivot; translate moves by (lerp(from, to, t) - to);
 * screw turns by -2π·turns·(1-t) about its finished centre and moves by -axis·travel·(1-t).
 */
export function stepMotionMatrix(motion: Motion, center: Vector3, progress: number): Matrix4 {
    switch (motion.kind) {
        case 'rotate': {
            const pivot = new Vector3(...motion.pivot)
            const angle = toRadians(lerp(motion.fromDeg, motion.toDeg, progress) - motion.toDeg)
            return translation(pivot.x, pivot.y, pivot.z)
                .multiply(turn(new Vector3(...motion.axis).normalize(), angle))
                .multiply(translation(-pivot.x, -pivot.y, -pivot.z))
        }
        case 'translate': {
            const delta = motion.to.map((to, axis) => lerp(motion.from[axis]!, to, progress) - to) as [
                number,
                number,
                number,
            ]
            return translation(...delta)
        }
        case 'screw': {
            const remaining = 1 - progress
            const axis = new Vector3(...motion.axis).normalize()
            const offset = axis.clone().multiplyScalar(-motion.travel * remaining)
            const angle = -2 * Math.PI * motion.turns * remaining
            return translation(offset.x, offset.y, offset.z)
                .multiply(translation(center.x, center.y, center.z))
                .multiply(turn(axis, angle))
                .multiply(translation(-center.x, -center.y, -center.z))
        }
    }
}

/**
 * Builds every shape in the scene's shared world frame, with no per-group centring, and computes the fixed camera frame
 * from sampled poses. No GL context is needed; a failed build disposes what it allocated.
 */
export function createStepMotionObject(scene: StepMotionScene): StepMotionObject {
    const root = new Group()
    try {
        root.add(createShapeGroup(scene.still, STILL_COLOR))
        const movers = scene.movers.map((mover): StepMotionMover => {
            const group = createShapeGroup(mover.shapes, MOVER_COLOR)
            group.matrixAutoUpdate = false
            root.add(group)
            const center = new Box3().setFromObject(group).getCenter(new Vector3())
            return { group, motion: mover.motion, actionIndex: mover.actionIndex, center }
        })
        const bounds = new Box3().setFromObject(root)
        for (let sample = 0; sample <= SWEEP_SAMPLES; sample++) {
            const progress = sample / SWEEP_SAMPLES
            for (const mover of movers) {
                mover.group.matrix.copy(stepMotionMatrix(mover.motion, mover.center, progress))
                mover.group.updateMatrixWorld(true)
                bounds.expandByObject(mover.group)
            }
        }
        for (const mover of movers) mover.group.matrix.identity()
        const center = bounds.getCenter(new Vector3())
        const radius = Math.max(bounds.getSize(new Vector3()).length() / 2, 0.001)
        const ground = new Mesh(
            new PlaneGeometry(radius * 5, radius * 5),
            new MeshStandardMaterial({ color: GROUND_COLOR, roughness: 1, metalness: 0 }),
        )
        ground.rotation.x = -Math.PI / 2
        ground.position.set(center.x, bounds.min.y - radius * 0.02, center.z)
        root.add(ground)
        root.updateMatrixWorld(true)
        return { root, movers, frame: { center, radius } }
    } catch (error) {
        disposePieceObject(root)
        throw error
    }
}

/** Applies the clock's pose to every mover. Matrices are set directly, so no transform is ever composed twice. */
export function poseStepMotionObject(object: StepMotionObject, clock: StepMotionClock): void {
    object.movers.forEach((mover, index) => {
        mover.group.matrix.copy(stepMotionMatrix(mover.motion, mover.center, stepMotionProgress(clock, index)))
    })
    object.root.updateMatrixWorld(true)
}

/** A fixed, gently angled camera that fits the bounding sphere of the whole sweep at any viewport aspect. */
function frameStepMotionCamera(
    camera: PerspectiveCamera,
    frame: StepMotionObject['frame'],
    width: number,
    height: number,
): void {
    camera.aspect = Math.max(1, width) / Math.max(1, height)
    const vertical = (camera.fov * Math.PI) / 360
    const horizontal = Math.atan(Math.tan(vertical) * camera.aspect)
    const distance = (frame.radius * FRAME_MARGIN) / Math.sin(Math.min(vertical, horizontal))
    const { center, radius } = frame
    const planar = distance * Math.cos(CAMERA_PITCH)
    camera.position.set(
        center.x + planar * Math.sin(CAMERA_YAW),
        center.y + distance * Math.sin(CAMERA_PITCH),
        center.z + planar * Math.cos(CAMERA_YAW),
    )
    camera.near = Math.max(radius * 0.01, distance - radius * 2)
    camera.far = distance + radius * 4
    camera.updateProjectionMatrix()
    camera.lookAt(center)
    camera.updateMatrixWorld()
}

/** expo-gl owns the context; the pure object above is shared unchanged with this renderer. */
export function createStepMotionScene(
    gl: ExpoWebGLRenderingContext,
    scene: StepMotionScene,
    background: string,
): StepMotionGLScene {
    const renderer = new WebGLRenderer({ canvas: canvasFor(gl), context: gl, antialias: true, alpha: false })
    let object: StepMotionObject | null = null
    try {
        renderer.outputColorSpace = SRGBColorSpace
        renderer.setClearColor(background, 1)
        const built = createStepMotionObject(scene)
        object = built
        const threeScene = new Scene()
        const camera = new PerspectiveCamera(CAMERA_FOV, 1, 0.001, 10000)
        const key = new DirectionalLight(0xffffff, 2.6)
        key.position.set(3, 5, 4)
        threeScene.add(built.root, new HemisphereLight(0xeaf1ff, 0x8d8172, 2.2), key)
        let disposed = false
        let width = 0
        let height = 0
        return {
            draw: (elapsedMs: number): StepMotionClock => {
                const clock = stepMotionClock(built.movers.length, elapsedMs)
                if (disposed) return clock
                const w = Math.max(1, gl.drawingBufferWidth)
                const h = Math.max(1, gl.drawingBufferHeight)
                if (w !== width || h !== height) {
                    width = w
                    height = h
                    renderer.setSize(w, h, false)
                }
                poseStepMotionObject(built, clock)
                frameStepMotionCamera(camera, built.frame, w, h)
                renderer.render(threeScene, camera)
                gl.endFrameEXP()
                return clock
            },
            dispose: (): void => {
                if (disposed) return
                disposed = true
                try {
                    disposePieceObject(built.root)
                } finally {
                    threeScene.clear()
                    renderer.dispose()
                }
            },
        }
    } catch (error) {
        try {
            if (object !== null) disposePieceObject(object.root)
        } finally {
            renderer.dispose()
        }
        throw error
    }
}
