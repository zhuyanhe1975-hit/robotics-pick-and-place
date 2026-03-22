import { LogEntry } from '../types';

export type WorkspaceStage = 'design' | 'simulation' | 'validation';

export interface AlgorithmRecommendation {
  id: string;
  name: string;
  role: string;
  reason: string;
  maturity: 'Production' | 'Recommended' | 'Experimental';
  autoAction: 'call' | 'recommend';
}

export interface MissionInsight {
  title: string;
  detail: string;
}

export interface ValidationMetric {
  label: string;
  value: string;
  status: 'good' | 'watch' | 'pending';
}

export interface MissionPlan {
  objective: string;
  taskType: string;
  priority: string;
  insights: MissionInsight[];
  executionFlow: string[];
  algorithms: AlgorithmRecommendation[];
  validationChecks: string[];
  metrics: ValidationMetric[];
  autoPrompt: string;
}

function isErrorResult(result: unknown): boolean {
  return Boolean(result && !Array.isArray(result) && typeof result === 'object' && 'error' in (result as Record<string, unknown>));
}

function countSuccessfulLogs(logs: LogEntry[]): number {
  return logs.filter((log) => log.result !== null && !isErrorResult(log.result)).length;
}

function inferTaskType(taskBrief: string): string {
  const brief = taskBrief.toLowerCase();
  if (brief.includes('stack') || brief.includes('堆叠')) return '堆叠搬运';
  if (brief.includes('sort') || brief.includes('bin') || brief.includes('分拣')) return '分拣作业';
  if (brief.includes('place') || brief.includes('pick') || brief.includes('抓取') || brief.includes('放置')) return '抓取放置';
  if (brief.includes('inspect') || brief.includes('检测')) return '检测巡检';
  return '通用搬运';
}

function buildInsights(taskBrief: string, logs: LogEntry[], detectedCount: number): MissionInsight[] {
  const taskType = inferTaskType(taskBrief);
  const successCount = countSuccessfulLogs(logs);

  return [
    {
      title: '任务类型',
      detail: `当前任务被归类为“${taskType}”。系统会优先给出目标识别与抓取建议。`,
    },
    {
      title: '当前进度',
      detail:
        successCount > 0
          ? '已经生成过一轮分析或识别结果，可以直接复用当前建议继续执行。'
          : '建议先完成一次任务分析，再生成目标标记。'
    },
    {
      title: '执行状态',
      detail:
        detectedCount > 0
          ? `当前已有 ${detectedCount} 个候选目标，可以进入抓取执行。`
          : '还没有目标标记，先进行场景识别会更稳。'
    },
  ];
}

function buildAlgorithms(taskBrief: string): AlgorithmRecommendation[] {
  const usesPrecision = /precise|tight|fragile|accurate|precision|精确|高精度|易碎/.test(taskBrief.toLowerCase());

  return [
    {
      id: 'scene-understanding',
      name: '场景理解',
      role: '识别目标',
      reason: '先识别可抓取目标和相对稳定的接近位置，降低后续规划难度。',
      maturity: 'Production',
      autoAction: 'call',
    },
    {
      id: 'rrt-connect',
      name: 'RRT-Connect',
      role: '全局路径规划',
      reason: '适合作为抓取和放置之间的默认路径规划方案。',
      maturity: 'Production',
      autoAction: 'recommend',
    },
    {
      id: 'cartesian-servo',
      name: 'Cartesian Servo / IK',
      role: '末端对准',
      reason: usesPrecision ? '适合高精度放置场景的末端修正。' : '适合接近目标时做最后一段姿态对准。',
      maturity: 'Recommended',
      autoAction: 'call',
    },
  ];
}

function buildValidationMetrics(logs: LogEntry[], detectedCount: number): ValidationMetric[] {
  const successCount = countSuccessfulLogs(logs);

  return [
    {
      label: '任务分析',
      value: successCount >= 1 ? '已生成' : '待执行',
      status: successCount >= 1 ? 'good' : 'pending',
    },
    {
      label: '目标识别',
      value: detectedCount > 0 ? `${detectedCount} 个目标` : '未识别',
      status: detectedCount > 0 ? 'good' : 'watch',
    },
    {
      label: '执行准备',
      value: detectedCount > 0 ? '可开始' : '等待目标',
      status: detectedCount > 0 ? 'good' : 'pending',
    },
  ];
}

export function mergeMissionPlan(basePlan: MissionPlan, patch?: Partial<MissionPlan> | null): MissionPlan {
  if (!patch) return basePlan;

  return {
    ...basePlan,
    ...patch,
    insights: patch.insights && patch.insights.length > 0 ? patch.insights : basePlan.insights,
    executionFlow: patch.executionFlow && patch.executionFlow.length > 0 ? patch.executionFlow : basePlan.executionFlow,
    algorithms: patch.algorithms && patch.algorithms.length > 0 ? patch.algorithms : basePlan.algorithms,
    validationChecks: patch.validationChecks && patch.validationChecks.length > 0 ? patch.validationChecks : basePlan.validationChecks,
    metrics: basePlan.metrics,
  };
}

export function buildMissionPlan(taskBrief: string, logs: LogEntry[], detectedCount: number): MissionPlan {
  const brief = taskBrief.trim() || '识别目标方块，规划抓取路径并完成稳定放置。';

  return {
    objective: brief,
    taskType: inferTaskType(brief),
    priority: detectedCount > 0 ? '目标已经就绪，可以直接执行抓取。' : '先完成一次识别，生成稳定的候选目标。',
    insights: buildInsights(brief, logs, detectedCount),
    executionFlow: ['分析任务', '识别目标', '执行抓取'],
    algorithms: buildAlgorithms(brief),
    validationChecks: ['目标是否清晰可抓取', '抓取路径是否避障', '放置动作是否稳定'],
    metrics: buildValidationMetrics(logs, detectedCount),
    autoPrompt: `${brief}。请识别当前场景中最适合抓取的目标，并给出简洁可执行的抓取建议。`,
  };
}
