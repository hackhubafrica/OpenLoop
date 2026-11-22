import React, { useMemo, useState } from 'react';
import {
  ControlModel,
  TimeSample,
} from '../types/control';
import {
  TopologyEdge,
  TopologyEdgeKind,
  TopologyNode,
  extractStateSpaceTopology,
  formatGainShort,
} from '../engine/topology';

interface StateSpaceTopologyViewerProps {
  model: ControlModel;
  sample: TimeSample | undefined;
  isPlaying: boolean;
  onInspectTarget?: (group: 'controller' | 'matrices') => void;
}

type LayerFilter = 'all' | 'plant' | 'a_graph' | 'feedback';

const EDGE_COLORS: Record<TopologyEdgeKind, string> = {
  actuation: '#06B6D4',
  B: '#38BDF8',
  A_coupling: '#F59E0B',
  A_self: '#F59E0B',
  C: '#10B981',
  D_feedthrough: '#FB923C',
  lqr_fb: '#818CF8',
  pid_fb: '#A78BFA',
};

const NODE_ACCENTS: Record<TopologyNode['kind'], string> = {
  controller: '#06B6D4',
  input: '#38BDF8',
  state: '#F59E0B',
  output: '#10B981',
};

function computeEdgeGeometry(
  edge: TopologyEdge,
  nodeMap: Map<string, TopologyNode>,
  viewBoxHeight: number
): { path: string; labelX: number; labelY: number } | null {
  const src = nodeMap.get(edge.fromId);
  const dst = nodeMap.get(edge.toId);
  if (!src || !dst) return null;

  if (edge.kind === 'A_self') {
    const startX = src.x + src.width - 36;
    const endX = src.x + src.width - 10;
    const topY = src.y;
    const archY = topY - 20;
    return {
      path: `M ${startX} ${topY} C ${startX} ${archY}, ${endX} ${archY}, ${endX} ${topY - 2}`,
      labelX: (startX + endX) / 2,
      labelY: archY + 3,
    };
  }

  if (edge.kind === 'A_coupling') {
    const isForward = edge.direction === 'forward';
    if (isForward) {
      const sx = src.x + src.width;
      const sy = src.y + src.height * 0.34;
      const dx = dst.x + dst.width;
      const dy = dst.y + dst.height * 0.66;
      const ctrlX = sx + 22 + (edge.laneIndex % 6) * 9;
      return {
        path: `M ${sx} ${sy} C ${ctrlX} ${sy}, ${ctrlX} ${dy}, ${dx + 3} ${dy}`,
        labelX: ctrlX - 2,
        labelY: (sy + dy) / 2,
      };
    }
    const sx = src.x;
    const sy = src.y + src.height * 0.34;
    const dx = dst.x;
    const dy = dst.y + dst.height * 0.66;
    const ctrlX = sx - 22 - (edge.laneIndex % 6) * 9;
    return {
      path: `M ${sx} ${sy} C ${ctrlX} ${sy}, ${ctrlX} ${dy}, ${dx - 3} ${dy}`,
      labelX: ctrlX + 2,
      labelY: (sy + dy) / 2,
    };
  }

  if (edge.kind === 'D_feedthrough') {
    const sx = src.x + src.width * 0.55;
    const sy = src.y;
    const dx = dst.x + dst.width * 0.45;
    const dy = dst.y;
    const topY = 22 + (edge.laneIndex % 4) * 11;
    return {
      path: `M ${sx} ${sy} L ${sx} ${topY} L ${dx} ${topY} L ${dx} ${dy - 3}`,
      labelX: (sx + dx) / 2,
      labelY: topY - 4,
    };
  }

  if (edge.kind === 'lqr_fb' || edge.kind === 'pid_fb') {
    const sx = src.x + src.width * 0.5;
    const sy = src.y + src.height;
    const dx = dst.x + dst.width * (edge.kind === 'pid_fb' ? 0.65 : 0.38);
    const dy = dst.y + dst.height;
    const busY = viewBoxHeight - 16 - (edge.laneIndex % 6) * 11;
    return {
      path: `M ${sx} ${sy} L ${sx} ${busY} L ${dx} ${busY} L ${dx} ${dy + 3}`,
      labelX: (sx + dx) / 2,
      labelY: busY - 4,
    };
  }

  // Forward paths: actuation, B, C
  const sx = src.x + src.width;
  const sy = src.y + src.height / 2;
  const dx = dst.x;
  const dy = dst.y + dst.height / 2;
  const span = dx - sx;
  const c1x = sx + span * 0.48;
  const c2x = dx - span * 0.48;
  return {
    path: `M ${sx} ${sy} C ${c1x} ${sy}, ${c2x} ${dy}, ${dx - 3} ${dy}`,
    labelX: (sx + dx) / 2,
    labelY: (sy + dy) / 2 - 4,
  };
}

