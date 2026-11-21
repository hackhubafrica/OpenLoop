import React from 'react';
import { Download } from 'lucide-react';

export type AppView = 'workbench' | 'schema' | 'codegen' | 'hil' | 'architecture';

interface HeaderProps {
  activeView: AppView;
  onSelectView: (view: AppView) => void;
  onExportBundle: () => void;
}

const NAV_ITEMS: { id: AppView; label: string }[] = [
  { id: 'workbench', label: 'Workbench' },
  { id: 'schema', label: 'Schema & IR' },
  { id: 'codegen', label: 'Codegen' },
  { id: 'hil', label: 'HIL Bridge' },
  { id: 'architecture', label: 'Architecture' },
];

export const Header: React.FC<HeaderProps> = ({
  activeView,
  onSelectView,
  onExportBundle,
}) => {
  return (
    <header className="h-14 border-b border-slate-800 bg-[#0B0E17] px-6 flex items-center justify-between gap-8 shrink-0">
      {/* Zone 1: Single text element wordmark */}
      <button
        type="button"
        onClick={() => onSelectView('workbench')}
        className="font-display text-lg font-bold tracking-tight text-slate-100 whitespace-nowrap shrink-0 hover:text-cyan-400 transition-colors cursor-pointer"
      >
        OpenLoop
      </button>

      {/* Zone 2: Clean single-line text navigation links */}
      <nav className="flex items-center gap-6 overflow-x-auto" aria-label="Primary">
        {NAV_ITEMS.map((item) => {
          const isActive = activeView === item.id;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => onSelectView(item.id)}
              className={`relative py-4 text-sm font-medium whitespace-nowrap shrink-0 transition-colors cursor-pointer ${
                isActive
                  ? 'text-cyan-400'
                  : 'text-slate-400 hover:text-slate-100'
              }`}
            >
              {item.label}
              {isActive && (
                <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-cyan-400" />
              )}
            </button>
          );
        })}
      </nav>

      {/* Zone 3: Single primary CTA button */}
      <div className="shrink-0">
        <button
          type="button"
          onClick={onExportBundle}
          className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold text-slate-950 bg-cyan-400 hover:bg-cyan-300 rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer"
        >
          <Download className="w-3.5 h-3.5" />
          Export Bundle
        </button>
      </div>
    </header>
  );
};
