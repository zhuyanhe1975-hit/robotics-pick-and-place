/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/


import * as THREE from 'three';
import { IkSystem } from './IkSystem';
import { ExecutionStepMetric, ExecutionTargetBreakdown, MujocoData, MujocoModel, TrajectoryTargetHint } from './types';

/**
 * SequenceAnimator
 * A simple state machine that automates the robot.
 * Uses Joint Space Interpolation: solves IK for the target Step and interpolates joint angles.
 */
export class SequenceAnimator {
    running = false;
    step = 0; // Current step index in the sequence
    names: string[];  // Human-readable names for each step
    
    private timer = 0;    // Time elapsed in current step
    private duration = 1.0;       // Total duration for current step
    
    private cubeIds: number[] = []; // MuJoCo body IDs of the cubes to pick up (for Live mode)
    private curCubeIdx = 0; // Which cube are we currently trying to pick?
    private droppedCount = 0; // How many cubes have been successfully stacked
    private trayId = -1;    // Body ID of the target tray
    
    // New: Explicit Target Positions (for Blind/ER mode)
    private targetPositions: THREE.Vector3[] = [];
    private markerIds: number[] = [];
    private targetLabels: string[] = [];
    private useLivePosition = false;
    
    // Visual Interpolation start/end points (for the gizmo)
    private startPos = new THREE.Vector3(); 
    private startQuat = new THREE.Quaternion();
    private targetPos = new THREE.Vector3(); 
    private targetQuat = new THREE.Quaternion();
    
    // Joint Interpolation
    private startJoints: number[] = [];
    private targetJoints: number[] = [];
    
    private gripperVal = 0; // 0 = Open/Closed (dependent on model, usually 0=Closed, 255/0.08=Open)
    private isStacking = false;
    private motionTimeScale = 0.85;
    private continuityBoost = 0;
    private accelerationBias = 0;
    private elapsedRunTime = 0;
    private stepTimeline: ExecutionStepMetric[] = [];
    private targetBreakdowns = new Map<number, ExecutionTargetBreakdown>();
    private trajectoryHints = new Map<number, TrajectoryTargetHint>();
    private failedStepIndex: number | null = null;
    private failedTargetIndex: number | null = null;
    private validationTimeScale = 1.0;
    
    // Callback to notify app of completion of a single pickup (passes Body ID or Marker ID)
    private onPickupComplete?: (id: number) => void;
    // Callback to notify app when the entire sequence is finished
    private onFinished?: () => void;

    private finishRun() {
        this.running = false;
        this.step = 0;
        this.curCubeIdx = 0;
        if (this.onFinished) this.onFinished();
    }

    private getStepPhase(stepIndex: number): ExecutionStepMetric['phase'] {
        if (stepIndex <= 1) return 'approach';
        if (stepIndex <= 6) return 'grasp';
        if (stepIndex <= 8) return 'transfer';
        if (stepIndex <= 13) return 'place';
        return 'return-home';
    }

    private getTargetLabel(targetIndex: number | null) {
        if (targetIndex === null || targetIndex < 0) return null;
        if (targetIndex < this.targetLabels.length && this.targetLabels[targetIndex]) {
            return this.targetLabels[targetIndex];
        }
        return `Target ${targetIndex + 1}`;
    }

    private recordCompletedStep(stepIndex: number, durationSec: number) {
        if (!Number.isFinite(durationSec) || durationSec <= 0) return;

        const isTargetStep = stepIndex >= 0 && stepIndex <= 13;
        const targetIndex = isTargetStep ? this.curCubeIdx : null;
        const targetLabel = this.getTargetLabel(targetIndex);
        const phase = this.getStepPhase(stepIndex);

        this.stepTimeline.push({
            stepIndex,
            stepName: this.names[stepIndex] ?? `Step ${stepIndex}`,
            phase,
            durationSec,
            targetIndex,
            targetLabel,
        });

        if (targetIndex === null || targetLabel === null) return;

        const breakdown = this.targetBreakdowns.get(targetIndex) ?? {
            targetIndex,
            targetLabel,
            totalDurationSec: 0,
            approachSec: 0,
            graspSec: 0,
            transferSec: 0,
            placeSec: 0,
            stepCount: 0,
        };

        breakdown.totalDurationSec += durationSec;
        breakdown.stepCount += 1;
        if (phase === 'approach') breakdown.approachSec += durationSec;
        if (phase === 'grasp') breakdown.graspSec += durationSec;
        if (phase === 'transfer') breakdown.transferSec += durationSec;
        if (phase === 'place') breakdown.placeSec += durationSec;

        this.targetBreakdowns.set(targetIndex, breakdown);
    }

