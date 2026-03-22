/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/

import { AlertCircle, Loader2, X } from 'lucide-react';
import loadMujoco from 'mujoco_wasm';
import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { v4 as uuidv4 } from 'uuid';
import { MujocoSim } from './MujocoSim';
import { RobotSelector } from './components/RobotSelector';
import { Toolbar } from './components/Toolbar';
import { UnifiedSidebar } from './components/UnifiedSidebar';
import { appendExperimentLog } from './services/experimentLog';
import { evaluateExecution, planPathContinuity, planPickupOrder } from './services/model';
import { DetectedItem, EvaluationReport, ExecutionMetrics, LogEntry, MujocoModule, PickupOrderPlan, PlanningTarget, SceneLayoutTarget } from './types';
import { buildTrajectoryHintsForOrder } from './utils/RrtConnectPlanner';

type WorkflowStage = 'baseline' | 'order' | 'path';

interface WorkflowRun {
  stage: WorkflowStage;
  title: string;
  subtitle: string;
  status: 'idle' | 'ready' | 'running' | 'done';
  pickupPlan: PickupOrderPlan | null;
  metrics: ExecutionMetrics | null;
  evaluation: EvaluationReport | null;
}

interface ComparisonSummary {
  winner: WorkflowStage;
  headline: string;
  detail: string;
}

const JOINT_LIMIT_SPEED_SCALE = 0.85;

interface LogOverlayProps {
  log: LogEntry;
}

const createWorkflowRuns = (): Record<WorkflowStage, WorkflowRun> => ({
  baseline: {
    stage: 'baseline',
    title: 'Baseline',
    subtitle: '默认顺序执行抓取与搬运',
    status: 'idle',
    pickupPlan: null,
    metrics: null,
    evaluation: null,
  },
  order: {
    stage: 'order',
    title: '顺序优化',
    subtitle: 'AI 给出抓取顺序优化建议',
    status: 'idle',
    pickupPlan: null,
    metrics: null,
    evaluation: null,
  },
  path: {
    stage: 'path',
    title: '路径连续优化',
    subtitle: 'AI 在顺序优化基础上继续优化运动连续性',
    status: 'idle',
    pickupPlan: null,
    metrics: null,
    evaluation: null,
  },
});

export function LogOverlay({ log }: LogOverlayProps) {
  if (!log.result || !Array.isArray(log.result)) return null;

  const results = log.result as DetectedItem[];
  return (
    <svg viewBox="0 0 1000 1000" preserveAspectRatio="none" className="absolute inset-0 pointer-events-none w-full h-full z-10">
      {results.map((item, idx) => {
        if (!item.point) return null;
        const [y, x] = item.point;
        return <circle key={idx} cx={x} cy={y} r="10" fill="#4f46e5" stroke="white" strokeWidth="2" vectorEffect="non-scaling-stroke" />;
      })}
    </svg>
  );
}

function formatModelError(error: unknown): string {
  const message = (error as Error)?.message || '未知错误';
  const normalized = message.toLowerCase();

  if (normalized.includes('429') || normalized.includes('quota exceeded') || normalized.includes('resource_exhausted') || normalized.includes('rate limit')) {
    return '模型服务额度不足或触发限流，请稍后重试。';
  }

  if (normalized.includes('401') || normalized.includes('403') || normalized.includes('api key')) {
    return '模型服务认证失败，请检查 `.env.local` 中的 `NUWA_API_KEY`。';
  }

  if (normalized.includes('failed to fetch') || normalized.includes('network') || normalized.includes('timeout')) {
    return '模型服务请求失败，请检查网络连接后重试。';
  }

  return `模型服务请求失败：${message}`;
}

function targetsToPlanningData(targets: Array<{ label: string; position: THREE.Vector3 }>): PlanningTarget[] {
  return targets.map((target) => ({
    label: target.label,
    x: Number(target.position.x.toFixed(4)),
    y: Number(target.position.y.toFixed(4)),
    z: Number(target.position.z.toFixed(4)),
  }));
}

function defaultPlanFromTargets(targets: Array<{ label: string; position: THREE.Vector3 }>): PickupOrderPlan {
  return {
    strategy: 'Default scene order',
    summary: 'Use the simulator default target order as the baseline reference.',
    orderedIndices: targets.map((_, index) => index),
    orderedLabels: targets.map((target) => target.label),
    reasons: [],
  };
}

