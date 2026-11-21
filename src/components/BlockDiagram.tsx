import React from 'react';
import { BlockKind, BlockNode, ControlModel, ValidationReport } from '../types/control';

interface BlockDiagramProps {
  model: ControlModel;
  validation: ValidationReport;
  selectedBlockId: string | null;
  onSelectBlock: (blockId: string) => void;
  isPlaying: boolean;
}

const KIND_ACCENT: Record<BlockKind, string> = {
  step_ref: '#94A3B8',
  sum: '#38BDF8',
  lqr_gain: '#06B6D4',
  pid: '#06B6D4',
  rate_limiter: '#F59E0B',
  saturation: '#F59E0B',
  rate_transition: '#A78BFA',
  state_space: '#10B981',
  hil_io: '#64748B',
};

export const BlockDiagram: React.FC<BlockDiagramProps> = ({
  model,
  validation,
  selectedBlockId,
  onSelectBlock,
  isPlaying,
}) => {
  const blockMap = new Map(model.blocks.map((b) => [b.id, b]));
  const loopBlocks = new Set(
    validation.issues
      .filter((i) => i.code === 'ALGEBRAIC_LOOP')
      .flatMap((i) => i.involvedBlocks)
  );

  const boxW = 112;
  const boxH = 44;

  const edgesToRender = [...model.edges];
  if (model.injectAlgebraicLoopTest) {
    edgesToRender.push({
      id: 'e_loop_test',
      from: 'lqr_ctrl',
      fromPort: 'u_lqr',
      to: 'sum_err',
      toPort: 'alg_fb',
      signalName: 'algebraic_loop',
    });
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-3 py-2 border-b border-slate-800/80">
        <span className="text-xs font-medium text-slate-300">
          Declarative Control Graph
        </span>
        <span className="text-[11px] font-mono tabular-nums text-slate-400">
          {model.blocks.length} blocks · {edgesToRender.length} signals ·{' '}
          {model.discretization.toUpperCase()}
        </span>
      </div>

      <div className="flex-1 bg-[#07090E] p-2 overflow-hidden flex items-center justify-center">
        <svg viewBox="0 0 865 305" className="w-full h-full max-h-[260px]">
          <defs>
            <marker
              id="arrow-normal"
              viewBox="0 0 10 10"
              refX="8"
              refY="5"
              markerWidth="6"
              markerHeight="6"
              orient="auto-start-reverse"
            >
              <path d="M 0 1 L 10 5 L 0 9 z" fill="#475569" />
            </marker>
            <marker
              id="arrow-error"
              viewBox="0 0 10 10"
              refX="8"
              refY="5"
              markerWidth="6"
              markerHeight="6"
              orient="auto-start-reverse"
            >
              <path d="M 0 1 L 10 5 L 0 9 z" fill="#F43F5E" />
            </marker>
          </defs>

          {/* Subtle blueprint dot grid */}
          <pattern
            id="grid-dots"
            width="20"
            height="20"
            patternUnits="userSpaceOnUse"
          >
            <circle cx="1" cy="1" r="0.8" fill="#1E293B" />
          </pattern>
          <rect width="865" height="305" fill="url(#grid-dots)" />

          {/* Edges */}
          {edgesToRender.map((edge) => {
            const src = blockMap.get(edge.from);
            const dst = blockMap.get(edge.to);
            if (!src || !dst) return null;

            const isFeedback = src.x >= dst.x;
            const isErrorEdge = edge.id === 'e_loop_test';
            const sx = src.x + boxW;
            const sy = src.y + boxH / 2;
            const dx = dst.x;
            const dy = dst.y + boxH / 2;

            let pathD = '';
            if (isFeedback) {
              const dropY = Math.max(src.y, dst.y) + boxH + 34;
              pathD = `M ${src.x + boxW / 2} ${src.y + boxH} L ${src.x + boxW / 2} ${dropY} L ${dst.x + boxW / 2} ${dropY} L ${dst.x + boxW / 2} ${dst.y + boxH + 2}`;
            } else {
              const midX = (sx + dx) / 2;
              pathD = `M ${sx} ${sy} L ${midX} ${sy} L ${midX} ${dy} L ${dx - 3} ${dy}`;
            }

            return (
              <g key={edge.id}>
                <path
                  d={pathD}
                  fill="none"
                  stroke={isErrorEdge ? '#F43F5E' : '#334155'}
                  strokeWidth={isErrorEdge ? '2' : '1.4'}
                  strokeDasharray={
                    isErrorEdge
                      ? '5 3'
                      : isPlaying
                      ? '6 4'
                      : undefined
                  }
                  markerEnd={isErrorEdge ? 'url(#arrow-error)' : 'url(#arrow-normal)'}
                />
              </g>
            );
          })}

          {/* Blocks */}
          {model.blocks.map((block: BlockNode) => {
            const isSelected = selectedBlockId === block.id;
            const hasLoopFault = loopBlocks.has(block.id);
            const accent = hasLoopFault ? '#F43F5E' : KIND_ACCENT[block.kind];
            const dtText =
              block.dt === 0
                ? 'CONT (RK4)'
                : `${Math.round(1 / block.dt)} Hz`;

            return (
              <g
                key={block.id}
                onClick={() => onSelectBlock(block.id)}
                className="cursor-pointer"
              >
                <rect
                  x={block.x}
                  y={block.y}
                  width={boxW}
                  height={boxH}
                  rx="3"
                  fill={isSelected ? '#162032' : '#0F141E'}
                  stroke={isSelected ? '#06B6D4' : hasLoopFault ? '#F43F5E' : '#1E293B'}
                  strokeWidth={isSelected || hasLoopFault ? '1.8' : '1'}
                />
                {/* Top indicator bar */}
                <rect
                  x={block.x}
                  y={block.y}
                  width={boxW}
                  height="3"
                  rx="1"
                  fill={accent}
                />
                <text
                  x={block.x + 8}
                  y={block.y + 19}
                  fill="#F1F5F9"
                  fontSize="10"
                  fontWeight="600"
                  fontFamily="IBM Plex Sans, sans-serif"
                >
                  {block.label.length > 17
                    ? `${block.label.slice(0, 16)}…`
                    : block.label}
                </text>
                <text
                  x={block.x + 8}
                  y={block.y + 34}
                  fill="#94A3B8"
                  fontSize="8.5"
                  fontFamily="IBM Plex Mono, monospace"
                >
                  {block.id} · {dtText}
                </text>
              </g>
            );
          })}
        </svg>
      </div>
    </div>
  );
};