    private computeStepDuration(baseDuration: number, targetJoints?: number[]) {
        if (!targetJoints || this.startJoints.length !== targetJoints.length) {
            return Math.max(0.02, baseDuration);
        }

        const cartesianDistance = this.startPos.distanceTo(this.targetPos);
        let jointTravel = 0;
        for (let i = 0; i < this.startJoints.length; i++) {
            jointTravel += Math.abs(this.startJoints[i] - targetJoints[i]);
        }

        const distanceFactor = 0.45 + cartesianDistance * 2.4;
        const jointFactor = 0.35 + jointTravel * 0.22;
        let dynamicFactor = Math.max(distanceFactor, jointFactor);
        const phase = this.getStepPhase(this.step);
        const trajectoryHint = this.curCubeIdx < this.targetLabels.length ? this.trajectoryHints.get(this.curCubeIdx) : undefined;

        if (phase === 'transfer') {
            dynamicFactor *= 1 - (this.continuityBoost * 0.12 + this.accelerationBias * 0.08);
            if (trajectoryHint) {
                dynamicFactor *= Math.max(0.78, Math.min(1.45, trajectoryHint.transferPathLength / Math.max(0.001, cartesianDistance)));
                dynamicFactor *= 1 - Math.min(0.18, Math.max(0, trajectoryHint.transferWaypointCount - 2) * 0.02 * this.continuityBoost);
            }
        } else if (phase === 'approach' && this.curCubeIdx > 0) {
            dynamicFactor *= 1 - (this.continuityBoost * 0.08 + this.accelerationBias * 0.06);
            if (trajectoryHint) {
                dynamicFactor *= Math.max(0.82, Math.min(1.35, trajectoryHint.approachPathLength / Math.max(0.001, cartesianDistance)));
                dynamicFactor *= 1 - Math.min(0.12, Math.max(0, trajectoryHint.approachWaypointCount - 2) * 0.015 * this.continuityBoost);
            }
        } else if (phase === 'approach') {
            dynamicFactor *= 1 - this.accelerationBias * 0.04;
            if (trajectoryHint) {
                dynamicFactor *= Math.max(0.85, Math.min(1.25, trajectoryHint.approachPathLength / Math.max(0.001, cartesianDistance)));
            }
        }

        return Math.max(0.02, baseDuration * Math.max(0.7, dynamicFactor));
    }

    private finalizeStepDuration(baseDuration: number, useExplicitJoints: boolean) {
        if (useExplicitJoints) {
            this.duration = Math.max(0.05, baseDuration);
            return;
        }

        this.duration = this.computeStepDuration(baseDuration, this.targetJoints);
    }

    constructor() {
        this.names = ["Move over Cube", "Hover", "Open", "Lower", "Wait", "Grasp", "Wait", "Lift", "Move to Tray", "Lower", "Wait", "Release", "Wait", "Lift", "Return Home"];
    }

    // Initialize by finding the IDs of all cubes and the tray
    init(mjModel: MujocoModel, isStacking: boolean, getName: (addr: number) => string) {
        this.isStacking = isStacking;
        // Default initialization just scans the scene
        this.trayId = -1;
        for (let i = 0; i < mjModel.nbody; i++) {
            const n = getName(mjModel.name_bodyadr[i]);
            if (n === 'stack_base' || (!isStacking && n === 'tray')) this.trayId = i;
        }
    }

