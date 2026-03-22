/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/

import { Bot, FastForward, History, PlayCircle, Sparkles, X } from 'lucide-react';
import { LogOverlay } from '../App';
import { DetectedItem, LogEntry } from '../types';

type WorkflowStage = 'baseline' | 'order' | 'path';

interface WorkflowRun {
  stage: WorkflowStage;
  title: string;
  subtitle: string;
  status: 'idle' | 'ready' | 'running' | 'done';
  pickupPlan: {
    strategy: string;
    summary: string;
    orderedLabels: string[];
  } | null;
  metrics: {
    durationSec: number;
    completionRate: number;
    collisionCount: number;
    endedByTimeout: boolean;
    timeoutCount: number;
    timeoutDurationSec: number;
    completedCount: number;
    targetCount: number;
  } | null;
  evaluation: {
    summary: string;
    score: number;
    recommendations: string[];
  } | null;
}

interface ComparisonSummary {
  winner: WorkflowStage;
  headline: string;
  detail: string;
}

interface UnifiedSidebarProps {
  isOpen: boolean;
  onClose: () => void;
  taskBrief: string;
  onTaskBriefChange: (value: string) => void;
  aiStatusMessage: string | null;
  sceneReady: boolean;
  detectedCount: number;
  isBusy: boolean;
  isPickingUp: boolean;
  playbackSpeed: number;
  onCycleSpeed: () => void;
  onGenerateScene: () => void;
  onRunAll: () => void;
  onRunBaseline: () => void;
  onRunOrder: () => void;
  onRunPath: () => void;
  onReplayBaseline: () => void;
  onReplayOrder: () => void;
  onReplayPath: () => void;
  baselineReady: boolean;
  orderReady: boolean;
  pathReady: boolean;
  workflowRuns: Record<WorkflowStage, WorkflowRun>;
  comparisonSummary: ComparisonSummary | null;
  logs: LogEntry[];
  onOpenLog: (log: LogEntry) => void;
  isDarkMode: boolean;
}

function hasError(result: unknown): boolean {
  return Boolean(result && !Array.isArray(result) && typeof result === 'object' && 'error' in (result as Record<string, unknown>));
}

function getLogMeta(log: LogEntry) {
  const request = (log.requestData ?? {}) as Record<string, unknown>;
  const category = typeof request.category === 'string' ? request.category : '';
  const workflow = typeof request.workflow === 'string' ? request.workflow : '';

  if (category === 'execution-result') {
    const endedByTimeout = Boolean(request.endedByTimeout);
    const completedCount = typeof request.completedCount === 'number' ? request.completedCount : 0;
    const targetCount = typeof request.targetCount === 'number' ? request.targetCount : 0;
    const score = typeof request.score === 'number' ? request.score : null;
    return {
      badge: endedByTimeout ? '超时终止' : '执行结果',
      detail:
        score !== null
          ? `${workflow} · ${completedCount}/${targetCount} · ${score}/100`
          : `${workflow} · ${completedCount}/${targetCount}`,
    };
  }

  if (category === 'execution-plan') {
    const strategy = typeof request.strategy === 'string' ? request.strategy : 'Execution plan';
    return {
      badge: '执行计划',
      detail: `${workflow} · ${strategy}`,
    };
  }

  if (category === 'scene-generation') {
    const targetCount = typeof request.targetCount === 'number' ? request.targetCount : 0;
    return {
      badge: '场景生成',
      detail: `${targetCount} 个目标`,
    };
  }

  const items = Array.isArray(log.result) ? (log.result as DetectedItem[]) : [];
  return {
    badge: `${items.length} 个目标`,
    detail: log.fullPrompt,
  };
}

function statusLabel(status: WorkflowRun['status']) {
  if (status === 'done') return '已完成';
  if (status === 'running') return '执行中';
  if (status === 'ready') return '可执行';
  return '待准备';
}

