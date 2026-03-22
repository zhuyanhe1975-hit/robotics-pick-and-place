import { EvaluationReport, ExecutionMetrics, PickupOrderPlan, PlanningTarget } from '../types';
import { MissionPlan } from '../utils/platform';

const MODEL_BASE_URL = process.env.NUWA_BASE_URL || 'https://api.nuwaflux.com/v1';
const MODEL_NAME = process.env.NUWA_MODEL || 'gemini-3-flash-preview';

export type MissionPatch = Partial<
  Pick<
    MissionPlan,
    'objective' | 'taskType' | 'priority' | 'executionFlow' | 'algorithms' | 'validationChecks' | 'insights' | 'autoPrompt'
  >
>;

type MissionEnvelope = MissionPatch & {
  taskAnalysis?: MissionPatch;
  missionPlan?: MissionPatch;
  plan?: MissionPatch;
  result?: MissionPatch;
};

type EvaluationEnvelope = EvaluationReport & {
  evaluation?: EvaluationReport;
  result?: EvaluationReport;
};

type PickupOrderEnvelope = Partial<PickupOrderPlan> & {
  planning?: Partial<PickupOrderPlan>;
  result?: Partial<PickupOrderPlan>;
  plan?: Partial<PickupOrderPlan>;
};

type ChatCompletionsEnvelope = Record<string, unknown> & {
  choices?: Array<{
    message?: {
      content?: string | Array<{ type?: string; text?: string }>;
    };
  }>;
  error?: { message?: string };
};

function getApiKey(): string {
  const apiKey = process.env.NUWA_API_KEY;
  if (!apiKey || apiKey.includes('YOUR_')) {
    throw new Error('请先在 .env.local 中填写 NUWA_API_KEY。');
  }
  return apiKey;
}

function extractJsonPayload(text: string): string {
  const firstObject = text.indexOf('{');
  const firstArray = text.indexOf('[');
  const useArray = firstArray !== -1 && (firstObject === -1 || firstArray < firstObject);
  const start = useArray ? firstArray : firstObject;
  const end = useArray ? text.lastIndexOf(']') : text.lastIndexOf('}');

  if (start === -1 || end === -1 || end <= start) {
    throw new Error('模型服务没有返回可解析的 JSON。');
  }

  return text.slice(start, end + 1);
}

function readOutputText(data: ChatCompletionsEnvelope): string {
  const content = data.choices?.[0]?.message?.content;
  const text =
    typeof content === 'string'
      ? content.trim()
      : Array.isArray(content)
        ? content.flatMap((part) => (typeof part?.text === 'string' ? [part.text] : [])).join('\n').trim()
        : '';

  if (!text) {
    throw new Error(data.error?.message || '模型服务未返回有效内容。');
  }

  return text;
}

async function callModel(prompt: string, imageBase64?: string): Promise<string> {
  const content: Array<Record<string, unknown>> = [{ type: 'text', text: prompt }];

  if (imageBase64) {
    content.push({
      type: 'image_url',
      image_url: { url: imageBase64 },
    });
  }

  const response = await fetch(`${MODEL_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${getApiKey()}`,
    },
    body: JSON.stringify({
      model: MODEL_NAME,
      messages: [{ role: 'user', content }],
    }),
  });

  const data = (await response.json()) as ChatCompletionsEnvelope;
  if (!response.ok) {
    throw new Error(data.error?.message || JSON.stringify(data));
  }

  return readOutputText(data);
}

function normalizeMissionPatch(raw: MissionEnvelope): MissionPatch {
  const candidate = raw.taskAnalysis ?? raw.missionPlan ?? raw.plan ?? raw.result ?? raw;
  return {
    objective: candidate.objective,
    taskType: candidate.taskType,
    priority: candidate.priority,
    insights: candidate.insights,
    executionFlow: candidate.executionFlow,
    algorithms: candidate.algorithms,
    validationChecks: candidate.validationChecks,
    autoPrompt: candidate.autoPrompt,
  };
}