    /**
     * Start the sequence.
     * @param targets Can be an array of body IDs (number[]) OR an object with { positions, markerIds } for blind mode.
     */
    start(ikTarget: THREE.Object3D, mjData: MujocoData, ikSystem: IkSystem, 
          targets?: { positions: THREE.Vector3[], markerIds: number[], labels?: string[] } | number[], 
          onPickupComplete?: (id: number) => void,
          onFinished?: () => void): boolean {
        
        this.onPickupComplete = onPickupComplete;
        this.onFinished = onFinished;
        
        if (targets && !Array.isArray(targets) && 'positions' in targets) {
             // Static Positions Mode (ER/Blind)
             this.targetPositions = targets.positions;
             this.markerIds = targets.markerIds;
             this.targetLabels = targets.labels ?? targets.positions.map((_, index) => `Target ${index + 1}`);
             this.useLivePosition = false;
             this.cubeIds = []; 
        } else {
             // Default / ID mode
             this.useLivePosition = true;
             if (Array.isArray(targets) && targets.length > 0) {
                 this.cubeIds = [...targets];
             } else {
                 this.cubeIds = [];
             }
             this.targetLabels = this.cubeIds.map((_, index) => `Target ${index + 1}`);
        }

        // If `init` was called, `trayId` is set. 
        if (this.trayId === -1) {
            if (this.onFinished) this.onFinished();
            return false; // No drop zone
        }

        // Safety check
        if (this.useLivePosition && this.cubeIds.length === 0) {
            if (this.onFinished) this.onFinished();
            return false;
        }
        if (!this.useLivePosition && this.targetPositions.length === 0) {
            if (this.onFinished) this.onFinished();
            return false;
        }
        
        this.running = true; 
        this.step = 0; 
        this.curCubeIdx = 0;
        this.elapsedRunTime = 0;
        this.stepTimeline = [];
        this.targetBreakdowns.clear();
        this.trajectoryHints.clear();
        this.failedStepIndex = null;
        this.failedTargetIndex = null;
        // NOTE: We do NOT reset droppedCount here. It persists across pickup batches.
        
        this.gripperVal = 0;
        this.prepareStep(ikTarget, mjData, ikSystem);
        return this.running;
    }

    stop() {
        const finished = this.running;
        this.running = false;
        if (finished && this.onFinished) {
            this.onFinished();
        }
    }

    // Full reset (e.g. when simulation resets)
    reset() {
        this.running = false;
        this.step = 0;
        this.curCubeIdx = 0;
        this.droppedCount = 0;
        this.gripperVal = 0;
        this.motionTimeScale = 0.85;
        this.continuityBoost = 0;
        this.accelerationBias = 0;
        this.elapsedRunTime = 0;
        this.stepTimeline = [];
        this.targetBreakdowns.clear();
        this.trajectoryHints.clear();
        this.failedStepIndex = null;
        this.failedTargetIndex = null;
    }

    setMotionProfile(scale: number, continuityBoost = 0, accelerationBias = 0, trajectoryHints: TrajectoryTargetHint[] = []) {
        this.motionTimeScale = Math.min(1.0, Math.max(0.05, scale));
        this.continuityBoost = Math.min(1, Math.max(0, continuityBoost));
        this.accelerationBias = Math.min(1, Math.max(0, accelerationBias));
        this.trajectoryHints = new Map(trajectoryHints.map((hint) => [hint.targetIndex, hint]));
    }

    getElapsedRunTime() {
        return this.elapsedRunTime;
    }

    getExecutionBreakdown() {
        return {
            failedStepIndex: this.failedStepIndex,
            failedStepName: this.failedStepIndex !== null ? (this.names[this.failedStepIndex] ?? `Step ${this.failedStepIndex}`) : undefined,
            failedTargetIndex: this.failedTargetIndex ?? undefined,
            failedTargetLabel: this.getTargetLabel(this.failedTargetIndex),
            perTargetBreakdown: Array.from(this.targetBreakdowns.values()).sort((a, b) => a.targetIndex - b.targetIndex),
            stepTimeline: [...this.stepTimeline],
        };
    }

