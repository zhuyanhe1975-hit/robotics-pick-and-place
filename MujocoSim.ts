/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/


import * as THREE from 'three';
import { DragStateManager } from './DragStateManager';
import { IkSystem } from './IkSystem';
import { RenderSystem } from './RenderSystem';
import { RobotLoader } from './RobotLoader';
import { SelectionManager } from './SelectionManager';
import { SequenceAnimator } from './SequenceAnimator';
import { MujocoData, MujocoModel, MujocoModule, SceneLayoutTarget, TrajectoryTargetHint } from './types';
import { getName } from './utils/StringUtils';

/**
 * MujocoSim: The Central Orchestrator.
 * Manages the connection between the MuJoCo WASM engine and the Three.js visualization.
 */
export class MujocoSim {
    mujoco: MujocoModule;      
    mjModel: MujocoModel | null = null;     
    mjData: MujocoData | null = null;      
    mjvOption: InstanceType<MujocoModule['MjvOption']>;   

    renderSys: RenderSystem;
    ikSys: IkSystem;
    dragStateManager: DragStateManager;
    selectionManager: SelectionManager;
    sequenceAnimator: SequenceAnimator;

    frameId: number | null = null; 
    paused = false;
    gripperActuatorId = -1;
    speedMultiplier = 1;
    private isStackingScene = false;
    private executionStartTime: number | null = null;
    private executionStartSimTime: number | null = null;
    private executionTargetCount = 0;
    private executionAttemptedCount = 0;
    private executionCompletedCount = 0;
    private executionSkippedCount = 0;
    private executionTimeoutCount = 0;
    private executionInvalidRun = false;
    private executionFailureReason: string | null = null;
    private executionFailureMessage: string | null = null;
    private executionFailedStepIndex: number | null = null;
    private executionFailedStepName: string | null = null;
    private executionFailedTargetIndex: number | null = null;
    private executionCollisionPairs = new Set<string>();
    private executionTargetBodyIds: number[] = [];
    private executionCompletedBodyIds = new Set<number>();
    private executionInitialCubePositions = new Map<number, THREE.Vector3>();
    private renderEnabled = true;
    
    private userIkEnabled = false; 
    private firstIkEnable = true; // Track first enable to enforce default rotation

    // Gizmo Interpolation State
    private gizmoAnim = {
        active: false,
        startPos: new THREE.Vector3(),
        endPos: new THREE.Vector3(),
        startRot: new THREE.Quaternion(),
        endRot: new THREE.Quaternion(),
        startTime: 0,
        duration: 1000
    };

    constructor(container: HTMLElement, mujocoInstance: MujocoModule) {
        this.mujoco = mujocoInstance;
        this.mjvOption = new this.mujoco.MjvOption();
        
        this.renderSys = new RenderSystem(container, this.mujoco);
        
        this.dragStateManager = new DragStateManager(this.renderSys.scene, this.renderSys.renderer, this.renderSys.camera, container, this.renderSys.controls);
        this.selectionManager = new SelectionManager(this.renderSys.scene, this.renderSys.renderer, this.renderSys.camera, container);
        
        this.ikSys = new IkSystem(this.mujoco, this.renderSys.camera, this.renderSys.renderer.domElement, this.renderSys.controls);
        this.renderSys.simGroup.add(this.ikSys.target); 
        this.renderSys.scene.add(this.ikSys.control.getHelper());
        
        this.sequenceAnimator = new SequenceAnimator();
        
        this.renderSys.initLights(this.dragStateManager);
    }

    async init(robotId = 'franka_emika_panda', sceneFile = 'scene.xml', onProgress?: (msg: string) => void) {
        const loader = new RobotLoader(this.mujoco);
        const { isDouble, isStacking } = await loader.load(robotId, sceneFile, onProgress);
        this.isStackingScene = isStacking;

        try {
            this.mjModel = this.mujoco.MjModel.loadFromXML(`/working/${sceneFile}`);
            this.mjData = new this.mujoco.MjData(this.mjModel);
        } catch (e: unknown) { 
            throw new Error(`Failed to load model: ${(e as Error).message}`); 
        }

        if (this.mjModel) {
            this.ikSys.gripperSiteId = -1; 
            this.gripperActuatorId = -1;
            for (let i = 0; i < this.mjModel.nsite; i++) {
                 if (getName(this.mjModel, this.mjModel.name_siteadr[i]).includes('tcp')) { 
                     this.ikSys.gripperSiteId = i; break; 
                 }
            }
            for (let i = 0; i < this.mjModel.nu; i++) {
                 if (getName(this.mjModel, this.mjModel.name_actuatoradr[i]).includes('gripper')) { 
                     this.gripperActuatorId = i; break; 
                 }
            }
            // Set Initial Pose
            this.setInitialPose();

            this.mujoco.mj_forward(this.mjModel, this.mjData!);
            this.renderSys.initScene(this.mjModel);
            this.ikSys.init(this.mjModel, isDouble);
            this.ikSys.syncToSite(this.mjData!);
            
            this.ikSys.target.quaternion.setFromEuler(new THREE.Euler(Math.PI, 0, 0));
            this.ikSys.target.position.set(0, 0, 0.45);

            this.firstIkEnable = true;
            
            this.sequenceAnimator.init(this.mjModel, isStacking, (addr) => getName(this.mjModel!, addr));
            
            this.startLoop();
        }
    }
    