function normalizePickupOrderPlan(raw: PickupOrderEnvelope, targets: PlanningTarget[]): PickupOrderPlan {
  const candidate = raw.planning ?? raw.result ?? raw.plan ?? raw;
  const validIndices = Array.isArray(candidate.orderedIndices)
    ? candidate.orderedIndices.filter((value): value is number => Number.isInteger(value) && value >= 0 && value < targets.length)
    : [];

  const dedupedIndices: number[] = [];
  for (const index of validIndices) {
    if (!dedupedIndices.includes(index)) dedupedIndices.push(index);
  }
  for (let i = 0; i < targets.length; i++) {
    if (!dedupedIndices.includes(i)) dedupedIndices.push(i);
  }

  const orderedLabels = dedupedIndices.map((index) => targets[index]?.label ?? `Target ${index + 1}`);
  const reasons = Array.isArray(candidate.reasons)
    ? candidate.reasons.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).slice(0, orderedLabels.length)
    : [];

  return {
    strategy: typeof candidate.strategy === 'string' && candidate.strategy.trim() ? candidate.strategy.trim() : 'Greedy reachable-first order',
    summary: typeof candidate.summary === 'string' && candidate.summary.trim()
      ? candidate.summary.trim()
      : `Prioritize ${orderedLabels.slice(0, 3).join(', ')} for a stable and efficient pickup sequence.`,
    orderedIndices: dedupedIndices,
    orderedLabels,
    reasons,
    motionTimeScale:
      typeof candidate.motionTimeScale === 'number' && Number.isFinite(candidate.motionTimeScale)
        ? Math.min(1, Math.max(0.6, candidate.motionTimeScale))
        : undefined,
    continuityBoost:
      typeof candidate.continuityBoost === 'number' && Number.isFinite(candidate.continuityBoost)
        ? Math.min(1, Math.max(0, candidate.continuityBoost))
        : undefined,
    accelerationBias:
      typeof candidate.accelerationBias === 'number' && Number.isFinite(candidate.accelerationBias)
        ? Math.min(1, Math.max(0, candidate.accelerationBias))
        : undefined,
  };
}

