/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/


/**
 * DetectType defines the detection modes available in the application.
 */
export type DetectType = '2D bounding boxes' | 'Segmentation masks' | 'Points';

/**
 * LogEntry represents a record of a vision model interaction.
 */
export interface LogEntry {
  id: string;
  timestamp: Date;
  imageSrc: string;
  prompt: string;
  fullPrompt: string;
  type: string;
  result: unknown; 
  requestData: unknown; 
}

/**
 * Interface for the result item from detection.
 */
export interface DetectedItem {
  box_2d?: number[];
  point?: number[];
  label?: string;
  mask?: string;
  [key: string]: unknown;
}

/**
 * Minimal interface for MuJoCo Model to avoid 'any'.
 */
export interface MujocoModel {
  nbody: number;
  ngeom: number;
  nsite: number;
  nu: number;
  njnt: number;
  name_siteadr: Int32Array;
  name_actuatoradr: Int32Array;
  name_bodyadr: Int32Array;
  names: Int8Array;
  jnt_qposadr: Int32Array;
  actuator_trnid: Int32Array;
  geom_group: Int32Array;
  geom_type: Int32Array;
  geom_size: Float64Array; 
  geom_pos: Float64Array;
  geom_quat: Float64Array;
  geom_matid: Int32Array;
  mat_rgba: Float32Array;
  geom_rgba: Float32Array;
  geom_dataid: Int32Array;
  mesh_vertadr: Int32Array;
  mesh_vertnum: Int32Array;
  mesh_faceadr: Int32Array;
  mesh_facenum: Int32Array;
  mesh_vert: Float32Array;
  mesh_face: Int32Array;
  geom_bodyid: Int32Array;
  delete: () => void;
  [key: string]: unknown;
}

/**
 * Minimal interface for MuJoCo Data to avoid 'any'.
 */
export interface MujocoData {
  time: number;
  qpos: Float64Array;
  ctrl: Float64Array;
  xfrc_applied: Float64Array;
  xpos: Float64Array;
  xquat: Float64Array;
  ncon: number;
  contact: unknown;
  site_xpos: Float64Array;
  site_xmat: Float64Array;
  delete: () => void;
  [key: string]: unknown;
}

/**
 * Minimal interface for the MuJoCo WASM Module.
 */
export interface MujocoModule {
  MjModel: { loadFromXML: (path: string) => MujocoModel; [key: string]: unknown };
  MjData: new (model: MujocoModel) => MujocoData;
  MjvOption: new () => { delete: () => void; [key: string]: unknown };
  mj_forward: (m: MujocoModel, d: MujocoData) => void;
  mj_step: (m: MujocoModel, d: MujocoData) => void;
  mj_resetData: (m: MujocoModel, d: MujocoData) => void;
  mjtGeom: Record<string, number | {value: number}>;
  FS: {
      writeFile: (path: string, content: string | Uint8Array) => void;
      mkdir: (path: string) => void;
      unmount: (path: string) => void;
  };
  [key: string]: unknown;
}

export interface ExecutionMetrics {
  durationSec: number;
  actionDurationSec: number;
  simDurationSec: number;
  wallClockSec: number;
  durationSource: 'action';
  invalidRun: boolean;
  failureReason?: string;
  failureMessage?: string;
  targetCount: number;
  attemptedCount: number;
  completedCount: number;
  skippedCount: number;
  completionRate: number;
  endedByTimeout: boolean;
  timeoutCount: number;
  timeoutDurationSec: number;
  collisionCount: number;
  collisionPairs: string[];
  hadGroundCollision: boolean;
  hadObjectCollision: boolean;
  failedStepIndex?: number;
  failedStepName?: string;
  failedTargetIndex?: number;
  failedTargetLabel?: string;
  perTargetBreakdown: ExecutionTargetBreakdown[];
  stepTimeline: ExecutionStepMetric[];
  validationChecks: ExecutionValidationChecks;
}

export interface ExecutionValidationChecks {
  durationConsistent: boolean;
  durationDeltaSec: number;
  durationSourceDeclared: boolean;
  executionValid: boolean;
}

export interface ExecutionTargetBreakdown {
  targetIndex: number;
  targetLabel: string;
  totalDurationSec: number;
  approachSec: number;
  graspSec: number;
  transferSec: number;
  placeSec: number;
  stepCount: number;
}

export interface ExecutionStepMetric {
  stepIndex: number;
  stepName: string;
  phase: 'approach' | 'grasp' | 'transfer' | 'place' | 'return-home';
  durationSec: number;
  targetIndex: number | null;
  targetLabel: string | null;
}

export interface EvaluationReport {
  summary: string;
  completion: string;
  timing: string;
  safety: string;
  recommendations: string[];
  score: number;
}

export interface PlanningTarget {
  label: string;
  x: number;
  y: number;
  z: number;
}

export interface SceneLayoutTarget extends PlanningTarget {}

export interface TrajectoryTargetHint {
  targetIndex: number;
  targetLabel: string;
  approachPathLength: number;
  transferPathLength: number;
  approachWaypointCount: number;
  transferWaypointCount: number;
}

export interface PickupOrderPlan {
  strategy: string;
  summary: string;
  orderedIndices: number[];
  orderedLabels: string[];
  reasons: string[];
  motionTimeScale?: number;
  continuityBoost?: number;
  accelerationBias?: number;
  trajectoryHints?: TrajectoryTargetHint[];
}