    private setInitialPose() {
        if (!this.mjModel || !this.mjData) return;
        const initVals = [1.707, -1.754, 0.003, -2.702, 0.003, 0.951, 2.490, 0.000];
        
        for (let i = 0; i < Math.min(initVals.length, this.mjModel.nu); i++) {
            this.mjData.ctrl[i] = initVals[i];
            if (this.mjModel.actuator_trnid[2 * i + 1] === 1) {
                const jointId = this.mjModel.actuator_trnid[2 * i];
                if (jointId >= 0 && jointId < this.mjModel.njnt) {
                    const qposAdr = this.mjModel.jnt_qposadr[jointId];
                    this.mjData.qpos[qposAdr] = initVals[i];
                }
            }
        }
    }

    private syncSceneState() {
        if (!this.mjModel || !this.mjData) return;
        this.mujoco.mj_forward(this.mjModel, this.mjData);
        this.ikSys.syncToSite(this.mjData);
    }

    private buildSpreadWorkspaceSeeds() {
        const seeds = [
            { x: 0.36, y: 0.00 },
            { x: 0.28, y: 0.22 },
            { x: 0.28, y: -0.22 },
            { x: 0.14, y: 0.34 },
            { x: 0.14, y: -0.34 },
            { x: 0.06, y: 0.20 },
            { x: 0.06, y: -0.20 },
            { x: 0.08, y: 0.00 },
            { x: 0.22, y: 0.10 },
            { x: 0.22, y: -0.10 },
        ];

        return seeds
            .map((seed) => ({
                x: seed.x + (Math.random() - 0.5) * 0.05,
                y: seed.y + (Math.random() - 0.5) * 0.05,
                sort: Math.random(),
            }))
            .sort((a, b) => a.sort - b.sort)
            .map(({ x, y }) => ({ x, y }));
    }

    private randomizeCubes() {
        if (!this.mjModel || !this.mjData) return;
        const positions: Array<{x: number, y: number}> = [];
        const spreadSeeds = this.buildSpreadWorkspaceSeeds();
        
        for (let i = 0; i < this.mjModel.nbody; i++) {
            const name = getName(this.mjModel, this.mjModel.name_bodyadr[i]);
            if (name.startsWith('cube')) {
                let x = 0;
                let y = 0;
                let valid = false;
                let attempts = 0;
                while (!valid && attempts < 100) {
                    const seed = spreadSeeds[(positions.length + attempts) % spreadSeeds.length];
                    x = seed.x + (Math.random() - 0.5) * 0.03;
                    y = seed.y + (Math.random() - 0.5) * 0.03;
                    valid = true;
                    const distStack = Math.sqrt((x - 0.6)**2 + y**2);
                    const distRobot = Math.sqrt(x**2 + y**2);
                    if (distStack < 0.18 || distRobot < 0.1 || distRobot > 0.42) valid = false;
                    if (valid) {
                        for (const p of positions) {
                            if ((p.x - x)**2 + (p.y - y)**2 < 0.0081) { valid = false; break; }
                        }
                    }
                    attempts++;
                }
                if (valid) {
                    positions.push({x, y});
                    
                    // Assuming body_jntadr exists in the model wrapper or bindings
                    // Standard MuJoCo has body_jntadr.
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    const jntIdVal = (this.mjModel as any).body_jntadr[i];
                    if (jntIdVal >= 0) {
                        const qp = this.mjModel.jnt_qposadr[jntIdVal];
                        this.mjData.qpos[qp] = x;
                        this.mjData.qpos[qp + 1] = y;
                        this.mjData.qpos[qp + 2] = 0.02;
                        // Orientation (Identity)
                        this.mjData.qpos[qp + 3] = 1;
                        this.mjData.qpos[qp + 4] = 0;
                        this.mjData.qpos[qp + 5] = 0;
                        this.mjData.qpos[qp + 6] = 0;
                    }
                }
            }
        }
    }

    private getAllCubeTargets() {
        if (!this.mjModel || !this.mjData) return [] as Array<{ label: string; position: THREE.Vector3 }>;

        const targets: Array<{ label: string; position: THREE.Vector3 }> = [];
        let targetIndex = 1;
        for (let i = 0; i < this.mjModel.nbody; i++) {
            const name = getName(this.mjModel, this.mjModel.name_bodyadr[i]);
            if (!name.startsWith('cube')) continue;

            targets.push({
                label: `Target ${targetIndex++}`,
                position: new THREE.Vector3(
                    this.mjData.xpos[i * 3],
                    this.mjData.xpos[i * 3 + 1],
                    this.mjData.xpos[i * 3 + 2],
                ),
            });
        }

        return targets;
    }