function buildDeterministicEvaluation(metrics: ExecutionMetrics): EvaluationReport | null {
  if (metrics.invalidRun) {
    return {
      summary: '本轮执行被运行时监控判定为失败，系统已在抓取失效、目标掉落或碰撞发生时立即停止任务。',
      completion: `本轮尝试 ${metrics.attemptedCount} 个目标，仅完成 ${metrics.completedCount} 个；失败原因：${metrics.failureMessage ?? metrics.failureReason ?? 'execution invalid'}`,
      timing: '由于任务在执行过程中被判定为无效，本轮时间不参与性能对比。',
      safety: metrics.collisionCount > 0
        ? `执行过程中检测到 ${metrics.collisionCount} 组非法碰撞：${metrics.collisionPairs.join('; ')}。`
        : '本轮未继续执行到可接受的抓取/搬运状态，因此被提前终止。',
      recommendations: [
        '先保证单个目标能够稳定完成抓取、抬升、搬运和放置，再比较速度优化效果。',
        '针对失败阶段检查抓取点、闭合等待时间和搬运段轨迹约束。',
        '只有 executionValid 为 true 的轮次才应进入算法对比与评分。',
      ],
      score: 0,
    };
  }

  if (metrics.targetCount === 0) {
    return {
      summary: '当前场景没有可执行的搬运目标，本轮实验未启动。',
      completion: '目标数量为 0，无法开展抓取与搬运流程。',
      timing: '没有进入实际执行阶段，因此任务时间记为 0。',
      safety: '未发生碰撞，但这一结果不代表当前策略可用。',
      recommendations: [
        '重新生成一组随机目标，确认场景中存在可执行目标。',
        '检查目标筛选与场景恢复逻辑是否一致。',
      ],
      score: 0,
    };
  }

  if (metrics.endedByTimeout) {
    return {
      summary: '本轮执行未在允许时间内完成，后台仿真因达到超时上限而终止。',
      completion: `本轮共尝试 ${metrics.attemptedCount} 个目标，成功完成 ${metrics.completedCount} 个，另有 ${metrics.timeoutCount} 个目标在超时后被终止。`,
      timing: `显示的 ${metrics.timeoutDurationSec.toFixed(2)} 秒是动作累计超时上限，不代表真实完成时间。`,
      safety: metrics.collisionCount > 0
        ? `执行过程中记录到 ${metrics.collisionCount} 次碰撞，说明当前轨迹与控制稳定性仍需优化。`
        : '未记录到碰撞，但执行被超时截断，当前时间指标不能用于策略优劣比较。',
      recommendations: [
        '先提升基础执行稳定性，避免目标在 headless 模式下卡到统一超时阈值。',
        '将超时轮次与正常完成轮次分开比较，不要直接用超时上限做时间对照。',
        '优先检查抓取接近高度、首段可达性和每目标的完成/跳过原因。',
      ],
      score: Math.min(40, metrics.completedCount > 0 ? 20 + metrics.completedCount * 5 : 10),
    };
  }

  if (metrics.completedCount === 0) {
    return {
      summary: '搬运任务未能成功启动，程序在极短时间内终止，未执行任何实际搬运操作。',
      completion: `本轮尝试了 ${metrics.attemptedCount} 个目标，但成功完成搬运的目标数为 0。`,
      timing: metrics.durationSec > 0.1
        ? `任务在 ${metrics.durationSec.toFixed(2)} 秒后终止，但未形成有效搬运结果。`
        : '任务在极短时间内终止，尚未进入有效搬运阶段。',
      safety: metrics.collisionCount > 0
        ? `执行过程中记录到 ${metrics.collisionCount} 次碰撞，需要优先排查轨迹和抓取点。`
        : '未记录到碰撞，但由于任务未真正展开，仍需进一步确认轨迹可达性。',
      recommendations: [
        '优先检查首个目标的可达性和抓取高度设置。',
        '确认场景中的目标列表与执行器实际使用的目标集合一致。',
        '在继续比较 AI 策略前，先让 baseline 稳定完成至少一次有效搬运。',
      ],
      score: 0,
    };
  }

  return null;
}

export async function analyzeMission(basePlan: MissionPlan, taskBrief: string, sceneImageBase64?: string): Promise<MissionPatch> {
  const prompt = [
    '你是工业机械臂任务分析助手。',
    '请基于用户任务和当前场景，直接输出严格 JSON，不要输出 markdown，也不要添加解释。',
    '重点围绕任务目标、执行步骤、建议算法和验证要点，确保所有字段都位于最外层对象。',
    JSON.stringify({
      taskBrief,
      currentPlan: basePlan,
      outputSchema: {
        objective: 'string',
        taskType: 'string',
        priority: 'string',
        insights: [{ title: 'string', detail: 'string' }],
        executionFlow: ['string'],
        algorithms: [{ id: 'string', name: 'string', role: 'string', reason: 'string', maturity: 'string', autoAction: 'string' }],
        validationChecks: ['string'],
        autoPrompt: 'string',
      },
    }),
  ].join('\n');

  const text = await callModel(prompt, sceneImageBase64);
  return normalizeMissionPatch(JSON.parse(extractJsonPayload(text)) as MissionEnvelope);
}