    getCurrentStepIndex() {
        return this.running ? this.step : null;
    }

    getCurrentStepName() {
        return this.running ? (this.names[this.step] ?? `Step ${this.step}`) : null;
    }

    getCurrentTargetIndex() {
        return this.running && this.curCubeIdx < (this.useLivePosition ? this.cubeIds.length : this.targetPositions.length)
            ? this.curCubeIdx
            : null;
    }

    // Called every frame to smoothly move the joints towards destination
    update(dt: number, ikTarget: THREE.Object3D, mjData: MujocoData, gripperId: number, ikSystem: IkSystem) {
        if (!this.running) return;
        this.elapsedRunTime += dt;
        
        this.timer += dt;
        // Percentage complete of current step (0.0 to 1.0)
        const p = Math.min(this.timer / this.duration, 1.0);
        
        // Ease-in-out for smoother movement (Smoothstep)
        const ease = p * p * (3 - 2 * p); 
        
        // 1. Joint Space Interpolation
        // We interpolate the actuator commands (ctrl) directly.
        if (this.startJoints.length === 7 && this.targetJoints.length === 7) {
            for(let i=0; i<7; i++) {
                mjData.ctrl[i] = this.startJoints[i] + (this.targetJoints[i] - this.startJoints[i]) * ease;
            }
        }

        // 2. Visual Indicator Interpolation
        // Smart Circular/Cylindrical interpolation for the visual Gizmo
        // This prevents the gizmo from cutting through the robot base during large moves
        if (this.step === 8 || this.step === 0 || this.step === 14) { // Steps involving large moves across workspace
             // Cylindrical Interpolation: Radius, Theta, Z
             const startR = Math.sqrt(this.startPos.x * this.startPos.x + this.startPos.y * this.startPos.y);
             const targetR = Math.sqrt(this.targetPos.x * this.targetPos.x + this.targetPos.y * this.targetPos.y);
             const startTheta = Math.atan2(this.startPos.y, this.startPos.x);
             const targetTheta = Math.atan2(this.targetPos.y, this.targetPos.x);
             
             // Calculate shortest angular path
             const dTheta = targetTheta - startTheta;
             
             const curR = startR + (targetR - startR) * ease;
             const curTheta = startTheta + dTheta * ease;
             const curZ = this.startPos.z + (this.targetPos.z - this.startPos.z) * ease;
             
             ikTarget.position.set(curR * Math.cos(curTheta), curR * Math.sin(curTheta), curZ);
        } else {
             // Standard Linear Interpolation for small moves (up/down)
             ikTarget.position.lerpVectors(this.startPos, this.targetPos, ease);
        }
        
        ikTarget.quaternion.slerpQuaternions(this.startQuat, this.targetQuat, ease);
        
        // Apply gripper command
        if (gripperId !== -1) mjData.ctrl[gripperId] = this.gripperVal;
        
        // If step finished, move to next
        if (p >= 1.0) { 
            this.recordCompletedStep(this.step, this.duration);
            this.step++; 
            this.prepareStep(ikTarget, mjData, ikSystem); 
        }
    }