    private getBodyName(bodyId: number) {
        if (!this.mjModel || bodyId < 0 || bodyId >= this.mjModel.nbody) return '';
        return getName(this.mjModel, this.mjModel.name_bodyadr[bodyId]);
    }

    private getCubeBodyIds() {
        if (!this.mjModel) return [] as number[];

        const cubeBodyIds: number[] = [];
        for (let i = 0; i < this.mjModel.nbody; i++) {
            if (this.getBodyName(i).startsWith('cube')) {
                cubeBodyIds.push(i);
            }
        }
        return cubeBodyIds;
    }

    private getBodyPosition(bodyId: number) {
        if (!this.mjData) return new THREE.Vector3();
        return new THREE.Vector3(
            this.mjData.xpos[bodyId * 3],
            this.mjData.xpos[bodyId * 3 + 1],
            this.mjData.xpos[bodyId * 3 + 2],
        );
    }

    private getGripperPosition() {
        if (!this.mjData || this.ikSys.gripperSiteId < 0) return new THREE.Vector3();
        return new THREE.Vector3(
            this.mjData.site_xpos[this.ikSys.gripperSiteId * 3],
            this.mjData.site_xpos[this.ikSys.gripperSiteId * 3 + 1],
            this.mjData.site_xpos[this.ikSys.gripperSiteId * 3 + 2],
        );
    }

    private resolveTargetBodyIds(positions: THREE.Vector3[]) {
        const cubeBodyIds = this.getCubeBodyIds();
        const remaining = new Set(cubeBodyIds);
        const matched: number[] = [];

        for (const position of positions) {
            let bestBodyId = -1;
            let bestDistance = Number.POSITIVE_INFINITY;
            for (const bodyId of remaining) {
                const distance = this.getBodyPosition(bodyId).distanceTo(position);
                if (distance < bestDistance) {
                    bestDistance = distance;
                    bestBodyId = bodyId;
                }
            }

            if (bestBodyId !== -1) {
                matched.push(bestBodyId);
                remaining.delete(bestBodyId);
            }
        }

        return matched;
    }

    private resetExecutionState(positions: THREE.Vector3[]) {
        this.executionInvalidRun = false;
        this.executionFailureReason = null;
        this.executionFailureMessage = null;
        this.executionFailedStepIndex = null;
        this.executionFailedStepName = null;
        this.executionFailedTargetIndex = null;
        this.executionCollisionPairs.clear();
        this.executionTargetBodyIds = this.resolveTargetBodyIds(positions);
        this.executionCompletedBodyIds.clear();
        this.executionInitialCubePositions = new Map(
            this.getCubeBodyIds().map((bodyId) => [bodyId, this.getBodyPosition(bodyId)]),
        );
    }

    private classifyBody(bodyId: number) {
        if (bodyId <= 0) return 'environment' as const;
        const name = this.getBodyName(bodyId).toLowerCase();
        if (!name) return 'environment' as const;
        if (name.startsWith('cube')) return 'cube' as const;
        if (name === 'tray' || name === 'stack_base' || name.includes('floor') || name.includes('ground') || name.includes('table') || name.includes('plane')) {
            return 'environment' as const;
        }
        return 'robot' as const;
    }

    private inspectCollisionState(currentTargetBodyId: number | null) {
        if (!this.mjData) {
            return null as null | { reason: string; message: string };
        }

        const gripperPos = this.getGripperPosition();
        if (gripperPos.z < 0.015) {
            const pairLabel = 'gripper <-> environment';
            this.executionCollisionPairs.add(pairLabel);
            return {
                reason: 'collision',
                message: `Detected unintended contact: ${pairLabel}.`,
            };
        }

        for (const bodyId of this.getCubeBodyIds()) {
            if (bodyId === currentTargetBodyId || this.executionCompletedBodyIds.has(bodyId)) continue;

            const cubePos = this.getBodyPosition(bodyId);
            const distanceToGripper = cubePos.distanceTo(gripperPos);
            if (distanceToGripper < 0.035) {
                const pairLabel = `${this.getBodyName(bodyId)} <-> gripper`;
                this.executionCollisionPairs.add(pairLabel);
                return {
                    reason: 'collision',
                    message: `Detected unintended contact: ${pairLabel}.`,
                };
            }
        }

        return null;
    }

