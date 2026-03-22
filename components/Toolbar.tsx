/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/

import { Moon, PanelRight, Pause, Play, RotateCcw, Sun } from 'lucide-react';

interface ToolbarProps {
  isPaused: boolean;
  togglePause: () => void;
  onReset: () => void;
  showSidebar: boolean;
  toggleSidebar: () => void;
  isDarkMode: boolean;
  toggleDarkMode: () => void;
}

export function Toolbar({
  isPaused,
  togglePause,
  onReset,
  showSidebar,
  toggleSidebar,
  isDarkMode,
  toggleDarkMode,
}: ToolbarProps) {
  const panelStyle = isDarkMode ? 'bg-slate-900/80 border-white/10 text-slate-100' : 'bg-white/70 border-white/80 text-slate-800';
  const activeStyle = showSidebar ? (isDarkMode ? 'text-amber-300 bg-slate-800' : 'text-amber-600 bg-white') : panelStyle;

  return (
    <div className="absolute bottom-8 left-1/2 -translate-x-1/2 min-[660px]:left-8 min-[660px]:translate-x-0 flex items-center gap-3 z-30">
      <button onClick={togglePause} className={`w-12 h-12 rounded-2xl glass-panel flex items-center justify-center transition-all hover:scale-105 active:scale-95 shadow-xl ${panelStyle}`} title={isPaused ? '继续' : '暂停'}>
        {isPaused ? <Play className="w-5 h-5" /> : <Pause className="w-5 h-5" />}
      </button>

      <button onClick={onReset} className={`w-12 h-12 rounded-2xl glass-panel flex items-center justify-center transition-all hover:scale-105 active:scale-95 shadow-xl ${panelStyle}`} title="重置">
        <RotateCcw className="w-5 h-5" />
      </button>

      <button onClick={toggleDarkMode} className={`w-12 h-12 rounded-2xl glass-panel flex items-center justify-center transition-all hover:scale-105 active:scale-95 shadow-xl ${panelStyle}`} title={isDarkMode ? '浅色模式' : '深色模式'}>
        {isDarkMode ? <Sun className="w-5 h-5" /> : <Moon className="w-5 h-5" />}
      </button>

      <button onClick={toggleSidebar} className={`w-12 h-12 rounded-2xl glass-panel flex items-center justify-center transition-all hover:scale-105 active:scale-95 shadow-xl ${activeStyle}`} title="任务面板">
        <PanelRight className="w-5 h-5" />
      </button>
    </div>
  );
}