    // Sets up the start/end points and duration for the NEXT step in the sequence
    // AND Solves IK for the target step.
    prepareStep(ikTarget: THREE.Object3D, mjData: MujocoData, ikSystem: IkSystem) {
         // Start visual interpolation from where the gizmo is currently
         this.startPos.copy(ikTarget.position); 
         this.startQuat.copy(ikTarget.quaternion); 
         this.timer = 0;

         // Capture current joints as start
         this.startJoints = [];
         for(let i=0; i<7; i++) this.startJoints.push(mjData.qpos[i]);
         
         // Get current cube position
         const cPos = new THREE.Vector3();
         if (this.useLivePosition && this.curCubeIdx < this.cubeIds.length) {
             // Default mode: Look up physics body position
             const cId = this.cubeIds[this.curCubeIdx];
             cPos.set(mjData.xpos[cId*3], mjData.xpos[cId*3+1], mjData.xpos[cId*3+2]);
         } else if (!this.useLivePosition && this.curCubeIdx < this.targetPositions.length) {
             // Planned/headless mode uses simulator cube centers directly.
             cPos.copy(this.targetPositions[this.curCubeIdx]);
         }

         // Get tray position
         const tPos = new THREE.Vector3(mjData.xpos[this.trayId*3], mjData.xpos[this.trayId*3+1], mjData.xpos[this.trayId*3+2]);
         const travelZ = Math.max(cPos.z + 0.22, 0.28);
         const preGraspZ = cPos.z + 0.12;
         const graspZ = cPos.z + 0.01;
         
         // Default gripper orientation (pointing down)
         const downQuat = new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.PI, 0, 0));
         
         // Calculate drop-off position (higher if stacking)
         const dropPos = tPos.clone();
         let hoverZ = tPos.z + 0.2; 
         let dropZ = tPos.z + 0.05;
         
         if (this.isStacking) {
             // 3x3 Grid Logic (on the floor of the tray)
             // Capacity per layer: 9 cubes (3 rows x 3 cols)
             // layerIdx: vertical layer (0, 1, 2...)
             // posInLayer: 0-8
             
             const layerIdx = Math.floor(this.droppedCount / 9);
             const posInLayer = this.droppedCount % 9;
             
             const row = Math.floor(posInLayer / 3); // 0, 1, 2 (Moves in X direction of tray local frame?)
             const col = posInLayer % 3;             // 0, 1, 2 (Moves in Y direction)
             
             // Offsets: Center is 0,0. Cube size ~0.02 + padding 0.02 -> 0.04 spacing?
             // Using 0.06 spacing for clearance.
             // (row - 1) gives -1, 0, 1
             
             const xOffset = (row - 1) * 0.06;
             const yOffset = (col - 1) * 0.06;
             
             dropPos.x += xOffset;
             dropPos.y += yOffset;
             
             // Base (0.005) + Cube Half (0.02) + Layer * Cube Height (0.04)
             // Plus a small drop offset (0.02) to release slightly above previous cube/floor
             // +0.04 buffer for stacking logic as per original code
             dropZ = 0.005 + 0.02 + (layerIdx * 0.04) + 0.02 + 0.04; 
             
             hoverZ = dropZ + 0.1; 
             dropPos.z = dropZ; 
         }
         
         // Movement segments are joint-speed limited; discrete grasp/release waits stay identical across modes.
         const moveMul = (this.isStacking ? 0.8 : 2.0) * this.motionTimeScale * this.validationTimeScale;
         const fixedMul = (this.isStacking ? 0.8 : 2.0) * this.validationTimeScale;
         let baseDuration = 1.0;
         let useExplicitJoints = false;

         // THE SEQUENCE STATE MACHINE (Defines Cartesian Target)
        switch(this.step) {
            case 0: // Move above cube
                baseDuration=1.2*moveMul; this.targetPos.set(cPos.x, cPos.y, travelZ); this.targetQuat.copy(downQuat); this.gripperVal=0; break;
            case 1: // Lower to hover just above cube
                baseDuration=0.8*moveMul; this.targetPos.set(cPos.x, cPos.y, preGraspZ); this.targetQuat.copy(downQuat); this.gripperVal=0; break;
            case 2: // Open gripper fully
                this.duration=0.3*fixedMul; this.targetPos.copy(ikTarget.position); this.targetQuat.copy(downQuat); this.gripperVal=255; return;
            case 3: // Lower onto cube
                baseDuration=1.0*moveMul; this.targetPos.set(cPos.x, cPos.y, graspZ); this.targetQuat.copy(downQuat); this.gripperVal=255; break;
            case 4: // Wait for physics to settle
                this.duration=0.3*fixedMul; this.targetPos.copy(ikTarget.position); this.targetQuat.copy(downQuat); this.gripperVal=255; return;
            case 5: // Grasp (close)
                this.duration=0.25*fixedMul; this.targetPos.copy(ikTarget.position); this.targetQuat.copy(downQuat); this.gripperVal=0; return;
            case 6: // Wait for grasp
                this.duration=0.25*fixedMul; this.targetPos.copy(ikTarget.position); this.targetQuat.copy(downQuat); this.gripperVal=0; return;
            case 7: // Lift
                baseDuration=0.9*moveMul; this.targetPos.set(cPos.x, cPos.y, travelZ); this.targetQuat.copy(downQuat); this.gripperVal=0; break;
            case 8: // Move to Tray
                baseDuration=2.0*moveMul; this.targetPos.set(dropPos.x, dropPos.y, hoverZ); this.targetQuat.copy(downQuat); this.gripperVal=0; break;
            case 9: // Lower to drop position
                baseDuration=0.8*moveMul; this.targetPos.set(dropPos.x, dropPos.y, dropZ); this.targetQuat.copy(downQuat); this.gripperVal=0; break;
            case 10: // Wait
                this.duration=0.2*fixedMul; this.targetPos.set(dropPos.x, dropPos.y, dropZ); this.targetQuat.copy(downQuat); this.gripperVal=0; return;
            case 11: // Release (Open)
                this.duration=0.25*fixedMul; this.targetPos.set(dropPos.x, dropPos.y, dropZ); this.targetQuat.copy(downQuat); this.gripperVal=255; return;
            case 12: // Wait
                this.duration=0.25*fixedMul; this.targetPos.set(dropPos.x, dropPos.y, dropZ); this.targetQuat.copy(downQuat); this.gripperVal=255; return;
            case 13: // Lift
                baseDuration=0.9*moveMul; this.targetPos.set(dropPos.x, dropPos.y, hoverZ); this.targetQuat.copy(downQuat); this.gripperVal=255; break;
            
            case 14: // Check next or Return Home
                this.droppedCount++;
                
                // Notify completion for this item
                if (this.onPickupComplete) {
                    if (this.useLivePosition) {
                        this.onPickupComplete(this.cubeIds[this.curCubeIdx]);
                    } else {
                        this.onPickupComplete(this.markerIds[this.curCubeIdx]);
                    }
                }

                this.curCubeIdx++;
                
                // Check if more cubes
                if ((this.useLivePosition && this.curCubeIdx < this.cubeIds.length) || 
                    (!this.useLivePosition && this.curCubeIdx < this.targetPositions.length)) {
                    this.step = 0;
                    this.prepareStep(ikTarget, mjData, ikSystem);
                    return;
                }

                // No more cubes - Return to Home
                baseDuration = 1.0;
                this.targetPos.set(0, 0, 0.45);
                this.targetQuat.setFromEuler(new THREE.Euler(Math.PI, 0, 0)); 
                this.gripperVal = 255;

                // EXPLICIT HOME JOINTS (Skip IK)
                // Matches MujocoSim.ts setInitialPose
                this.targetJoints = [1.707, -1.754, 0.003, -2.702, 0.003, 0.951, 2.490]; 
                useExplicitJoints = true;
                break;

            default:
                this.finishRun();
                return; // Exit to avoid running IK solver again for invalid step
         }
         
         if (!useExplicitJoints) {
             // SOLVE IK for the NEW target pose
             const sol = ikSystem.solve(this.targetPos, this.targetQuat, this.startJoints);
             if (sol) {
                 this.targetJoints = sol;
                 this.finalizeStepDuration(baseDuration, false);
             } else {
                 // If no solution, stop this run instead of continuing with invalid state.
                 this.targetJoints = [...this.startJoints];
                 this.failedStepIndex = this.step;
                 this.failedTargetIndex = this.step <= 13 ? this.curCubeIdx : null;
                 console.warn(`IK failed for step ${this.step}`);
                 this.finishRun();
             }
         } else {
             this.finalizeStepDuration(baseDuration, true);
         }
    }
}