    private monitorExecutionState() {
        const currentStep = this.sequenceAnimator.getCurrentStepIndex();
        const currentTargetIndex = this.sequenceAnimator.getCurrentTargetIndex();
        const currentStepName = this.sequenceAnimator.getCurrentStepName();
        const currentTargetBodyId =
            currentTargetIndex !== null && currentTargetIndex < this.executionTargetBodyIds.length
                ? this.executionTargetBodyIds[currentTargetIndex]
                : null;

        const collisionFailure = this.inspectCollisionState(currentTargetBodyId);
        if (collisionFailure) {
            return {
                reason: collisionFailure.reason,
                message: collisionFailure.message,
                failedStepIndex: currentStep,
                failedStepName: currentStepName,
                failedTargetIndex: currentTargetIndex,
            };
        }

        for (const [bodyId, initialPos] of this.executionInitialCubePositions.entries()) {
            if (this.executionCompletedBodyIds.has(bodyId) || bodyId === currentTargetBodyId) continue;
            const currentPos = this.getBodyPosition(bodyId);
            const planarShift = Math.hypot(currentPos.x - initialPos.x, currentPos.y - initialPos.y);
            const verticalShift = Math.abs(currentPos.z - initialPos.z);
            if (planarShift > 0.05 || verticalShift > 0.04 || currentPos.z < 0.005) {
                return {
                    reason: 'scene_disturbance',
                    message: `Unrelated object ${this.getBodyName(bodyId)} moved unexpectedly during execution.`,
                    failedStepIndex: currentStep,
                    failedStepName: currentStepName,
                    failedTargetIndex: currentTargetIndex,
                };
            }
        }

        if (currentTargetBodyId === null || currentStep === null) return null;

        const targetPos = this.getBodyPosition(currentTargetBodyId);
        const gripperPos = this.getGripperPosition();
        const gripDistance = targetPos.distanceTo(gripperPos);
        const initialTargetPos = this.executionInitialCubePositions.get(currentTargetBodyId);
        const liftedEnough = initialTargetPos ? targetPos.z > initialTargetPos.z + 0.03 : targetPos.z > 0.05;

        if (currentStep >= 7 && currentStep <= 10) {
            if (gripDistance > 0.09 && !liftedEnough) {
                return {
                    reason: 'grasp_missed',
                    message: `Target ${this.getBodyName(currentTargetBodyId)} was not secured after grasp closure.`,
                    failedStepIndex: currentStep,
                    failedStepName: currentStepName,
                    failedTargetIndex: currentTargetIndex,
                };
            }

            if (gripDistance > 0.12 || targetPos.z < 0.01) {
                return {
                    reason: currentStep >= 8 ? 'object_dropped' : 'grasp_missed',
                    message: `Target ${this.getBodyName(currentTargetBodyId)} separated from the gripper during transport.`,
                    failedStepIndex: currentStep,
                    failedStepName: currentStepName,
                    failedTargetIndex: currentTargetIndex,
                };
            }
        }

        return null;
    }

    private failExecution(failure: {
        reason: string;
        message: string;
        failedStepIndex: number | null;
        failedStepName: string | null;
        failedTargetIndex: number | null;
    }) {
        if (this.executionInvalidRun) return;

        this.executionInvalidRun = true;
        this.executionFailureReason = failure.reason;
        this.executionFailureMessage = failure.message;
        this.executionFailedStepIndex = failure.failedStepIndex;
        this.executionFailedStepName = failure.failedStepName;
        this.executionFailedTargetIndex = failure.failedTargetIndex;
        this.sequenceAnimator.stop();
        this.executionSkippedCount = Math.max(0, this.executionTargetCount - this.executionCompletedCount);
    }

    private getDropPose(dropIndex: number) {
        if (!this.mjModel || !this.mjData) return null;

        let trayId = -1;
        for (let i = 0; i < this.mjModel.nbody; i++) {
            const name = getName(this.mjModel, this.mjModel.name_bodyadr[i]);
            if (name === 'stack_base' || (!this.isStackingScene && name === 'tray')) {
                trayId = i;
                break;
            }
        }

        if (trayId === -1) return null;

        const dropPos = new THREE.Vector3(
            this.mjData.xpos[trayId * 3],
            this.mjData.xpos[trayId * 3 + 1],
            this.mjData.xpos[trayId * 3 + 2],
        );
        let hoverZ = dropPos.z + 0.2;
        let dropZ = dropPos.z + 0.05;

        if (this.isStackingScene) {
            const layerIdx = Math.floor(dropIndex / 9);
            const posInLayer = dropIndex % 9;
            const row = Math.floor(posInLayer / 3);
            const col = posInLayer % 3;

            dropPos.x += (row - 1) * 0.06;
            dropPos.y += (col - 1) * 0.06;
            dropZ = 0.005 + 0.02 + (layerIdx * 0.04) + 0.02 + 0.04;
            hoverZ = dropZ + 0.1;
        }

        dropPos.z = dropZ;
        return {
            hover: new THREE.Vector3(dropPos.x, dropPos.y, hoverZ),
            drop: dropPos,
        };
    }