export function App() {
  const containerRef = useRef<HTMLDivElement>(null);
  const headlessContainerRef = useRef<HTMLDivElement>(null);
  const simRef = useRef<MujocoSim | null>(null);
  const headlessSimRef = useRef<MujocoSim | null>(null);
  const isMounted = useRef(true);
  const mujocoModuleRef = useRef<MujocoModule | null>(null);
  const detectedTargets = useRef<Array<{ pos: THREE.Vector3; markerId: number }>>([]);

  const [isLoading, setIsLoading] = useState(true);
  const [loadingStatus, setLoadingStatus] = useState('正在初始化仿真环境...');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [mujocoReady, setMujocoReady] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [showSidebar, setShowSidebar] = useState(() => window.innerWidth >= 660);
  const [isDarkMode, setIsDarkMode] = useState(false);
  const [aiStatusMessage, setAiStatusMessage] = useState<string | null>(null);
  const [erLoading, setErLoading] = useState(false);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [expandedLogId, setExpandedLogId] = useState<string | null>(null);
  const [flash, setFlash] = useState(false);
  const [detectedCount, setDetectedCount] = useState(0);
  const [isPickingUp, setIsPickingUp] = useState(false);
  const [playbackSpeed, setPlaybackSpeed] = useState(1);
  const [taskBrief, setTaskBrief] = useState('为随机分布的方块设计稳定的抓取顺序与连续搬运策略。');
  const [gizmoStats, setGizmoStats] = useState<{ pos: string; rot: string } | null>(null);
  const [sceneLayout, setSceneLayout] = useState<SceneLayoutTarget[] | null>(null);
  const [workflowRuns, setWorkflowRuns] = useState<Record<WorkflowStage, WorkflowRun>>(createWorkflowRuns());
  const [comparisonSummary, setComparisonSummary] = useState<ComparisonSummary | null>(null);

  const activeLog = expandedLogId ? logs.find((l) => l.id === expandedLogId) : null;

  useEffect(() => {
    isMounted.current = true;

    loadMujoco({
      locateFile: (path: string) => (path.endsWith('.wasm') ? 'https://unpkg.com/mujoco-js@0.0.7/dist/mujoco_wasm.wasm' : path),
      printErr: (text: string) => {
        if (text.includes('Aborted') && isMounted.current) {
          setLoadError((prev) => prev ?? '仿真运行异常，请刷新页面重试。');
        }
      },
    })
      .then((inst: unknown) => {
        if (isMounted.current) {
          mujocoModuleRef.current = inst as MujocoModule;
          setMujocoReady(true);
        }
      })
      .catch((err: Error) => {
        if (isMounted.current) {
          setLoadError(err.message || '初始化仿真失败。');
          setIsLoading(false);
        }
      });

    return () => {
      isMounted.current = false;
      simRef.current?.dispose();
      headlessSimRef.current?.dispose();
    };
  }, []);

  useEffect(() => {
    if (!mujocoReady || !containerRef.current || !headlessContainerRef.current || !mujocoModuleRef.current) return;

    setIsLoading(true);
    setLoadError(null);
    setIsPaused(false);
    simRef.current?.dispose();
    headlessSimRef.current?.dispose();

    try {
      simRef.current = new MujocoSim(containerRef.current, mujocoModuleRef.current);
      simRef.current.renderSys.setDarkMode(isDarkMode);
      headlessSimRef.current = new MujocoSim(headlessContainerRef.current, mujocoModuleRef.current);
      headlessSimRef.current.setRenderEnabled(false);

      Promise.all([
        simRef.current.init('franka_panda_stack', 'scene.xml', (msg) => {
          if (isMounted.current) setLoadingStatus(msg);
        }),
        headlessSimRef.current.init('franka_panda_stack', 'scene.xml'),
      ])
        .then(() => {
          if (isMounted.current) {
            simRef.current?.setIkEnabled(false);
            headlessSimRef.current?.setIkEnabled(false);
            headlessSimRef.current?.setSpeedMultiplier(1);
            setIsLoading(false);
          }
        })
        .catch((err) => {
          if (isMounted.current) {
            setLoadError(err.message);
            setIsLoading(false);
          }
        });
    } catch (err: unknown) {
      if (isMounted.current) {
        setLoadError((err as Error).message);
        setIsLoading(false);
      }
    }
  }, [mujocoReady, isDarkMode]);

  useEffect(() => {
    if (isLoading || !simRef.current || erLoading) return;

    const standardPos = new THREE.Vector3(2.2, -1.2, 2.2);
    const standardTarget = new THREE.Vector3(0, 0, 0);
    const offsetPos = new THREE.Vector3(2.35, -0.7, 2.2);
    const offsetTarget = new THREE.Vector3(0.15, 0.4, 0.05);

    if (showSidebar && window.innerWidth >= 660) {
      simRef.current.renderSys.moveCameraTo(offsetPos, offsetTarget, 1000);
    } else {
      simRef.current.renderSys.moveCameraTo(standardPos, standardTarget, 1000);
    }
  }, [showSidebar, isLoading, erLoading]);

  useEffect(() => {
    if (isLoading) return;

    let animId: number;
    const uiLoop = () => {
      if (simRef.current) {
        const s = simRef.current.getGizmoStats();
        setGizmoStats(
          s
            ? {
                pos: `X: ${s.pos.x.toFixed(2)}, Y: ${s.pos.y.toFixed(2)}, Z: ${s.pos.z.toFixed(2)}`,
                rot: `X: ${s.rot.x.toFixed(2)}, Y: ${s.rot.y.toFixed(2)}, Z: ${s.rot.z.toFixed(2)}`,
              }
            : null,
        );
      }
      animId = requestAnimationFrame(uiLoop);
    };

    uiLoop();
    return () => cancelAnimationFrame(animId);
  }, [isLoading]);

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (simRef.current && !isLoading && !erLoading) {
        const markerPos = simRef.current.renderSys.checkMarkerClick(e.clientX, e.clientY);
        if (markerPos) {
          simRef.current.moveIkTargetTo(markerPos, 2000);
          simRef.current.setIkEnabled(true);
        }
      }
    };

    window.addEventListener('click', handleClick);
    return () => window.removeEventListener('click', handleClick);
  }, [isLoading, erLoading]);

  const toggleDarkMode = () => {
    const next = !isDarkMode;
    setIsDarkMode(next);
    simRef.current?.renderSys.setDarkMode(next);
  };

  const updateRun = (stage: WorkflowStage, patch: Partial<WorkflowRun>) => {
    setWorkflowRuns((prev) => ({
      ...prev,
      [stage]: { ...prev[stage], ...patch },
    }));
  };

  const renderTargets = (targets: Array<{ label: string; position: THREE.Vector3 }>) => {
    if (!simRef.current) return;
    simRef.current.renderSys.clearErMarkers();
    const detections: DetectedItem[] = targets.map((target, index) => {
      simRef.current?.renderSys.addErMarker(target.position, target.label, index);
      return {
        label: target.label,
        point: [target.position.y, target.position.x],
      };
    });

    detectedTargets.current = targets.map((target, index) => ({ pos: target.position, markerId: index }));
    setDetectedCount(targets.length);
    return detections;
  };

  const logSnapshot = (prompt: string, imageSrc: string, result: unknown, requestData: Record<string, unknown>, type = 'Points') => {
    const logId = uuidv4();
    void appendExperimentLog({
      event: typeof requestData.category === 'string' ? requestData.category : 'ui-log',
      prompt,
      type,
      requestData,
      result,
    });
    setLogs((prev) => [
      {
        id: logId,
        timestamp: new Date(),
        imageSrc,
        prompt,
        fullPrompt: prompt,
        type,
        result,
        requestData,
      },
      ...prev,
    ]);
  };

  const buildComparisonSummary = (runs: Record<WorkflowStage, WorkflowRun>): ComparisonSummary | null => {
    const candidates = (Object.keys(runs) as WorkflowStage[])
      .map((stage) => ({ stage, run: runs[stage] }))
      .filter(({ run }) => run.metrics && run.evaluation);

    if (candidates.length < 3) return null;

    const scored = candidates.map(({ stage, run }) => ({
      stage,
      score: run.evaluation!.score,
      durationSec: run.metrics!.endedByTimeout || run.metrics!.invalidRun ? Number.POSITIVE_INFINITY : run.metrics!.durationSec,
      timeoutDurationSec: run.metrics!.timeoutDurationSec,
      endedByTimeout: run.metrics!.endedByTimeout,
      invalidRun: run.metrics!.invalidRun,
      completionRate: run.metrics!.completionRate,
    }));

    scored.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (b.completionRate !== a.completionRate) return b.completionRate - a.completionRate;
      if (a.invalidRun !== b.invalidRun) return a.invalidRun ? 1 : -1;
      return a.durationSec - b.durationSec;
    });

    const winner = scored[0];
    const baseline = scored.find((item) => item.stage === 'baseline')!;
    const order = scored.find((item) => item.stage === 'order')!;
    const path = scored.find((item) => item.stage === 'path')!;

    const scoreGain = winner.score - baseline.score;
    const canCompareTime = !baseline.endedByTimeout && !winner.endedByTimeout && !baseline.invalidRun && !winner.invalidRun && Number.isFinite(baseline.durationSec) && Number.isFinite(winner.durationSec);
    const timeDelta = canCompareTime ? baseline.durationSec - winner.durationSec : 0;
    const winnerName = runs[winner.stage].title;
    const detail = [
      `Baseline ${baseline.score}/100`,
      `顺序优化 ${order.score}/100`,
      `路径连续优化 ${path.score}/100`,
      scoreGain > 0 ? `${winnerName} 相比 Baseline 提升 ${scoreGain.toFixed(1)} 分` : `${winnerName} 未超过 Baseline 分数`,
      timeDelta > 0 ? `并节省 ${timeDelta.toFixed(2)}s` : '时间表现没有优于 Baseline',
    ].join('，');

    return {
      winner: winner.stage,
      headline: `当前最佳方案是${winnerName}`,
      detail,
    };
  };

  const handleGenerateScene = async () => {
    if (erLoading || !simRef.current) return;

    setErLoading(true);
    setAiStatusMessage(null);
    setIsPickingUp(false);
    setPlaybackSpeed(1);
    setWorkflowRuns(createWorkflowRuns());
    setComparisonSummary(null);
    simRef.current.renderSys.clearErMarkers();
    setFlash(true);
    setTimeout(() => setFlash(false), 100);

    try {
      simRef.current.reset();
      const layout = simRef.current.captureSceneLayout();
      const targets = simRef.current.getSceneTargets();
      const detections = renderTargets(targets) ?? [];
      const imageBase64 = simRef.current.renderSys.getCanvasSnapshot(640, 360, 'image/png');

      setSceneLayout(layout);
      setWorkflowRuns({
        ...createWorkflowRuns(),
        baseline: { ...createWorkflowRuns().baseline, status: 'ready' },
      });
      setComparisonSummary(null);
      setAiStatusMessage(`随机场景已生成，共 ${targets.length} 个可抓取目标。`);

      logSnapshot('生成随机目标场景', imageBase64, detections, {
        provider: 'simulation',
        workflow: 'scene',
        category: 'scene-generation',
        targetCount: targets.length,
      });
    } finally {
      setErLoading(false);
    }
  };

  const cycleSpeed = () => {
    if (!simRef.current || !isPickingUp) return;

    let nextSpeed = 1;
    if (playbackSpeed === 1) nextSpeed = 2;
    else if (playbackSpeed === 2) nextSpeed = 5;
    else if (playbackSpeed === 5) nextSpeed = 10;
    else if (playbackSpeed === 10) nextSpeed = 20;
    else if (playbackSpeed === 20) nextSpeed = 2;

    setPlaybackSpeed(nextSpeed);
    simRef.current.setSpeedMultiplier(nextSpeed);
  };

  const executeWorkflowStage = async (
    stage: WorkflowStage,
    options?: { fixedOrderPlan?: PickupOrderPlan | null },
  ): Promise<WorkflowRun | null> => {
    if (!headlessSimRef.current || !sceneLayout || erLoading || isPickingUp) return null;

    setErLoading(true);
    setAiStatusMessage(null);
    updateRun(stage, { status: 'running', metrics: null, evaluation: null });

    try {
      headlessSimRef.current.applySceneLayout(sceneLayout);
      const restoredTargets = headlessSimRef.current.getSceneTargets();
      const planningTargets = targetsToPlanningData(restoredTargets);
      headlessSimRef.current.renderFrame();
      const stageImage = headlessSimRef.current.renderSys.getCanvasSnapshot(640, 360, 'image/png');

      let plan = defaultPlanFromTargets(restoredTargets);
      if (stage === 'order') {
        plan = await planPickupOrder(taskBrief, planningTargets, stageImage);
      } else if (stage === 'path') {
        const orderPlan = options?.fixedOrderPlan ?? workflowRuns.order.pickupPlan;
        const orderedTargetsForPath = orderPlan
          ? orderPlan.orderedIndices.map((index) => restoredTargets[index]).filter((target): target is (typeof restoredTargets)[number] => Boolean(target))
          : restoredTargets;
        const pathTargets = targetsToPlanningData(orderedTargetsForPath);
        const pathPlan = await planPathContinuity(taskBrief, pathTargets, stageImage);
        plan = {
          ...pathPlan,
          orderedIndices: orderPlan?.orderedIndices ?? restoredTargets.map((_, index) => index),
          orderedLabels: orderedTargetsForPath.map((target) => target.label),
          motionTimeScale: JOINT_LIMIT_SPEED_SCALE,
          trajectoryHints: buildTrajectoryHintsForOrder(pathTargets),
        };
      } else {
        plan = {
          ...plan,
          motionTimeScale: JOINT_LIMIT_SPEED_SCALE,
          continuityBoost: 0,
          accelerationBias: 0,
          trajectoryHints: [],
        };
      }

      const orderedTargets = plan.orderedIndices
        .map((index) => restoredTargets[index])
        .filter((target): target is (typeof restoredTargets)[number] => Boolean(target));

      const detections = renderTargets(orderedTargets) ?? [];
      updateRun(stage, { pickupPlan: plan });

      const requestData = {
        workflow: stage,
        category: 'execution-plan',
        strategy: plan.strategy,
        summary: plan.summary,
        executionMode: 'headless',
      };
      logSnapshot(`${createWorkflowRuns()[stage].title} 执行前目标顺序`, stageImage, detections, requestData);

      setAiStatusMessage(`${createWorkflowRuns()[stage].title} 正在后台全速评估。`);

      headlessSimRef.current.setMotionProfile(
        JOINT_LIMIT_SPEED_SCALE,
        stage === 'path' ? plan.continuityBoost ?? 0 : 0,
        stage === 'path' ? plan.accelerationBias ?? 0 : 0,
        stage === 'path' ? plan.trajectoryHints ?? [] : [],
      );
      const metrics = headlessSimRef.current.runHeadlessPickupSequence(
        orderedTargets.map((target) => target.position),
        orderedTargets.map((_, index) => index),
        orderedTargets.map((target) => target.label),
      );
      headlessSimRef.current.renderFrame();
      const finalSnapshot = headlessSimRef.current.renderSys.getCanvasSnapshot(640, 360, 'image/png');

      const evaluation = await evaluateExecution(`${createWorkflowRuns()[stage].title}: ${taskBrief}`, metrics, finalSnapshot);

      logSnapshot(
        `${createWorkflowRuns()[stage].title} 鎵ц缁撴灉`,
        finalSnapshot,
        {
          metrics,
          evaluation,
        },
        {
          workflow: stage,
          category: 'execution-result',
          strategy: plan.strategy,
          executionMode: 'headless',
          invalidRun: metrics.invalidRun,
          failureReason: metrics.failureReason,
          failureMessage: metrics.failureMessage,
          endedByTimeout: metrics.endedByTimeout,
          durationSec: metrics.durationSec,
          actionDurationSec: metrics.actionDurationSec,
          simDurationSec: metrics.simDurationSec,
          wallClockSec: metrics.wallClockSec,
          durationSource: metrics.durationSource,
          timeoutDurationSec: metrics.timeoutDurationSec,
          completionRate: metrics.completionRate,
          completedCount: metrics.completedCount,
          targetCount: metrics.targetCount,
          skippedCount: metrics.skippedCount,
          timeoutCount: metrics.timeoutCount,
          validationChecks: metrics.validationChecks,
          score: evaluation.score,
        },
        'Execution',
      );

      updateRun(stage, {
        status: 'done',
        pickupPlan: plan,
        metrics,
        evaluation,
      });
      const completedRun: WorkflowRun = {
        ...createWorkflowRuns()[stage],
        status: 'done',
        pickupPlan: plan,
        metrics,
        evaluation,
      };

      if (stage === 'baseline') updateRun('order', { status: 'ready' });
      if (stage === 'order') updateRun('path', { status: 'ready' });

      setAiStatusMessage(`${createWorkflowRuns()[stage].title} 完成，评分 ${evaluation.score}/100。`);
      return completedRun;
    } catch (error) {
      console.error(`${stage} workflow error`, error);
      void appendExperimentLog({
        event: 'execution-error',
        prompt: `${stage} workflow error`,
        type: 'Execution',
        requestData: {
          workflow: stage,
          category: 'execution-error',
        },
        result: {
          message: (error as Error)?.message ?? 'Unknown workflow error',
        },
      });
      updateRun(stage, { status: sceneLayout ? 'ready' : 'idle' });
      setAiStatusMessage(formatModelError(error));
      setIsPickingUp(false);
      return null;
    } finally {
      setErLoading(false);
    }
  };

  const runAllWorkflows = async () => {
    if (!sceneLayout || erLoading || isPickingUp) return;

    setComparisonSummary(null);
    void appendExperimentLog({
      event: 'batch-start',
      prompt: '一键执行全部对比评估',
      type: 'Workflow',
      requestData: {
        workflow: 'all',
        category: 'execution-batch-start',
        sceneTargetCount: detectedCount,
      },
    });
    const latestRuns = createWorkflowRuns();
    const baselineRun = await executeWorkflowStage('baseline');
    if (baselineRun) latestRuns.baseline = baselineRun;
    const orderRun = await executeWorkflowStage('order');
    if (orderRun) latestRuns.order = orderRun;
    const pathRun = await executeWorkflowStage('path', { fixedOrderPlan: orderRun?.pickupPlan ?? latestRuns.order.pickupPlan });
    if (pathRun) latestRuns.path = pathRun;
    const comparison = buildComparisonSummary(latestRuns);
    void appendExperimentLog({
      event: 'batch-finished',
      prompt: '一键执行全部对比评估完成',
      type: 'Workflow',
      requestData: {
        workflow: 'all',
        category: 'execution-batch-finished',
        comparisonSummary: comparison,
      },
      result: latestRuns,
    });
  };

  const replayWorkflowStage = (stage: WorkflowStage) => {
    if (!simRef.current || !sceneLayout) return;

    const run = workflowRuns[stage];
    simRef.current.applySceneLayout(sceneLayout);
    simRef.current.setSpeedMultiplier(1);
    setPlaybackSpeed(1);
    setDetectedCount(0);
    detectedTargets.current = [];

    if (!run.pickupPlan) {
      renderTargets(simRef.current.getSceneTargets());
      setAiStatusMessage('当前阶段还没有可回放的执行结果。');
      return;
    }

    const sceneTargets = simRef.current.getSceneTargets();
    const orderedTargets = run.pickupPlan.orderedIndices
      .map((index) => sceneTargets[index])
      .filter((target): target is (typeof sceneTargets)[number] => Boolean(target));

    renderTargets(orderedTargets);
    simRef.current.setMotionProfile(
      JOINT_LIMIT_SPEED_SCALE,
      stage === 'path' ? run.pickupPlan.continuityBoost ?? 0 : 0,
      stage === 'path' ? run.pickupPlan.accelerationBias ?? 0 : 0,
      stage === 'path' ? run.pickupPlan.trajectoryHints ?? [] : [],
    );
    setAiStatusMessage(`正在回放 ${run.title}。`);
    setIsPickingUp(true);
    simRef.current.pickupItems(
      orderedTargets.map((target) => target.position),
      orderedTargets.map((_, index) => index),
      orderedTargets.map((target) => target.label),
      () => {
        setIsPickingUp(false);
        setDetectedCount(0);
        detectedTargets.current = [];
        simRef.current?.setSpeedMultiplier(1);
      },
    );
  };

  const handleReset = () => {
    simRef.current?.reset();
    setLogs([]);
    setAiStatusMessage(null);
    setDetectedCount(0);
    setIsPickingUp(false);
    setPlaybackSpeed(1);
    setSceneLayout(null);
    setWorkflowRuns(createWorkflowRuns());
    setComparisonSummary(null);
    detectedTargets.current = [];
  };

  useEffect(() => {
    const summary = buildComparisonSummary(workflowRuns);
    setComparisonSummary(summary);
  }, [workflowRuns]);

  const sceneReady = Boolean(sceneLayout && sceneLayout.length > 0);
  const baselineReady = sceneReady && !isPickingUp;
  const orderReady = workflowRuns.baseline.status === 'done' && !isPickingUp;
  const pathReady = workflowRuns.order.status === 'done' && !isPickingUp;

  return (
    <div className={`w-full h-full relative overflow-hidden font-sans transition-colors duration-500 ${isDarkMode ? 'bg-slate-950 text-slate-100' : 'bg-slate-50 text-slate-800'}`}>
      <div ref={containerRef} className="w-full h-full absolute inset-0 bg-slate-200" />

      <div className="absolute inset-0 pointer-events-none">
        <div className={`absolute inset-x-0 top-0 h-40 ${isDarkMode ? 'bg-gradient-to-b from-slate-950 via-slate-950/60 to-transparent' : 'bg-gradient-to-b from-slate-50 via-white/70 to-transparent'}`} />
        <div className={`absolute inset-y-0 left-0 w-40 ${isDarkMode ? 'bg-gradient-to-r from-slate-950/70 to-transparent' : 'bg-gradient-to-r from-white/75 to-transparent'}`} />
      </div>

      {!loadError && <RobotSelector gizmoStats={gizmoStats} isDarkMode={isDarkMode} />}
      <div ref={headlessContainerRef} className="absolute w-px h-px overflow-hidden opacity-0 pointer-events-none -z-10" aria-hidden="true" />

      {isLoading && (
        <div className={`absolute inset-0 flex flex-col items-center justify-center z-50 backdrop-blur-md px-6 ${isDarkMode ? 'bg-slate-950/40' : 'bg-slate-50/20'}`}>
          <div className={`glass-panel p-10 rounded-[2.5rem] max-w-lg w-full text-center shadow-2xl ${isDarkMode ? 'bg-slate-900/70 border-white/10' : 'bg-white/75 border-white/80'}`}>
            <div className="w-16 h-16 rounded-2xl bg-indigo-600 flex items-center justify-center shadow-lg mx-auto mb-6">
              <Loader2 className="w-8 h-8 text-white animate-spin" />
            </div>
            <h2 className="text-lg font-bold">{loadingStatus}</h2>
            <p className={`text-sm mt-3 leading-relaxed ${isDarkMode ? 'text-slate-300' : 'text-slate-600'}`}>
              正在加载 MuJoCo 仿真、机械臂模型和工作区。
            </p>
          </div>
        </div>
      )}

      {flash && <div className="absolute inset-0 bg-white z-[60] pointer-events-none opacity-50" />}

      {loadError && (
        <div className="absolute inset-0 flex flex-col items-center justify-center bg-white/40 backdrop-blur-xl z-50 px-6">
          <div className="glass-panel p-10 rounded-[2.5rem] border-red-100 max-w-md text-center">
            <div className="w-16 h-16 bg-red-50 text-red-600 rounded-full flex items-center justify-center mx-auto mb-6">
              <AlertCircle className="w-8 h-8" />
            </div>
            <h3 className="text-2xl text-slate-800 font-bold mb-2">仿真已中断</h3>
            <p className="text-slate-500 mb-8 leading-relaxed">{loadError}</p>
            <button onClick={() => window.location.reload()} className="w-full py-4 bg-slate-900 text-white rounded-2xl font-bold hover:bg-black transition-all shadow-xl active:scale-95">
              重新加载
            </button>
          </div>
        </div>
      )}

      {!isLoading && !loadError && (
        <>
          <Toolbar
            isPaused={isPaused}
            togglePause={() => setIsPaused(simRef.current?.togglePause() ?? false)}
            onReset={handleReset}
            showSidebar={showSidebar}
            toggleSidebar={() => setShowSidebar(!showSidebar)}
            isDarkMode={isDarkMode}
            toggleDarkMode={toggleDarkMode}
          />

          <UnifiedSidebar
            isOpen={showSidebar}
            onClose={() => setShowSidebar(false)}
            taskBrief={taskBrief}
            onTaskBriefChange={setTaskBrief}
            aiStatusMessage={aiStatusMessage}
            sceneReady={sceneReady}
            detectedCount={detectedCount}
            isBusy={erLoading}
            isPickingUp={isPickingUp}
            playbackSpeed={playbackSpeed}
            onCycleSpeed={cycleSpeed}
            onGenerateScene={handleGenerateScene}
            onRunAll={runAllWorkflows}
            onRunBaseline={() => executeWorkflowStage('baseline')}
            onRunOrder={() => executeWorkflowStage('order')}
            onRunPath={() => executeWorkflowStage('path')}
            onReplayBaseline={() => replayWorkflowStage('baseline')}
            onReplayOrder={() => replayWorkflowStage('order')}
            onReplayPath={() => replayWorkflowStage('path')}
            baselineReady={baselineReady}
            orderReady={orderReady}
            pathReady={pathReady}
            workflowRuns={workflowRuns}
            comparisonSummary={comparisonSummary}
            logs={logs}
            onOpenLog={(log) => setExpandedLogId(log.id)}
            isDarkMode={isDarkMode}
          />

          {activeLog && (
            <div className="fixed inset-0 z-[100] flex items-center justify-center min-[660px]:p-10 bg-slate-950/20 backdrop-blur-xl" onClick={() => setExpandedLogId(null)}>
              <div className={`overflow-hidden flex flex-col shadow-2xl fixed top-4 bottom-4 left-4 right-4 rounded-[2.5rem] min-[660px]:relative min-[660px]:inset-auto min-[660px]:w-full min-[660px]:max-w-4xl min-[660px]:max-h-[85vh] ${isDarkMode ? 'bg-slate-900 border border-white/10 text-slate-100' : 'bg-white border border-white/80 text-slate-800'}`} onClick={(e) => e.stopPropagation()}>
                <div className={`p-6 border-b flex justify-between items-center shrink-0 ${isDarkMode ? 'border-white/5 bg-white/5' : 'border-slate-100 bg-white/40'}`}>
                  <div>
                    <h3 className="text-xl font-bold">实验记录</h3>
                    <p className={`text-xs font-medium ${isDarkMode ? 'text-slate-400' : 'text-slate-500'}`}>{activeLog.timestamp.toLocaleString()}</p>
                  </div>
                  <button onClick={() => setExpandedLogId(null)} className={`w-10 h-10 flex items-center justify-center rounded-full shadow-sm border transition-colors ${isDarkMode ? 'bg-slate-800 border-white/10 text-slate-400 hover:text-slate-200' : 'bg-white border-slate-100 text-slate-400 hover:text-slate-600'}`}>
                    <X className="w-5 h-5" />
                  </button>
                </div>

                <div className="flex-1 flex max-[659px]:flex-col max-[659px]:overflow-y-auto min-[660px]:flex-row min-[660px]:overflow-hidden">
                  <div className={`flex items-center justify-center border-b min-[660px]:border-b-0 min-[660px]:border-r min-[660px]:flex-1 min-[660px]:p-6 max-[659px]:p-6 ${isDarkMode ? 'bg-slate-950/50 border-white/5' : 'bg-slate-50/30 border-slate-100'}`}>
                    <div className={`relative rounded-2xl overflow-hidden shadow-lg border-2 ${isDarkMode ? 'border-white/10 bg-black/20' : 'border-white bg-black/5'}`}>
                      <img src={activeLog.imageSrc} className="block w-full h-auto min-[660px]:max-w-full min-[660px]:max-h-full" alt="Detailed log" />
                      <LogOverlay log={activeLog} />
                    </div>
                  </div>

                  <div className={`min-[660px]:w-[320px] p-6 flex flex-col gap-5 min-[660px]:overflow-y-auto ${isDarkMode ? 'bg-white/5' : 'bg-white/20'}`}>
                    <div className="space-y-1">
                      <h4 className="text-[10px] font-bold uppercase tracking-widest text-slate-400">Prompt</h4>
                      <p className="text-sm font-bold leading-tight">{activeLog.prompt}</p>
                    </div>
                    <div className="space-y-1">
                      <h4 className="text-[10px] font-bold uppercase tracking-widest text-slate-400">Request</h4>
                      <p className={`text-[11px] font-mono p-3 rounded-xl leading-relaxed border whitespace-pre-wrap ${isDarkMode ? 'bg-slate-950 border-white/5 text-slate-400' : 'bg-slate-50 border-slate-200/50 text-slate-500'}`}>{activeLog.fullPrompt}</p>
                    </div>
                    <div className="space-y-3 flex flex-col min-[660px]:flex-1 min-[660px]:min-h-0">
                      <h4 className="text-[10px] font-bold uppercase tracking-widest text-slate-400">Result</h4>
                      <div className={`p-3 rounded-xl font-mono text-[10px] border overflow-y-auto min-[660px]:flex-1 max-[659px]:h-96 ${isDarkMode ? 'bg-slate-950 border-white/5 text-indigo-400' : 'bg-slate-50/50 border-slate-100 text-indigo-600'}`}>
                        {activeLog.result === null ? (
                          <div className="h-full flex flex-col items-center justify-center gap-3 text-indigo-400">
                            <Loader2 className="w-6 h-6 animate-spin" />
                            <span className="font-sans font-bold text-[10px] uppercase tracking-widest">Processing</span>
                          </div>
                        ) : (
                          <pre className="whitespace-pre-wrap break-all leading-relaxed">{JSON.stringify(activeLog.result, null, 2)}</pre>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