export async function evaluateExecution(taskBrief: string, metrics: ExecutionMetrics, sceneImageBase64?: string): Promise<EvaluationReport> {
  const deterministic = buildDeterministicEvaluation(metrics);
  if (deterministic) {
    return deterministic;
  }

  const prompt = [
    '你是工业机器人任务评估助手。',
    '请根据执行指标和最终场景，综合评价此次搬运任务的执行过程和完成效果。',
    '评价必须覆盖：任务完成时间、完成度、碰撞情况、总体结论、改进建议。',
    '其中 total time 必须以 actionDurationSec 为准，不要使用 simDurationSec 或 wallClockSec 作为实验结论时间。',
    '直接输出严格 JSON，不要输出 markdown，也不要添加解释。',
    JSON.stringify({
      taskBrief,
      executionMetrics: metrics,
      outputSchema: {
        summary: 'string',
        completion: 'string',
        timing: 'string',
        safety: 'string',
        recommendations: ['string'],
        score: 'number',
      },
    }),
  ].join('\n');

  const text = await callModel(prompt, sceneImageBase64);
  const parsed = JSON.parse(extractJsonPayload(text)) as EvaluationEnvelope;
  return parsed.evaluation ?? parsed.result ?? parsed;
}

export async function planPickupOrder(taskBrief: string, targets: PlanningTarget[], sceneImageBase64?: string): Promise<PickupOrderPlan> {
  if (targets.length === 0) {
    return {
      strategy: 'No targets',
      summary: 'No pickup targets are available for planning.',
      orderedIndices: [],
      orderedLabels: [],
      reasons: [],
    };
  }

  const prompt = [
    'You are a robotic pick-and-place planning assistant.',
    'Rank the pickup targets for a stable and efficient execution order.',
    'Prefer a sequence that reduces long travel, avoids risky cross-workspace moves, and starts with easier reachable targets.',
    'Return strict JSON only. Do not include markdown.',
    JSON.stringify({
      taskBrief,
      targets,
      outputSchema: {
        strategy: 'string',
        summary: 'string',
        orderedIndices: ['number'],
        reasons: ['string'],
      },
    }),
  ].join('\n');

  const text = await callModel(prompt, sceneImageBase64);
  return normalizePickupOrderPlan(JSON.parse(extractJsonPayload(text)) as PickupOrderEnvelope, targets);
}

export async function planPathContinuity(taskBrief: string, targets: PlanningTarget[], sceneImageBase64?: string): Promise<PickupOrderPlan> {
  if (targets.length === 0) {
    return {
      strategy: 'No targets',
      summary: 'No pickup targets are available for path continuity optimization.',
      orderedIndices: [],
      orderedLabels: [],
      reasons: [],
      motionTimeScale: 1,
      continuityBoost: 0,
      accelerationBias: 0,
    };
  }

  const prompt = [
    'You are a robotic motion-planning assistant.',
    'The pickup order is already fixed and must not change.',
    'Optimize the end-effector trajectory timing, velocity profile, and acceleration profile for the given ordered targets.',
    'Do not increase the maximum joint speed limit beyond the baseline. Improve time only by reducing unnecessary stop-and-go behavior, smoothing accelerations, and blending consecutive segments.',
    'Favor smoother transitions, fewer stop-and-go segments, and shorter overall task time while respecting joint speed and torque limits.',
    'Return strict JSON only. Do not include markdown.',
    JSON.stringify({
      taskBrief,
      targets,
      outputSchema: {
        strategy: 'string',
        summary: 'string',
        orderedIndices: ['number'],
        reasons: ['string'],
        motionTimeScale: 'number between 0.6 and 1.0',
        continuityBoost: 'number between 0 and 1',
        accelerationBias: 'number between 0 and 1',
      },
    }),
  ].join('\n');

  const text = await callModel(prompt, sceneImageBase64);
  const plan = normalizePickupOrderPlan(JSON.parse(extractJsonPayload(text)) as PickupOrderEnvelope, targets);
  return {
    ...plan,
    orderedIndices: targets.map((_, index) => index),
    orderedLabels: targets.map((target) => target.label),
    motionTimeScale: plan.motionTimeScale ?? 0.85,
    continuityBoost: plan.continuityBoost ?? 0.12,
    accelerationBias: plan.accelerationBias ?? 0.1,
  };
}

export { MODEL_BASE_URL, MODEL_NAME };
