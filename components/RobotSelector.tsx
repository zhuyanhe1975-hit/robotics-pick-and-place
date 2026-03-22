/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/

interface RobotSelectorProps {
  gizmoStats: { pos: string; rot: string } | null;
  isDarkMode: boolean;
}

export function RobotSelector({ gizmoStats, isDarkMode }: RobotSelectorProps) {
  const panelStyle = isDarkMode ? 'bg-slate-900/80 border-white/10 text-slate-100' : 'bg-white/70 border-white/80 text-slate-800';
  const labelStyle = isDarkMode ? 'text-slate-400' : 'text-slate-500';
  const valueStyle = isDarkMode ? 'text-slate-300' : 'text-slate-600';

  return (
    <div className="absolute top-8 left-1/2 -translate-x-1/2 min-[660px]:left-8 min-[660px]:translate-x-0 z-20 flex flex-col gap-3">
      <div className={`glass-panel px-6 py-4 rounded-[1.6rem] min-w-[220px] shadow-2xl ${panelStyle}`}>
        <p className={`text-[10px] uppercase tracking-[0.28em] font-bold ${labelStyle}`}>Robot</p>
        <h1 className="text-lg font-bold mt-1">Franka Panda</h1>
      </div>

      {gizmoStats && (
        <div className={`glass-card px-4 py-3 rounded-2xl shadow-sm ${isDarkMode ? 'bg-slate-800/60 border-white/5' : 'bg-white/40 border-white/50'}`}>
          <div className="font-mono text-[10px] space-y-1">
            <p className="flex justify-between gap-4"><span className={labelStyle}>POS</span><span className={`${valueStyle} font-semibold`}>{gizmoStats.pos}</span></p>
            <p className="flex justify-between gap-4"><span className={labelStyle}>ROT</span><span className={`${valueStyle} font-semibold`}>{gizmoStats.rot}</span></p>
          </div>
        </div>
      )}
    </div>
  );
}