    private isExecutableTarget(position: THREE.Vector3, dropIndex: number) {
        if (!this.mjData) return false;

        const downQuat = new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.PI, 0, 0));
        const currentJoints: number[] = [];
        for (let i = 0; i < 7; i++) currentJoints.push(this.mjData.qpos[i]);

        const moveAbovePos = new THREE.Vector3(position.x, position.y, 0.45);
        const hoverPos = new THREE.Vector3(position.x, position.y, position.z + 0.2);
        const graspPos = new THREE.Vector3(position.x, position.y, position.z);
        const dropPose = this.getDropPose(dropIndex);
        if (!dropPose) return false;

        const sol0 = this.ikSys.solve(moveAbovePos, downQuat, currentJoints);
        if (!sol0) return false;
        const sol1 = this.ikSys.solve(hoverPos, downQuat, sol0);
        if (!sol1) return false;
        const sol2 = this.ikSys.solve(graspPos, downQuat, sol1);
        if (!sol2) return false;
        const sol3 = this.ikSys.solve(hoverPos, downQuat, sol2);
        if (!sol3) return false;
        const sol4 = this.ikSys.solve(dropPose.hover, downQuat, sol3);
        if (!sol4) return false;
        const sol5 = this.ikSys.solve(dropPose.drop, downQuat, sol4);
        return Boolean(sol5);
    }

    private getExecutableSceneTargets() {
        const targets = this.getAllCubeTargets();
        const executable: Array<{ label: string; position: THREE.Vector3 }> = [];
        const savedPos = this.ikSys.target.position.clone();
        const savedQuat = this.ikSys.target.quaternion.clone();

        for (const target of targets) {
            if (this.isExecutableTarget(target.position, executable.length)) {
                executable.push(target);
            }
        }

        this.ikSys.target.position.copy(savedPos);
        this.ikSys.target.quaternion.copy(savedQuat);

        return executable;
    }

    private ensureExecutableScene(minTargets = 6, maxAttempts = 30) {
        if (!this.mjModel || !this.mjData) return;

        for (let attempt = 0; attempt < maxAttempts; attempt++) {
            const executable = this.getExecutableSceneTargets();
            if (executable.length >= minTargets || attempt === maxAttempts - 1) {
                return;
            }

            this.randomizeCubes();
            this.syncSceneState();
        }
    }

    captureSceneLayout(): SceneLayoutTarget[] {
        if (!this.mjModel || !this.mjData) return [];

        const layout: SceneLayoutTarget[] = [];
        let targetIndex = 1;
        for (let i = 0; i < this.mjModel.nbody; i++) {
            const name = getName(this.mjModel, this.mjModel.name_bodyadr[i]);
            if (!name.startsWith('cube')) continue;

            layout.push({
                label: `Target ${targetIndex++}`,
                x: Number(this.mjData.xpos[i * 3].toFixed(4)),
                y: Number(this.mjData.xpos[i * 3 + 1].toFixed(4)),
                z: Number(this.mjData.xpos[i * 3 + 2].toFixed(4)),
            });
        }

        return layout;
    }

    applySceneLayout(layout: SceneLayoutTarget[]) {
        if (!this.mjModel || !this.mjData) return;

        this.renderSys.clearErMarkers();
        this.gizmoAnim.active = false;
        this.sequenceAnimator.reset();
        this.mujoco.mj_resetData(this.mjModel, this.mjData);
        this.setInitialPose();

        let layoutIndex = 0;
        for (let i = 0; i < this.mjModel.nbody && layoutIndex < layout.length; i++) {
            const name = getName(this.mjModel, this.mjModel.name_bodyadr[i]);
            if (!name.startsWith('cube')) continue;

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const jntIdVal = (this.mjModel as any).body_jntadr[i];
            if (jntIdVal >= 0) {
                const qp = this.mjModel.jnt_qposadr[jntIdVal];
                const target = layout[layoutIndex];
                this.mjData.qpos[qp] = target.x;
                this.mjData.qpos[qp + 1] = target.y;
                this.mjData.qpos[qp + 2] = target.z;
                this.mjData.qpos[qp + 3] = 1;
                this.mjData.qpos[qp + 4] = 0;
                this.mjData.qpos[qp + 5] = 0;
                this.mjData.qpos[qp + 6] = 0;
                layoutIndex++;
            }
        }

        this.syncSceneState();
        this.ikSys.target.quaternion.setFromEuler(new THREE.Euler(Math.PI, 0, 0));
        this.ikSys.target.position.set(0, 0, 0.45);
        this.firstIkEnable = true;
    }

    private startLoop() {
        if (this.frameId) cancelAnimationFrame(this.frameId);

        const loop = () => {
            if (!this.mjModel || !this.mjData) {
                 this.frameId = requestAnimationFrame(loop);
                 return;
            }

            this.dragStateManager.update();
            if (this.draggedBodyId() !== null) this.mjData.xfrc_applied.fill(0);
            if (this.dragStateManager.active && this.dragStateManager.physicsObject) {
                this.applyDragForce();
            }
            
            if (this.gizmoAnim.active) {
                const now = performance.now();
                const elapsed = now - this.gizmoAnim.startTime;
                const t = Math.min(elapsed / this.gizmoAnim.duration, 1.0);
                const ease = 1 - Math.pow(1 - t, 3);
                
                this.ikSys.target.position.lerpVectors(this.gizmoAnim.startPos, this.gizmoAnim.endPos, ease);
                this.ikSys.target.quaternion.slerpQuaternions(this.gizmoAnim.startRot, this.gizmoAnim.endRot, ease);
                
                if (t >= 1.0) {
                    this.gizmoAnim.active = false;
                }
            }

            if (!this.paused) {
                if (this.sequenceAnimator.running) {
                    this.sequenceAnimator.update((1/60) * this.speedMultiplier, this.ikSys.target, this.mjData, this.gripperActuatorId, this.ikSys);
                    this.setIkEnabled(false);
                } else {
                     this.syncIkState();
                     this.ikSys.update(this.mjModel, this.mjData);
                }

                const startSimTime = this.mjData.time;
                // Allow simulation to run faster than real-time based on speedMultiplier
                while (this.mjData.time - startSimTime < (1.0 / 60.0) * this.speedMultiplier) {
                    this.mujoco.mj_step(this.mjModel, this.mjData);
                }
                if (this.sequenceAnimator.running) {
                    const failure = this.monitorExecutionState();
                    if (failure) {
                        this.failExecution(failure);
                    }
                }
            }

            if (this.renderEnabled) {
                this.renderSys.update(this.mjData, this.renderSys.contactMarkers.visible);
            }
            this.frameId = requestAnimationFrame(loop);
        };
        this.frameId = requestAnimationFrame(loop);
    }

    private draggedBodyId(): number | null { 
        return this.dragStateManager.active && this.dragStateManager.physicsObject ? this.dragStateManager.physicsObject.userData.bodyID : null; 
    }

    private applyDragForce() {
        if (!this.mjData) return;
        const bodyId = this.draggedBodyId()!;
        const force = new THREE.Vector3().subVectors(this.dragStateManager.currentWorld, this.dragStateManager.worldHit).multiplyScalar(1.5);
        if (force.lengthSq() > 25) force.setLength(5.0); 
        
        const bodyPos = new THREE.Vector3().fromArray(this.mjData.xpos, bodyId * 3);
        const leverArm = new THREE.Vector3().subVectors(this.dragStateManager.worldHit, bodyPos);
        const torque = leverArm.cross(force);

        this.mjData.xfrc_applied.set([force.x, force.y, force.z, torque.x, torque.y, torque.z], bodyId * 6);
    }
    
    private syncIkState() {
        const shouldCalculate = this.userIkEnabled;
        const shouldShowGizmo = this.userIkEnabled && !this.gizmoAnim.active && !this.sequenceAnimator.running; 
        
        this.ikSys.setCalculating(shouldCalculate);
        this.ikSys.setGizmoVisible(shouldShowGizmo);
        
        if (this.sequenceAnimator.running) {
            this.ikSys.setTargetVisible(true);
        } else if(shouldCalculate) {
            this.ikSys.setTargetVisible(true);
        }
    }

    moveIkTargetTo(pos: THREE.Vector3, duration = 0) {
        if (!this.userIkEnabled) {
            this.setIkEnabled(true);
        }
        
        const targetPos = new THREE.Vector3(pos.x, pos.y, pos.z + 0.05);
        const targetRot = new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.PI, 0, 0));

        if (duration > 0) {
            this.gizmoAnim.active = true;
            this.gizmoAnim.startPos.copy(this.ikSys.target.position);
            this.gizmoAnim.endPos.copy(targetPos);
            this.gizmoAnim.startRot.copy(this.ikSys.target.quaternion);
            this.gizmoAnim.endRot.copy(targetRot);
            this.gizmoAnim.startTime = performance.now();
            this.gizmoAnim.duration = duration;
        } else {
            this.gizmoAnim.active = false;
            this.ikSys.target.position.copy(targetPos);
            this.ikSys.target.quaternion.copy(targetRot);
        }
    }

    pickupItems(positions: THREE.Vector3[], markerIds: number[], labels?: string[], onFinished?: () => void) {
        if (this.sequenceAnimator && this.mjData) {
            this.executionStartTime = performance.now();
            this.executionStartSimTime = this.mjData.time;
            this.executionTargetCount = positions.length;
            this.executionAttemptedCount = positions.length;
            this.executionCompletedCount = 0;
            this.executionSkippedCount = 0;
            this.executionTimeoutCount = 0;
            this.resetExecutionState(positions);
            this.ikSys.syncToSite(this.mjData);
            const started = this.sequenceAnimator.start(
                this.ikSys.target, 
                this.mjData, 
                this.ikSys, 
                { positions, markerIds, labels }, 
                (markerId) => {
                    const completedBodyId = this.executionTargetBodyIds[this.executionCompletedCount];
                    if (completedBodyId !== undefined) {
                        this.executionCompletedBodyIds.add(completedBodyId);
                    }
                    this.executionCompletedCount += 1;
                    this.renderSys.removeMarkerById(markerId);
                },
                onFinished
            );
            this.setIkEnabled(false);
            if (!started) {
                this.executionSkippedCount = positions.length;
            }
        }
    }

    runHeadlessPickupSequence(positions: THREE.Vector3[], markerIds: number[], labels?: string[]) {
        if (!this.sequenceAnimator || !this.mjData || !this.mjModel) {
            return this.getLastExecutionMetrics();
        }

        const wasPaused = this.paused;
        this.paused = true;

        this.executionStartTime = performance.now();
        this.executionStartSimTime = this.mjData.time;
        this.executionTargetCount = positions.length;
        this.executionAttemptedCount = positions.length;
        this.executionCompletedCount = 0;
        this.executionSkippedCount = 0;
        this.executionTimeoutCount = 0;
        this.resetExecutionState(positions);
        this.ikSys.syncToSite(this.mjData);
        const started = this.sequenceAnimator.start(
            this.ikSys.target,
            this.mjData,
            this.ikSys,
            { positions, markerIds, labels },
            () => {
                const completedBodyId = this.executionTargetBodyIds[this.executionCompletedCount];
                if (completedBodyId !== undefined) {
                    this.executionCompletedBodyIds.add(completedBodyId);
                }
                this.executionCompletedCount += 1;
            },
        );
        this.setIkEnabled(false);

        if (!started) {
            this.executionSkippedCount = positions.length;
            this.paused = wasPaused;
            return this.getLastExecutionMetrics();
        }

        let iterations = 0;
        const maxIterations = Math.max(2400, positions.length * 2400);
        while (this.sequenceAnimator.running && iterations < maxIterations) {
            this.sequenceAnimator.update((1 / 60) * this.speedMultiplier, this.ikSys.target, this.mjData, this.gripperActuatorId, this.ikSys);
            const startSimTime = this.mjData.time;
            while (this.mjData.time - startSimTime < (1.0 / 60.0) * this.speedMultiplier) {
                this.mujoco.mj_step(this.mjModel, this.mjData);
            }
            const failure = this.monitorExecutionState();
            if (failure) {
                this.failExecution(failure);
                break;
            }
            iterations++;
        }

        if (!this.executionInvalidRun && iterations >= maxIterations) {
            this.sequenceAnimator.stop();
            this.executionTimeoutCount = Math.max(1, positions.length - this.executionCompletedCount);
            this.executionSkippedCount = positions.length - this.executionCompletedCount;
        }

        this.paused = wasPaused;
        return this.getLastExecutionMetrics();
    }

    getLastExecutionMetrics() {
        const breakdown = this.sequenceAnimator.getExecutionBreakdown();
        const simDuration = this.executionStartSimTime !== null && this.mjData
            ? Math.max(0, this.mjData.time - this.executionStartSimTime)
            : 0;
        const animatedDuration = this.sequenceAnimator.getElapsedRunTime();
        const wallClockDuration = this.executionStartTime
            ? Math.max(0, (performance.now() - this.executionStartTime) / 1000)
            : 0;
        const targetDuration = breakdown.perTargetBreakdown.reduce((sum, item) => sum + item.totalDurationSec, 0);
        const trailingDuration = breakdown.stepTimeline
            .filter((step) => step.targetIndex === null)
            .reduce((sum, step) => sum + step.durationSec, 0);
        const actionDuration = targetDuration + trailingDuration;
        const timedOut = this.executionTimeoutCount > 0;
        const timeoutDurationSec = timedOut ? actionDuration : 0;
        const durationSec = timedOut || this.executionInvalidRun ? 0 : actionDuration;
        const durationDeltaSec = Math.abs(actionDuration - (targetDuration + trailingDuration));
        const failedStepIndex = this.executionFailedStepIndex ?? breakdown.failedStepIndex ?? undefined;
        const failedStepName = this.executionFailedStepName ?? breakdown.failedStepName;
        const failedTargetIndex = this.executionFailedTargetIndex ?? breakdown.failedTargetIndex ?? undefined;
        const failedTargetLabel = failedTargetIndex !== undefined
            ? (breakdown.failedTargetIndex === failedTargetIndex && breakdown.failedTargetLabel
                ? breakdown.failedTargetLabel
                : `Target ${failedTargetIndex + 1}`)
            : breakdown.failedTargetLabel;

        return {
            durationSec,
            actionDurationSec: actionDuration,
            simDurationSec: simDuration,
            wallClockSec: wallClockDuration,
            durationSource: 'action',
            invalidRun: this.executionInvalidRun,
            failureReason: this.executionFailureReason ?? undefined,
            failureMessage: this.executionFailureMessage ?? undefined,
            targetCount: this.executionTargetCount,
            attemptedCount: this.executionAttemptedCount,
            completedCount: this.executionCompletedCount,
            skippedCount: this.executionSkippedCount,
            completionRate: this.executionTargetCount > 0 ? this.executionCompletedCount / this.executionTargetCount : 0,
            endedByTimeout: timedOut,
            timeoutCount: this.executionTimeoutCount,
            timeoutDurationSec,
            collisionCount: this.executionCollisionPairs.size,
            collisionPairs: Array.from(this.executionCollisionPairs),
            hadGroundCollision: Array.from(this.executionCollisionPairs).some((pair) => /floor|ground|table|plane/i.test(pair)),
            hadObjectCollision: Array.from(this.executionCollisionPairs).some((pair) => /cube/i.test(pair)),
            failedStepIndex,
            failedStepName: failedStepName ?? undefined,
            failedTargetIndex,
            failedTargetLabel,
            perTargetBreakdown: breakdown.perTargetBreakdown,
            stepTimeline: breakdown.stepTimeline,
            validationChecks: {
                durationConsistent: durationDeltaSec < 1e-6,
                durationDeltaSec,
                durationSourceDeclared: true,
                executionValid: !this.executionInvalidRun && !timedOut && this.executionCompletedCount === this.executionTargetCount,
            },
        };
    }

    getSceneTargets() {
        const executable = this.getExecutableSceneTargets();
        if (executable.length > 0) return executable;
        return this.getAllCubeTargets();
    }

    randomizeSceneObjects() {
        if (!this.mjModel || !this.mjData) return;
        this.renderSys.clearErMarkers();
        this.sequenceAnimator.reset();
        this.randomizeCubes();
        this.syncSceneState();
        this.ensureExecutableScene();
        this.setIkEnabled(false);
    }

    reset() {
        if (!this.mjModel || !this.mjData) return;
        this.renderSys.clearErMarkers();
        this.gizmoAnim.active = false;
        this.sequenceAnimator.reset(); 
        this.mujoco.mj_resetData(this.mjModel, this.mjData);
        this.setInitialPose();
        this.randomizeCubes(); 
        this.syncSceneState();
        this.ensureExecutableScene();
        
        this.ikSys.target.quaternion.setFromEuler(new THREE.Euler(Math.PI, 0, 0));
        this.ikSys.target.position.set(0, 0, 0.45);
        this.firstIkEnable = true;
    }
    
    togglePause() { return this.paused = !this.paused; }
    
    setIkEnabled(enabled: boolean) {
        this.userIkEnabled = enabled;
        this.syncIkState();
        if (enabled && this.mjData && !this.gizmoAnim.active && !this.sequenceAnimator.running) {
            if (this.firstIkEnable) {
                this.ikSys.target.quaternion.setFromEuler(new THREE.Euler(Math.PI, 0, 0));
                this.ikSys.target.position.set(0, 0, 0.45);
                this.firstIkEnable = false;
            } else {
                this.ikSys.syncToSite(this.mjData);
            }
        }
    }
    
    setSpeedMultiplier(speed: number) {
        this.speedMultiplier = speed;
    }

    setRenderEnabled(enabled: boolean) {
        this.renderEnabled = enabled;
    }

    setMotionProfile(scale: number, continuityBoost = 0, accelerationBias = 0, trajectoryHints: TrajectoryTargetHint[] = []) {
        this.sequenceAnimator.setMotionProfile(scale, continuityBoost, accelerationBias, trajectoryHints);
    }

    renderFrame() {
        if (!this.mjData) return;
        this.renderSys.update(this.mjData, this.renderSys.contactMarkers.visible);
    }
    
    getGizmoStats() { return this.ikSys.calculating && this.ikSys.target ? { pos: this.ikSys.target.position.clone(), rot: new THREE.Euler().setFromQuaternion(this.ikSys.target.quaternion) } : null; }
    
    dispose() {
        if (this.frameId) cancelAnimationFrame(this.frameId);
        this.dragStateManager.dispose(); 
        this.selectionManager.dispose(); 
        this.renderSys.dispose(); 
        this.ikSys.dispose();
        if (this.mjvOption) this.mjvOption.delete(); 
        if (this.mjModel) this.mjModel.delete(); 
        if (this.mjData) this.mjData.delete();
        try { this.mujoco.FS.unmount('/working'); } catch (e) { /* ignore */ }
    }
}