export function UnifiedSidebar({
  isOpen,
  onClose,
  taskBrief,
  onTaskBriefChange,
  aiStatusMessage,
  sceneReady,
  detectedCount,
  isBusy,
  isPickingUp,
  playbackSpeed,
  onCycleSpeed,
  onGenerateScene,
  onRunAll,
  onRunBaseline,
  onRunOrder,
  onRunPath,
  onReplayBaseline,
  onReplayOrder,
  onReplayPath,
  baselineReady,
  orderReady,
  pathReady,
  workflowRuns,
  comparisonSummary,
  logs,
  onOpenLog,
  isDarkMode,
}: UnifiedSidebarProps) {
  const panelBase = isDarkMode ? 'bg-slate-950/90 border-white/10 text-slate-100' : 'bg-white/82 border-white/80 text-slate-800';
  const sectionCard = isDarkMode ? 'bg-white/5 border-white/10' : 'bg-white/60 border-white/70';
  const inputBg = isDarkMode ? 'bg-slate-950 border-white/10 text-slate-100' : 'bg-white/80 border-slate-200 text-slate-800';
  const muted = isDarkMode ? 'text-slate-400' : 'text-slate-500';
  const subtle = isDarkMode ? 'text-slate-300' : 'text-slate-600';
  const latestLog = logs.find((log) => Array.isArray(log.result));
  const runList = [workflowRuns.baseline, workflowRuns.order, workflowRuns.path];
  const formatDurationLabel = (metrics: NonNullable<WorkflowRun['metrics']>) =>
    metrics.endedByTimeout ? `超时 ${metrics.timeoutDurationSec.toFixed(2)}s` : `${metrics.durationSec.toFixed(2)}s`;

  if (!isOpen) return null;

  return (
    <div className={`absolute top-4 bottom-4 left-4 right-4 min-[760px]:left-auto min-[760px]:top-6 min-[760px]:right-6 min-[760px]:bottom-6 min-[760px]:w-[430px] rounded-[2rem] border backdrop-blur-2xl flex flex-col z-40 overflow-hidden ${panelBase}`}>
      <div className={`px-6 py-5 border-b flex items-start gap-4 ${isDarkMode ? 'border-white/10 bg-white/5' : 'border-white/70 bg-white/40'}`}>
        <div className="w-11 h-11 rounded-2xl bg-gradient-to-br from-amber-500 via-orange-500 to-rose-500 text-white flex items-center justify-center shrink-0">
          <Bot className="w-5 h-5" />
        </div>
        <div className="min-w-0 flex-1">
          <p className={`text-[10px] uppercase tracking-[0.3em] font-bold ${muted}`}>Workflow</p>
          <h2 className="text-xl font-bold mt-1 leading-tight">算法实验台</h2>
          <p className={`text-sm mt-2 leading-relaxed ${subtle}`}>同一随机场景下依次运行 baseline、顺序优化和路径连续优化，对比三轮执行评估。</p>
        </div>
        <button onClick={onClose} className={`w-10 h-10 rounded-full flex items-center justify-center transition-colors ${isDarkMode ? 'hover:bg-white/10 text-slate-400' : 'hover:bg-slate-200/60 text-slate-500'}`}>
          <X className="w-5 h-5" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-5 space-y-5 custom-scrollbar">
        <section className={`rounded-[1.6rem] border p-5 ${sectionCard}`}>
          <div className="flex items-center gap-2">
            <Sparkles className={`w-4 h-4 ${isDarkMode ? 'text-amber-300' : 'text-amber-700'}`} />
            <h3 className="text-base font-bold">实验目标</h3>
          </div>
          <textarea
            value={taskBrief}
            onChange={(e) => onTaskBriefChange(e.target.value)}
            className={`mt-4 w-full rounded-[1.4rem] border px-4 py-4 text-sm leading-relaxed resize-none h-24 outline-none focus:ring-2 focus:ring-amber-500/20 transition-all ${inputBg}`}
            placeholder="例如：在随机散布方块场景中比较默认抓取、AI顺序优化和路径连续优化的效果。"
          />
          <div className={`mt-4 rounded-2xl px-4 py-3 ${isDarkMode ? 'bg-white/5' : 'bg-slate-100/80'}`}>
            <div className={`text-[10px] uppercase tracking-[0.2em] font-bold ${muted}`}>状态</div>
            <p className="text-sm font-semibold mt-2">{sceneReady ? `当前场景含 ${detectedCount} 个目标` : '尚未生成实验场景'}</p>
            {aiStatusMessage && <p className={`text-xs mt-2 ${subtle}`}>{aiStatusMessage}</p>}
          </div>
          <button
            onClick={onGenerateScene}
            disabled={isBusy || isPickingUp}
            className={`mt-4 w-full rounded-2xl px-4 py-3 font-bold text-sm transition-all ${
              isBusy || isPickingUp
                ? (isDarkMode ? 'bg-slate-800 text-slate-600 cursor-not-allowed' : 'bg-slate-100 text-slate-400 cursor-not-allowed')
                : (isDarkMode ? 'bg-amber-500 text-slate-950 hover:bg-amber-400' : 'bg-slate-900 text-white hover:bg-black')
            }`}
          >
            {sceneReady ? '重新生成随机场景' : '1. 随机生成目标'}
          </button>
          <button
            onClick={onRunAll}
            disabled={!sceneReady || isBusy || isPickingUp}
            className={`mt-3 w-full rounded-2xl px-4 py-3 font-bold text-sm transition-all ${
              !sceneReady || isBusy || isPickingUp
                ? (isDarkMode ? 'bg-slate-800 text-slate-600 cursor-not-allowed' : 'bg-slate-100 text-slate-400 cursor-not-allowed')
                : (isDarkMode ? 'bg-emerald-400 text-slate-950 hover:bg-emerald-300' : 'bg-emerald-600 text-white hover:bg-emerald-700')
            }`}
          >
            一键执行全部对比评估
          </button>
        </section>

        <section className={`rounded-[1.6rem] border p-5 ${sectionCard}`}>
          <div className="flex items-center gap-2">
            <Sparkles className={`w-4 h-4 ${isDarkMode ? 'text-emerald-300' : 'text-emerald-700'}`} />
            <h3 className="text-base font-bold">对比结论</h3>
          </div>
          {comparisonSummary ? (
            <div className={`mt-4 rounded-[1.4rem] px-4 py-4 ${isDarkMode ? 'bg-white/5' : 'bg-slate-100/80'}`}>
              <p className="text-sm font-semibold">{comparisonSummary.headline}</p>
              <p className={`text-xs mt-2 leading-relaxed ${subtle}`}>{comparisonSummary.detail}</p>
            </div>
          ) : (
            <div className={`mt-4 rounded-[1.4rem] border-2 border-dashed px-4 py-8 text-center text-sm ${isDarkMode ? 'border-white/10 text-slate-500' : 'border-slate-200 text-slate-400'}`}>
              完成三种模式的评估后，这里会自动生成简要对比结论。
            </div>
          )}
        </section>

        <section className={`rounded-[1.6rem] border p-5 ${sectionCard}`}>
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className={`text-[10px] uppercase tracking-[0.28em] font-bold ${muted}`}>Execution</p>
              <h3 className="text-base font-bold mt-1">分阶段对照执行</h3>
            </div>
            {isPickingUp && (
              <button
                onClick={onCycleSpeed}
                className={`rounded-xl px-3 py-2 text-xs font-bold flex items-center gap-2 ${isDarkMode ? 'bg-emerald-500/15 text-emerald-300' : 'bg-emerald-100 text-emerald-700'}`}
              >
                <FastForward className="w-3.5 h-3.5" />
                {playbackSpeed}x
              </button>
            )}
          </div>

          <div className="mt-4 space-y-3">
            {runList.map((run) => {
              const isBaseline = run.stage === 'baseline';
              const isOrder = run.stage === 'order';
              const onRun = isBaseline ? onRunBaseline : isOrder ? onRunOrder : onRunPath;
              const onReplay = isBaseline ? onReplayBaseline : isOrder ? onReplayOrder : onReplayPath;
              const ready = isBaseline ? baselineReady : isOrder ? orderReady : pathReady;

              return (
                <div key={run.stage} className={`rounded-[1.4rem] border p-4 ${isDarkMode ? 'border-white/10 bg-slate-950/50' : 'border-slate-200/70 bg-white/85'}`}>
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className={`text-[10px] uppercase tracking-[0.24em] font-bold ${muted}`}>{run.title}</p>
                      <p className="text-sm font-semibold mt-1">{run.subtitle}</p>
                    </div>
                    <div className={`px-3 py-1 rounded-full text-[11px] font-bold ${run.status === 'done' ? (isDarkMode ? 'bg-emerald-500/15 text-emerald-300' : 'bg-emerald-100 text-emerald-700') : run.status === 'running' ? (isDarkMode ? 'bg-amber-500/15 text-amber-300' : 'bg-amber-100 text-amber-700') : (isDarkMode ? 'bg-white/10 text-slate-300' : 'bg-slate-100 text-slate-600')}`}>
                      {statusLabel(run.status)}
                    </div>
                  </div>

                  {run.pickupPlan && (
                    <div className={`mt-3 rounded-xl px-3 py-3 ${isDarkMode ? 'bg-white/5' : 'bg-slate-100/80'}`}>
                      <p className="text-sm font-semibold">{run.pickupPlan.strategy}</p>
                      <p className={`text-xs mt-1 ${subtle}`}>{run.pickupPlan.summary}</p>
                      <p className={`text-xs mt-2 ${muted}`}>{run.pickupPlan.orderedLabels.slice(0, 5).join(' -> ')}</p>
                    </div>
                  )}

                  {run.metrics && run.evaluation && (
                    <div className="mt-3 grid grid-cols-2 gap-2">
                      <div className={`rounded-xl px-3 py-3 ${isDarkMode ? 'bg-white/5' : 'bg-slate-100/80'}`}>
                        <div className={`text-[10px] uppercase tracking-[0.2em] font-bold ${muted}`}>时间</div>
                        <div className="text-sm font-bold mt-1">{formatDurationLabel(run.metrics)}</div>
                      </div>
                      <div className={`rounded-xl px-3 py-3 ${isDarkMode ? 'bg-white/5' : 'bg-slate-100/80'}`}>
                        <div className={`text-[10px] uppercase tracking-[0.2em] font-bold ${muted}`}>完成度</div>
                        <div className="text-sm font-bold mt-1">{Math.round(run.metrics.completionRate * 100)}%</div>
                      </div>
                      <div className={`rounded-xl px-3 py-3 ${isDarkMode ? 'bg-white/5' : 'bg-slate-100/80'}`}>
                        <div className={`text-[10px] uppercase tracking-[0.2em] font-bold ${muted}`}>碰撞</div>
                        <div className="text-sm font-bold mt-1">{run.metrics.collisionCount}</div>
                      </div>
                      <div className={`rounded-xl px-3 py-3 ${isDarkMode ? 'bg-white/5' : 'bg-slate-100/80'}`}>
                        <div className={`text-[10px] uppercase tracking-[0.2em] font-bold ${muted}`}>评分</div>
                        <div className="text-sm font-bold mt-1">{run.evaluation.score}/100</div>
                      </div>
                    </div>
                  )}

                  {run.metrics && (
                    <div className={`mt-3 rounded-xl px-3 py-3 text-xs ${isDarkMode ? 'bg-white/5 text-slate-300' : 'bg-slate-100/80 text-slate-600'}`}>
                      <p>完成目标 {run.metrics.completedCount} / {run.metrics.targetCount}</p>
                      {run.metrics.endedByTimeout && <p className="mt-1">本轮因达到超时上限而终止，超时目标 {run.metrics.timeoutCount} 个。</p>}
                    </div>
                  )}

                  {run.evaluation && (
                    <p className={`text-xs mt-3 leading-relaxed ${subtle}`}>{run.evaluation.summary}</p>
                  )}

                  <div className="mt-4 grid grid-cols-2 gap-2">
                    <button
                      onClick={onRun}
                      disabled={!ready || isBusy || isPickingUp}
                      className={`rounded-2xl px-4 py-3 font-bold text-sm flex items-center justify-center gap-2 transition-all ${
                        !ready || isBusy || isPickingUp
                          ? (isDarkMode ? 'bg-slate-800 text-slate-600 cursor-not-allowed' : 'bg-slate-100 text-slate-400 cursor-not-allowed')
                          : (isDarkMode ? 'bg-slate-100 text-slate-900 hover:bg-white' : 'bg-slate-900 text-white hover:bg-black')
                      }`}
                    >
                      <PlayCircle className="w-4 h-4" />
                      运行
                    </button>
                    <button
                      onClick={onReplay}
                      disabled={run.status !== 'done' || isBusy || isPickingUp}
                      className={`rounded-2xl px-4 py-3 font-bold text-sm transition-all ${
                        run.status !== 'done' || isBusy || isPickingUp
                          ? (isDarkMode ? 'bg-slate-800 text-slate-600 cursor-not-allowed' : 'bg-slate-100 text-slate-400 cursor-not-allowed')
                          : (isDarkMode ? 'bg-white/5 text-slate-100 hover:bg-white/10' : 'bg-slate-100 text-slate-700 hover:bg-slate-200')
                      }`}
                    >
                      回放
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
          <p className={`text-xs mt-4 ${muted}`}>Baseline 使用默认顺序抓取执行。三轮评估均在后台全速仿真中执行，回放单独在主视图可视化展示。</p>
        </section>

        <section className={`rounded-[1.6rem] border p-5 ${sectionCard}`}>
          <div className="flex items-center gap-2">
            <History className={`w-4 h-4 ${isDarkMode ? 'text-violet-300' : 'text-violet-600'}`} />
            <h3 className="text-base font-bold">最近记录</h3>
          </div>

          <div className="mt-4 space-y-3">
            {logs.length === 0 ? (
              <div className={`rounded-[1.4rem] border-2 border-dashed px-4 py-8 text-center text-sm ${isDarkMode ? 'border-white/10 text-slate-500' : 'border-slate-200 text-slate-400'}`}>
                还没有实验记录。
              </div>
            ) : (
              logs.slice(0, 4).map((log) => {
                const items = Array.isArray(log.result) ? (log.result as DetectedItem[]) : [];
                const errorMessage = hasError(log.result) ? String((log.result as { error?: string }).error ?? 'Unknown error') : null;
                const meta = getLogMeta(log);

                return (
                  <button
                    key={log.id}
                    onClick={() => onOpenLog(log)}
                    className={`w-full text-left rounded-[1.4rem] border p-3 flex gap-4 transition-all ${isDarkMode ? 'border-white/10 bg-slate-950/55 hover:bg-slate-900/80' : 'border-slate-200/70 bg-white/85 hover:bg-white'}`}
                  >
                    <div className={`relative w-24 shrink-0 overflow-hidden rounded-xl border ${isDarkMode ? 'border-white/10 bg-black/20' : 'border-slate-200 bg-slate-50'}`}>
                      <img src={log.imageSrc} className="block w-full h-auto" alt="Simulation snapshot" />
                      <LogOverlay log={log} />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-3">
                        <span className={`text-[10px] uppercase tracking-[0.24em] font-bold ${muted}`}>{log.timestamp.toLocaleTimeString()}</span>
                        <span className={`text-[10px] font-bold ${errorMessage ? 'text-red-500' : (isDarkMode ? 'text-emerald-300' : 'text-emerald-700')}`}>
                          {errorMessage ? '失败' : `${items.length} 个目标`}
                        </span>
                      </div>
                      <p className="text-sm font-semibold mt-2 line-clamp-2">{log.prompt}</p>
                      <p className={`text-[13px] mt-2 line-clamp-2 ${muted}`}>{errorMessage ?? log.fullPrompt}</p>
                    </div>
                  </button>
                );
              })
            )}
          </div>

          {latestLog && Array.isArray(latestLog.result) && (
            <p className={`text-sm mt-4 ${subtle}`}>最近一次记录包含 {latestLog.result.length} 个可抓取目标。</p>
          )}
        </section>
      </div>
    </div>
  );
}