function getNodeLiveValue(
  node: TopologyNode,
  model: ControlModel,
  sample: TimeSample | undefined
): number {
  if (node.kind === 'controller') {
    return sample?.uSat ?? 0;
  }
  if (node.kind === 'input') {
    if (node.index === 0) return sample?.uSat ?? 0;
    return model.plant.auxInputs?.[node.index] ?? 0;
  }
  if (node.kind === 'state') {
    return sample?.silStates?.[node.index] ?? model.plant.x0[node.index] ?? 0;
  }
  return sample?.silOutputs?.[node.index] ?? 0;
}

function edgeMatchesLayer(edge: TopologyEdge, layer: LayerFilter): boolean {
  if (layer === 'all') return true;
  if (layer === 'plant') {
    return (
      edge.kind === 'B' ||
      edge.kind === 'A_coupling' ||
      edge.kind === 'A_self' ||
      edge.kind === 'C' ||
      edge.kind === 'D_feedthrough'
    );
  }
  if (layer === 'a_graph') {
    return edge.kind === 'A_coupling' || edge.kind === 'A_self';
  }
  return (
    edge.kind === 'lqr_fb' ||
    edge.kind === 'pid_fb' ||
    edge.kind === 'actuation'
  );
}

export const StateSpaceTopologyViewer: React.FC<StateSpaceTopologyViewerProps> = ({
  model,
  sample,
  isPlaying,
  onInspectTarget,
}) => {
  const [layer, setLayer] = useState<LayerFilter>('all');
  const [pinnedNodeId, setPinnedNodeId] = useState<string | null>(null);
  const [pinnedEdgeId, setPinnedEdgeId] = useState<string | null>(null);
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);
  const [hoveredEdgeId, setHoveredEdgeId] = useState<string | null>(null);

  const topology = useMemo(() => extractStateSpaceTopology(model), [model]);
  const nodeMap = useMemo(
    () => new Map(topology.nodes.map((n) => [n.id, n])),
    [topology.nodes]
  );

  const activeNodeId = hoveredNodeId ?? pinnedNodeId;
  const activeEdgeId = hoveredEdgeId ?? pinnedEdgeId;

  const visibleEdges = useMemo(
    () => topology.edges.filter((edge) => edgeMatchesLayer(edge, layer)),
    [topology.edges, layer]
  );

  const connectedNodeIds = useMemo(() => {
    const set = new Set<string>();
    if (activeNodeId) {
      set.add(activeNodeId);
      visibleEdges.forEach((e) => {
        if (e.fromId === activeNodeId || e.toId === activeNodeId) {
          set.add(e.fromId);
          set.add(e.toId);
        }
      });
    } else if (activeEdgeId) {
      const edge = topology.edges.find((e) => e.id === activeEdgeId);
      if (edge) {
        set.add(edge.fromId);
        set.add(edge.toId);
      }
    }
    return set;
  }, [activeNodeId, activeEdgeId, visibleEdges, topology.edges]);

  const showDenseEdgeLabels = visibleEdges.length <= 16;

  const inspectedNode =
    (activeNodeId ? nodeMap.get(activeNodeId) : undefined) ?? null;
  const inspectedEdge =
    (activeEdgeId ? topology.edges.find((e) => e.id === activeEdgeId) : undefined) ??
    null;

  const { diagnostics } = topology;

  return (
    <div className="flex flex-col h-full">
      {/* Header Bar */}
      <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 border-b border-slate-800/80">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-xs font-medium text-slate-300 whitespace-nowrap">
            State-Space Topology Model
          </span>
          <span className="text-slate-600" aria-hidden="true">
            ·
          </span>
          <span className="text-[11px] font-mono text-cyan-300 truncate">
            {diagnostics.patternLabel}
          </span>
          <span className="text-[11px] font-mono tabular-nums text-slate-400 whitespace-nowrap">
            ({diagnostics.n}×{diagnostics.m}→{diagnostics.p} · {diagnostics.nonZeroA} A /{' '}
            {diagnostics.nonZeroB} B / {diagnostics.nonZeroC} C
            {diagnostics.nonZeroD > 0 ? ` / ${diagnostics.nonZeroD} D` : ''})
          </span>
        </div>

        {/* Layer Filter Switch */}
        <div
          className="flex items-center bg-[#07090E] border border-slate-800 rounded p-0.5 shrink-0"
          role="group"
          aria-label="Topology layer filter"
        >
          {(
            [
              ['all', 'All'],
              ['plant', 'Plant (A,B,C,D)'],
              ['a_graph', 'A Couplings'],
              ['feedback', 'Feedback'],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              onClick={() => setLayer(key)}
              className={`px-2 py-0.5 text-[10px] font-mono rounded transition-colors cursor-pointer whitespace-nowrap shrink-0 ${
                layer === key
                  ? 'bg-cyan-500/20 text-cyan-300'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* Main Dynamic SVG Signal-Flow Stage */}
      <div className="flex-1 bg-[#07090E] p-2 overflow-hidden flex items-center justify-center">
        <svg
          viewBox={`0 0 ${topology.viewBoxWidth} ${topology.viewBoxHeight}`}
          className="w-full h-full max-h-[340px]"
          onClick={(e) => {
            if (e.target === e.currentTarget) {
              setPinnedNodeId(null);
              setPinnedEdgeId(null);
            }
          }}
        >
          <defs>
            {(['actuation', 'B', 'A_coupling', 'A_self', 'C', 'D_feedthrough', 'lqr_fb', 'pid_fb'] as TopologyEdgeKind[]).map(
              (kind) => (
                <marker
                  key={kind}
                  id={`topo-arrow-${kind}`}
                  viewBox="0 0 10 10"
                  refX="8"
                  refY="5"
                  markerWidth="5.5"
                  markerHeight="5.5"
                  orient="auto-start-reverse"
                >
                  <path d="M 0 1 L 10 5 L 0 9 z" fill={EDGE_COLORS[kind]} />
                </marker>
              )
            )}
            <pattern
              id="topo-grid-dots"
              width="20"
              height="20"
              patternUnits="userSpaceOnUse"
            >
              <circle cx="1" cy="1" r="0.8" fill="#1E293B" />
            </pattern>
          </defs>

          <rect
            width={topology.viewBoxWidth}
            height={topology.viewBoxHeight}
            fill="url(#topo-grid-dots)"
          />

          {/* Column Stage Headers */}
          <text x="20" y="15" fill="#64748B" fontSize="9.5" fontFamily="IBM Plex Mono, monospace">
            CONTROL LAW
          </text>
          <text x="202" y="15" fill="#64748B" fontSize="9.5" fontFamily="IBM Plex Mono, monospace">
            INPUTS u (B, D)
          </text>
          <text x="480" y="15" fill="#64748B" fontSize="9.5" fontFamily="IBM Plex Mono, monospace">
            INTEGRATORS ∫dt · STATES x (A)
          </text>
          <text x="790" y="15" fill="#64748B" fontSize="9.5" fontFamily="IBM Plex Mono, monospace">
            OUTPUTS y (C, D)
          </text>

          {/* Structural Edges */}
          {visibleEdges.map((edge) => {
            const geom = computeEdgeGeometry(
              edge,
              nodeMap,
              topology.viewBoxHeight
            );
            if (!geom) return null;

            const isFocused =
              activeEdgeId === edge.id ||
              (activeNodeId !== null &&
                (edge.fromId === activeNodeId || edge.toId === activeNodeId));
            const isDimmed =
              (activeNodeId !== null || activeEdgeId !== null) && !isFocused;

            const color = EDGE_COLORS[edge.kind];
            const showLabel = isFocused || showDenseEdgeLabels;

            return (
              <g
                key={edge.id}
                opacity={isDimmed ? 0.16 : isFocused ? 1 : 0.78}
                className="cursor-pointer"
                onMouseEnter={() => setHoveredEdgeId(edge.id)}
                onMouseLeave={() => setHoveredEdgeId(null)}
                onClick={(e) => {
                  e.stopPropagation();
                  setPinnedNodeId(null);
                  setPinnedEdgeId(pinnedEdgeId === edge.id ? null : edge.id);
                }}
              >
                {/* Hitbox */}
                <path d={geom.path} fill="none" stroke="transparent" strokeWidth="10" />
                <path
                  d={geom.path}
                  fill="none"
                  stroke={color}
                  strokeWidth={isFocused ? 2.2 : edge.kind === 'A_coupling' ? 1.55 : 1.35}
                  strokeDasharray={
                    edge.kind === 'D_feedthrough'
                      ? '5 3'
                      : edge.kind === 'lqr_fb' || edge.kind === 'pid_fb'
                      ? isPlaying
                        ? '6 3'
                        : '4 3'
                      : isPlaying
                      ? '7 4'
                      : undefined
                  }
                  markerEnd={`url(#topo-arrow-${edge.kind})`}
                />
                {showLabel && (
                  <g>
                    <rect
                      x={geom.labelX - 30}
                      y={geom.labelY - 8}
                      width="60"
                      height="13"
                      rx="2"
                      fill="#0B0E17"
                      fillOpacity="0.92"
                      stroke={isFocused ? color : '#1E293B'}
                      strokeWidth="0.8"
                    />
                    <text
                      x={geom.labelX}
                      y={geom.labelY + 1}
                      textAnchor="middle"
                      fill={isFocused ? '#F8FAFC' : color}
                      fontSize="8.5"
                      fontFamily="IBM Plex Mono, monospace"
                    >
                      {edge.kind === 'A_self'
                        ? `a=${edge.label}`
                        : edge.kind === 'actuation'
                        ? 'u_sat'
                        : edge.kind === 'pid_fb'
                        ? 'PID'
                        : formatGainShort(edge.gain)}
                    </text>
                  </g>
                )}
              </g>
            );
          })}

          {/* Dynamic Topology Nodes */}
          {topology.nodes.map((node) => {
            const accent = NODE_ACCENTS[node.kind];
            const isSelected = activeNodeId === node.id;
            const isRelated =
              activeNodeId === null && activeEdgeId === null
                ? true
                : connectedNodeIds.has(node.id);
            const liveVal = getNodeLiveValue(node, model, sample);
            const titleText =
              node.label.length > 16 ? `${node.label.slice(0, 15)}…` : node.label;

            return (
              <g
                key={node.id}
                opacity={isRelated ? 1 : 0.28}
                className="cursor-pointer"
                onMouseEnter={() => setHoveredNodeId(node.id)}
                onMouseLeave={() => setHoveredNodeId(null)}
                onClick={(e) => {
                  e.stopPropagation();
                  setPinnedEdgeId(null);
                  setPinnedNodeId(pinnedNodeId === node.id ? null : node.id);
                }}
              >
                <rect
                  x={node.x}
                  y={node.y}
                  width={node.width}
                  height={node.height}
                  rx="3"
                  fill={isSelected ? '#162032' : '#0F141E'}
                  stroke={isSelected ? accent : '#1E293B'}
                  strokeWidth={isSelected ? '1.8' : '1.1'}
                />
                {/* Top semantic bar */}
                <rect
                  x={node.x}
                  y={node.y}
                  width={node.width}
                  height="3"
                  rx="1"
                  fill={accent}
                />

                {/* Header Row: short symbol + live value */}
                <text
                  x={node.x + 8}
                  y={node.y + 16}
                  fill="#F8FAFC"
                  fontSize="10"
                  fontWeight="600"
                  fontFamily="IBM Plex Mono, monospace"
                >
                  {node.shortLabel}
                </text>
                <text
                  x={node.x + node.width - 8}
                  y={node.y + 16}
                  textAnchor="end"
                  fill={accent}
                  fontSize="9.5"
                  fontWeight="600"
                  fontFamily="IBM Plex Mono, monospace"
                >
                  {liveVal.toFixed(2)} {node.unit}
                </text>

                {/* Signal name */}
                <text
                  x={node.x + 8}
                  y={node.y + 30}
                  fill="#CBD5E1"
                  fontSize="9.5"
                  fontFamily="IBM Plex Sans, sans-serif"
                >
                  {titleText}
                </text>

                {/* Footer meta */}
                <text
                  x={node.x + 8}
                  y={node.y + node.height - 7}
                  fill="#64748B"
                  fontSize="8.2"
                  fontFamily="IBM Plex Mono, monospace"
                >
                  {node.kind === 'state'
                    ? `∫dt · ${node.subLabel}${node.hasSelfLoop ? ` · a=${formatGainShort(node.selfLoopGain ?? 0)}` : ''}`
                    : node.subLabel}
                </text>
              </g>
            );
          })}
        </svg>
      </div>

      {/* Structural Equation & Connection Inspector Footer */}
      <div className="border-t border-slate-800/80 bg-[#0B0E17] px-3 py-1.5 flex flex-wrap items-center justify-between gap-2 text-[11px] font-mono">
        {inspectedNode ? (
          <div className="flex flex-wrap items-center gap-2 min-w-0">
            <span className="text-cyan-300 font-semibold whitespace-nowrap">
              {inspectedNode.shortLabel} ({inspectedNode.label}):
            </span>
            <span className="text-slate-200 truncate">
              {topology.nodeEquations[inspectedNode.id]}
            </span>
          </div>
        ) : inspectedEdge ? (
          <div className="flex flex-wrap items-center gap-2 min-w-0">
            <span className="text-amber-300 font-semibold whitespace-nowrap">
              {inspectedEdge.label}:
            </span>
            <span className="text-slate-200 truncate">
              {inspectedEdge.equationTerm}
            </span>
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-3 text-slate-400">
            <span>
              <span className="text-sky-300">B</span> input
            </span>
            <span>
              <span className="text-amber-300">A</span> couplings ({diagnostics.crossCouplings} cross · {diagnostics.selfLoops} self)
            </span>
            <span>
              <span className="text-emerald-300">C</span> output
            </span>
            {diagnostics.hasDirectFeedthrough && (
              <span>
                <span className="text-orange-300">D</span> feedthrough
              </span>
            )}
            {(diagnostics.activeLqrCount > 0 || diagnostics.pidActive) && (
              <span>
                <span className="text-indigo-300">−K / PID</span> closed-loop
              </span>
            )}
            <span className="text-slate-500">· Click node or edge to inspect equations</span>
          </div>
        )}

        {onInspectTarget && (
          <button
            type="button"
            onClick={() =>
              onInspectTarget(
                inspectedNode?.kind === 'controller' ? 'controller' : 'matrices'
              )
            }
            className="text-[10px] font-mono text-cyan-400 hover:text-cyan-300 cursor-pointer whitespace-nowrap shrink-0"
          >
            {inspectedNode?.kind === 'controller'
              ? 'Edit Controller →'
              : 'Edit Matrices →'}
          </button>
        )}
      </div>
    </div>
  );
};
