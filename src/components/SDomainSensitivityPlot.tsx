import React, { useEffect, useMemo, useRef, useState } from 'react';
import * as d3 from 'd3';
import { ControlModel } from '../types/control';
import {
  computeSDomainSensitivity,
  getModelSensitivityParameters,
  SensitivityTrajectoryPoint,
} from '../engine/stability';

interface SDomainSensitivityPlotProps {
  model: ControlModel;
}

type SweepRangePreset = {
  id: 'tight' | 'standard' | 'wide';
  label: string;
  min: number;
  max: number;
};

const SWEEP_PRESETS: SweepRangePreset[] = [
  { id: 'tight', label: '0.5×–1.5×', min: 0.5, max: 1.5 },
  { id: 'standard', label: '0.25×–2.5×', min: 0.25, max: 2.5 },
  { id: 'wide', label: '0.1×–4.0×', min: 0.1, max: 4.0 },
];

const sensitivityColorInterpolator = d3.interpolateRgbBasis([
  '#06B6D4', // Cyan: low sensitivity
  '#10B981', // Emerald transition
  '#F59E0B', // Amber: moderate sensitivity
  '#F43F5E', // Rose: high sensitivity
]);

function formatNum(v: number, digits: number = 2): string {
  if (!Number.isFinite(v)) return '—';
  const abs = Math.abs(v);
  if (abs === 0) return '0';
  if (abs >= 1000 || (abs > 0 && abs < 0.01)) {
    return v.toExponential(1);
  }
  return v.toFixed(digits);
}

function formatComplex(re: number, im: number): string {
  const rStr = formatNum(re, 2);
  if (Math.abs(im) < 1e-4) return rStr;
  const sign = im >= 0 ? '+' : '−';
  return `${rStr} ${sign} j${formatNum(Math.abs(im), 2)}`;
}

export const SDomainSensitivityPlot: React.FC<SDomainSensitivityPlotProps> = ({
  model,
}) => {
  const parameters = useMemo(() => getModelSensitivityParameters(model), [model]);
  const [selectedParamId, setSelectedParamId] = useState<string>(
    () => parameters[0]?.id ?? ''
  );
  const [scope, setScope] = useState<'closed' | 'open'>('closed');
  const [rangeId, setRangeId] = useState<SweepRangePreset['id']>('standard');
  const [activeFactor, setActiveFactor] = useState<number>(1.0);
  const [hoverPoint, setHoverPoint] = useState<{
    branchId: number;
    point: SensitivityTrajectoryPoint;
  } | null>(null);

  const svgRef = useRef<SVGSVGElement | null>(null);

  useEffect(() => {
    setSelectedParamId((prev) =>
      parameters.some((p) => p.id === prev) ? prev : parameters[0]?.id ?? ''
    );
    setActiveFactor(1.0);
    setHoverPoint(null);
  }, [model.id, parameters]);

  const activeRange =
    SWEEP_PRESETS.find((r) => r.id === rangeId) ?? SWEEP_PRESETS[1];

  useEffect(() => {
    setActiveFactor((prev) =>
      Math.max(activeRange.min, Math.min(activeRange.max, prev))
    );
  }, [activeRange.min, activeRange.max]);

  const analysis = useMemo(
    () =>
      computeSDomainSensitivity(model, selectedParamId, {
        scope,
        minFactor: activeRange.min,
        maxFactor: activeRange.max,
        steps: 61,
        activeFactor,
      }),
    [model, selectedParamId, scope, activeRange.min, activeRange.max, activeFactor]
  );

  useEffect(() => {
    const svgEl = svgRef.current;
    if (!svgEl) return;

    const svg = d3.select(svgEl);
    svg.selectAll('*').remove();

    const width = 760;
    const height = 320;
    const margin = { top: 20, right: 26, bottom: 34, left: 56 };
    const innerW = width - margin.left - margin.right;
    const innerH = height - margin.top - margin.bottom;

    const allRe: number[] = [0];
    const allIm: number[] = [0];
    for (const b of analysis.branches) {
      for (const pt of b.points) {
        allRe.push(pt.re);
        allIm.push(pt.im);
      }
    }
    for (const ap of analysis.activePoles) {
      allRe.push(ap.re);
      allIm.push(ap.im);
    }

    const rawMinRe = Math.min(...allRe);
    const rawMaxRe = Math.max(...allRe);
    const rawMaxAbsIm = Math.max(1, ...allIm.map((v) => Math.abs(v)));

    const reSpan = Math.max(2, rawMaxRe - rawMinRe);
    const xMin = rawMinRe - reSpan * 0.14 - 0.35;
    const xMax = Math.max(reSpan * 0.14 + 0.35, rawMaxRe + reSpan * 0.14 + 0.35);

    const aspect = innerW / innerH;
    const reqSpanX = xMax - xMin;
    const minHalfYForX = reqSpanX / (2 * aspect);
    const halfSpanY = Math.max(rawMaxAbsIm * 1.18, minHalfYForX, 1.2);
    const centerX = (xMin + xMax) / 2;
    const halfSpanX = halfSpanY * aspect;

    const xScale = d3
      .scaleLinear()
      .domain([centerX - halfSpanX, centerX + halfSpanX])
      .range([0, innerW]);

    const yScale = d3
      .scaleLinear()
      .domain([-halfSpanY, halfSpanY])
      .range([innerH, 0]);

    const defs = svg.append('defs');
    defs
      .append('clipPath')
      .attr('id', 's-sensitivity-clip')
      .append('rect')
      .attr('x', 0)
      .attr('y', 0)
      .attr('width', innerW)
      .attr('height', innerH);

    // Direction arrowhead along increasing parameter α
    defs
      .append('marker')
      .attr('id', 'sens-arrow-head')
      .attr('viewBox', '0 0 10 10')
      .attr('refX', 7)
      .attr('refY', 5)
      .attr('markerWidth', 5)
      .attr('markerHeight', 5)
      .attr('orient', 'auto')
      .append('path')
      .attr('d', 'M 0 1 L 10 5 L 0 9 z')
      .attr('fill', '#E2E8F0');

    const g = svg
      .append('g')
      .attr('transform', `translate(${margin.left},${margin.top})`);

    const plotLayer = g
      .append('g')
      .attr('clip-path', 'url(#s-sensitivity-clip)');

    // RHP unstable zone shading (Re(s) > 0)
    if (xScale.domain()[1] > 0) {
      const rhpStart = Math.max(0, xScale(0));
      plotLayer
        .append('rect')
        .attr('x', rhpStart)
        .attr('y', 0)
        .attr('width', Math.max(0, innerW - rhpStart))
        .attr('height', innerH)
        .attr('fill', 'rgba(244, 63, 94, 0.08)');

      plotLayer
        .append('text')
        .attr('x', Math.min(innerW - 8, rhpStart + 8))
        .attr('y', 14)
        .attr('fill', 'rgba(251, 113, 133, 0.72)')
        .attr('font-size', 9.5)
        .attr('font-family', 'JetBrains Mono, monospace')
        .text('RHP UNSTABLE (σ > 0)');
    }

    // Subtle Cartesian grid
    plotLayer
      .append('g')
      .selectAll('line')
      .data(xScale.ticks(8))
      .join('line')
      .attr('x1', (d) => xScale(d))
      .attr('x2', (d) => xScale(d))
      .attr('y1', 0)
      .attr('y2', innerH)
      .attr('stroke', '#151D2B')
      .attr('stroke-width', 1);

    plotLayer
      .append('g')
      .selectAll('line')
      .data(yScale.ticks(6))
      .join('line')
      .attr('x1', 0)
      .attr('x2', innerW)
      .attr('y1', (d) => yScale(d))
      .attr('y2', (d) => yScale(d))
      .attr('stroke', '#151D2B')
      .attr('stroke-width', 1);

    // Damping ratio guide rays (ζ = 0.5 and ζ = 0.707)
    const rayRadius = Math.max(Math.abs(xScale.domain()[0]), halfSpanY) * 1.4;
    for (const zGuide of [0.5, 0.707]) {
      const angle = Math.acos(zGuide);
      const endRe = -rayRadius * Math.cos(angle);
      const endIm = rayRadius * Math.sin(angle);
      for (const sign of [1, -1]) {
        plotLayer
          .append('line')
          .attr('x1', xScale(0))
          .attr('y1', yScale(0))
          .attr('x2', xScale(endRe))
          .attr('y2', yScale(sign * endIm))
          .attr('stroke', '#1E293B')
          .attr('stroke-width', 1)
          .attr('stroke-dasharray', '3,4');
      }
    }

    // Real & jω axes
    plotLayer
      .append('line')
      .attr('x1', 0)
      .attr('x2', innerW)
      .attr('y1', yScale(0))
      .attr('y2', yScale(0))
      .attr('stroke', '#334155')
      .attr('stroke-width', 1.1);

    plotLayer
      .append('line')
      .attr('x1', xScale(0))
      .attr('x2', xScale(0))
      .attr('y1', 0)
      .attr('y2', innerH)
      .attr('stroke', '#475569')
      .attr('stroke-width', 1.3);

    // Render sensitivity-colored trajectory segments along each pole branch
    for (const branch of analysis.branches) {
      const pts = branch.points;
      if (pts.length < 2) continue;

      // Dark halo for legibility over grid lines
      const haloLine = d3
        .line<SensitivityTrajectoryPoint>()
        .x((d) => xScale(d.re))
        .y((d) => yScale(d.im));
      plotLayer
        .append('path')
        .datum(pts)
        .attr('d', haloLine)
        .attr('fill', 'none')
        .attr('stroke', '#07090E')
        .attr('stroke-width', 5)
        .attr('stroke-linecap', 'round')
        .attr('opacity', 0.65);

      // Colored gradient segments by local normalized sensitivity
      for (let i = 0; i < pts.length - 1; i++) {
        const p0 = pts[i];
        const p1 = pts[i + 1];
        const avgNorm = 0.5 * (p0.normSensitivity + p1.normSensitivity);
        const segColor = sensitivityColorInterpolator(avgNorm);
        plotLayer
          .append('line')
          .attr('x1', xScale(p0.re))
          .attr('y1', yScale(p0.im))
          .attr('x2', xScale(p1.re))
          .attr('y2', yScale(p1.im))
          .attr('stroke', segColor)
          .attr('stroke-width', 2.8)
          .attr('stroke-linecap', 'round');
      }

      // Endpoint glyphs: hollow circle at α_min, arrow at α_max when branch moves noticeably
      const firstPt = pts[0];
      const lastPt = pts[pts.length - 1];
      const pxSpan = Math.hypot(
        xScale(lastPt.re) - xScale(firstPt.re),
        yScale(lastPt.im) - yScale(firstPt.im)
      );

      if (pxSpan > 6) {
        plotLayer
          .append('circle')
          .attr('cx', xScale(firstPt.re))
          .attr('cy', yScale(firstPt.im))
          .attr('r', 3)
          .attr('fill', '#07090E')
          .attr('stroke', sensitivityColorInterpolator(firstPt.normSensitivity))
          .attr('stroke-width', 1.5);

        const prevEnd = pts[pts.length - 2];
        const endDx = xScale(lastPt.re) - xScale(prevEnd.re);
        const endDy = yScale(lastPt.im) - yScale(prevEnd.im);
        if (Math.hypot(endDx, endDy) > 0.5) {
          plotLayer
            .append('line')
            .attr('x1', xScale(prevEnd.re))
            .attr('y1', yScale(prevEnd.im))
            .attr('x2', xScale(lastPt.re))
            .attr('y2', yScale(lastPt.im))
            .attr('stroke', sensitivityColorInterpolator(lastPt.normSensitivity))
            .attr('stroke-width', 2.2)
            .attr('marker-end', 'url(#sens-arrow-head)');
        }
      }

      // Nominal pole marker (α = 1.0) — crisp white × cross
      const nom = branch.nominalPole;
      const nx = xScale(nom.re);
      const ny = yScale(nom.im);
      const rNom = 4.2;
      plotLayer
        .append('line')
        .attr('x1', nx - rNom)
        .attr('y1', ny - rNom)
        .attr('x2', nx + rNom)
        .attr('y2', ny + rNom)
        .attr('stroke', '#94A3B8')
        .attr('stroke-width', 1.6);
      plotLayer
        .append('line')
        .attr('x1', nx - rNom)
        .attr('y1', ny + rNom)
        .attr('x2', nx + rNom)
        .attr('y2', ny - rNom)
        .attr('stroke', '#94A3B8')
        .attr('stroke-width', 1.6);

      // Stability boundary crossing ring if Re(s)=0 is crossed
      if (branch.criticalFactor !== null) {
        // Estimate Im at crossing via closest point
        const crossPt = pts.reduce((best, pt) =>
          Math.abs(pt.re) < Math.abs(best.re) ? pt : best
        );
        plotLayer
          .append('circle')
          .attr('cx', xScale(0))
          .attr('cy', yScale(crossPt.im))
          .attr('r', 5)
          .attr('fill', 'rgba(244, 63, 94, 0.25)')
          .attr('stroke', '#FB7185')
          .attr('stroke-width', 1.6);
      }
    }

    // Active α parameter pole markers (highlighted halo + inner core)
    for (const ap of analysis.activePoles) {
      const cx = xScale(ap.re);
      const cy = yScale(ap.im);
      const col = sensitivityColorInterpolator(ap.normSensitivity);

      plotLayer
        .append('circle')
        .attr('cx', cx)
        .attr('cy', cy)
        .attr('r', 7.5)
        .attr('fill', 'none')
        .attr('stroke', ap.stable ? '#F8FAFC' : '#FB7185')
        .attr('stroke-width', 1.6)
        .attr('opacity', 0.9);

      plotLayer
        .append('circle')
        .attr('cx', cx)
        .attr('cy', cy)
        .attr('r', 3.8)
        .attr('fill', col)
        .attr('stroke', '#07090E')
        .attr('stroke-width', 1.2);
    }

    // Hovered trajectory probe indicator
    if (hoverPoint) {
      const hx = xScale(hoverPoint.point.re);
      const hy = yScale(hoverPoint.point.im);
      plotLayer
        .append('circle')
        .attr('cx', hx)
        .attr('cy', hy)
        .attr('r', 6)
        .attr('fill', 'rgba(248, 250, 252, 0.16)')
        .attr('stroke', '#F8FAFC')
        .attr('stroke-width', 1.5);
    }

    // Axes chrome
    const xAxis = d3.axisBottom(xScale).ticks(7);
    const yAxis = d3.axisLeft(yScale).ticks(6);

    g.append('g')
      .attr('transform', `translate(0,${innerH})`)
      .call(xAxis)
      .call((ax) => ax.selectAll('path,line').attr('stroke', '#334155'))
      .call((ax) =>
        ax
          .selectAll('text')
          .attr('fill', '#94A3B8')
          .attr('font-size', 10)
          .attr('font-family', 'JetBrains Mono, monospace')
      );

    g.append('g')
      .call(yAxis)
      .call((ax) => ax.selectAll('path,line').attr('stroke', '#334155'))
      .call((ax) =>
        ax
          .selectAll('text')
          .attr('fill', '#94A3B8')
          .attr('font-size', 10)
          .attr('font-family', 'JetBrains Mono, monospace')
      );

    g.append('text')
      .attr('x', innerW / 2)
      .attr('y', innerH + 28)
      .attr('text-anchor', 'middle')
      .attr('fill', '#64748B')
      .attr('font-size', 10)
      .attr('font-family', 'JetBrains Mono, monospace')
      .text('Real Axis σ = Re(s) [rad/s]');

    g.append('text')
      .attr('transform', 'rotate(-90)')
      .attr('x', -innerH / 2)
      .attr('y', -40)
      .attr('text-anchor', 'middle')
      .attr('fill', '#64748B')
      .attr('font-size', 10)
      .attr('font-family', 'JetBrains Mono, monospace')
      .text('Imag Axis jω [rad/s]');

    // Transparent pointer probe overlay for inspecting nearest trajectory sample
    plotLayer
      .append('rect')
      .attr('x', 0)
      .attr('y', 0)
      .attr('width', innerW)
      .attr('height', innerH)
      .attr('fill', 'transparent')
      .style('cursor', 'crosshair')
      .on('mousemove', (event: MouseEvent) => {
        const [mx, my] = d3.pointer(event);
        let bestDist = Infinity;
        let bestMatch: {
          branchId: number;
          point: SensitivityTrajectoryPoint;
        } | null = null;

        for (const b of analysis.branches) {
          for (const pt of b.points) {
            const dx = xScale(pt.re) - mx;
            const dy = yScale(pt.im) - my;
            const d = Math.hypot(dx, dy);
            if (d < bestDist) {
              bestDist = d;
              bestMatch = { branchId: b.id, point: pt };
            }
          }
        }
    setHoverPoint(bestDist <= 28 ? bestMatch : null);
      })
      .on('mouseleave', () => setHoverPoint(null));
  }, [analysis, hoverPoint]);

  return (
    <div className="bg-[#07090E] border-t border-slate-800">
      {/* Header & Controls */}
      <div className="px-5 py-3 bg-[#0B0E17] border-b border-slate-800 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h4 className="text-xs font-semibold text-slate-200 uppercase tracking-wider">
              S-Domain Parameter Sensitivity Map
            </h4>
            <p className="text-[11px] font-mono text-slate-400 mt-0.5">
              {analysis.parameter.name} ({analysis.parameter.symbol} ={' '}
              {analysis.parameter.nominalDisplay}) · Logarithmic eigenvalue sensitivity
              |dλ / d(ln {analysis.parameter.symbol})|
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {/* Open vs Closed Loop Scope */}
            <div className="flex items-center gap-0.5 p-0.5 bg-[#07090E] border border-slate-800 rounded">
              {(
                [
                  { id: 'closed', label: 'Closed-Loop' },
                  { id: 'open', label: 'Open-Loop' },
                ] as const
              ).map((s) => (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => setScope(s.id)}
                  className={`px-2 py-1 text-[11px] font-mono rounded transition-colors cursor-pointer whitespace-nowrap shrink-0 ${
                    scope === s.id
                      ? 'bg-slate-800 text-cyan-300'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  {s.label}
                </button>
              ))}
            </div>

            {/* Sweep Range Presets */}
            <div className="flex items-center gap-0.5 p-0.5 bg-[#07090E] border border-slate-800 rounded">
              {SWEEP_PRESETS.map((r) => (
                <button
                  key={r.id}
                  type="button"
                  onClick={() => setRangeId(r.id)}
                  className={`px-2 py-1 text-[11px] font-mono rounded transition-colors cursor-pointer whitespace-nowrap shrink-0 ${
                    rangeId === r.id
                      ? 'bg-slate-800 text-cyan-300'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  {r.label}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Parameter Selector + Interactive Multiplier Slider */}
        <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_320px] gap-3 items-center">
          <div className="flex flex-wrap items-center gap-1.5">
            {parameters.map((param) => {
              const isSelected = param.id === analysis.parameter.id;
              return (
                <button
                  key={param.id}
                  type="button"
                  onClick={() => setSelectedParamId(param.id)}
                  title={param.description}
                  className={`px-2.5 py-1 text-[11px] font-mono rounded border transition-colors cursor-pointer whitespace-nowrap shrink-0 ${
                    isSelected
                      ? 'border-cyan-500/60 bg-cyan-500/15 text-cyan-200'
                      : 'border-slate-800 bg-[#07090E] hover:border-slate-700 text-slate-400 hover:text-slate-200'
                  }`}
                >
                  <span className="text-slate-300 font-semibold">{param.symbol}</span>
                  <span className="text-slate-500 mx-1">·</span>
                  <span>{param.name}</span>
                </button>
              );
            })}
          </div>

          <div className="flex items-center gap-2.5 px-3 py-1.5 rounded border border-slate-800 bg-[#07090E]">
            <label
              htmlFor="sensitivity-alpha-slider"
              className="text-[11px] font-mono text-slate-400 whitespace-nowrap"
            >
              α · {analysis.parameter.symbol}:
            </label>
            <input
              id="sensitivity-alpha-slider"
              type="range"
              min={activeRange.min}
              max={activeRange.max}
              step={0.01}
              value={activeFactor}
              onChange={(e) => setActiveFactor(Number(e.target.value))}
              className="flex-1 accent-cyan-400 cursor-pointer"
            />
            <span className="text-[11px] font-mono tabular-nums text-cyan-300 w-12 text-right">
              {activeFactor.toFixed(2)}×
            </span>
            <button
              type="button"
              onClick={() => setActiveFactor(1.0)}
              className="px-2 py-0.5 text-[10px] font-mono rounded border border-slate-700 bg-slate-800 hover:bg-slate-700 text-slate-200 cursor-pointer whitespace-nowrap shrink-0"
            >
              1.0×
            </button>
          </div>
        </div>

        {/* Summary Readout Strip & Gradient Color Scale */}
        <div className="flex flex-wrap items-center justify-between gap-3 pt-1 text-[11px] font-mono tabular-nums">
          <div className="flex flex-wrap items-center gap-4 text-slate-400">
            <span>
              Verdict at {activeFactor.toFixed(2)}×:{' '}
              <span
                className={
                  analysis.activeStable ? 'text-emerald-400' : 'text-rose-400'
                }
              >
                {analysis.activeStable ? 'STABLE (LHP)' : 'UNSTABLE (RHP)'}
              </span>
            </span>
            <span>
              Peak |S_p|:{' '}
              <span className="text-amber-300">
                {formatNum(analysis.maxSensitivity, 2)} rad/s
              </span>
            </span>
            <span>
              Stable Span:{' '}
              <span className="text-slate-200">
                {analysis.stableFactorRange.min !== null &&
                analysis.stableFactorRange.max !== null
                  ? `${analysis.stableFactorRange.min.toFixed(2)}× – ${analysis.stableFactorRange.max.toFixed(2)}×`
                  : 'None in sweep'}
              </span>
            </span>
          </div>

          <div className="flex items-center gap-2">
            <span className="text-[10px] text-cyan-300">Low |S_p|</span>
            <svg
              viewBox="0 0 112 8"
              className="w-28 h-2 rounded-sm border border-slate-700 block"
              aria-label="Sensitivity color scale from low cyan to high rose"
            >
              <defs>
                <linearGradient id="sens-legend-ramp" x1="0%" y1="0%" x2="100%" y2="0%">
                  <stop offset="0%" stopColor="#06B6D4" />
                  <stop offset="35%" stopColor="#10B981" />
                  <stop offset="70%" stopColor="#F59E0B" />
                  <stop offset="100%" stopColor="#F43F5E" />
                </linearGradient>
              </defs>
              <rect x="0" y="0" width="112" height="8" fill="url(#sens-legend-ramp)" />
            </svg>
            <span className="text-[10px] text-rose-400">
              High ({formatNum(analysis.maxSensitivity, 1)})
            </span>
          </div>
        </div>
      </div>

      {/* Main D3 S-Plane Trajectory Plot */}
      <div className="relative px-3 pt-2 pb-1">
        <svg
          ref={svgRef}
          viewBox="0 0 760 320"
          className="w-full h-auto block select-none"
          role="img"
          aria-label={`S-Domain Pole Sensitivity Plot for ${analysis.parameter.name}`}
        />

        {/* Hover Inspector Strip */}
        <div className="px-2 py-1.5 flex flex-wrap items-center justify-between gap-2 text-[11px] font-mono tabular-nums border-t border-slate-800/80 text-slate-400">
          {hoverPoint ? (
            <div className="flex flex-wrap items-center gap-4 text-slate-200">
              <span className="text-cyan-300">
                Branch λ{hoverPoint.branchId + 1} @ α={hoverPoint.point.factor.toFixed(2)}×
              </span>
              <span>s = {formatComplex(hoverPoint.point.re, hoverPoint.point.im)}</span>
              <span className="text-amber-300">
                |S_p| = {formatNum(hoverPoint.point.sensitivity, 2)} rad/s
              </span>
              <span>
                ζ ={' '}
                {hoverPoint.point.dampingRatio !== null
                  ? hoverPoint.point.dampingRatio.toFixed(3)
                  : '—'}
              </span>
              <span>ω_n = {formatNum(hoverPoint.point.naturalFreqRad, 2)} rad/s</span>
            </div>
          ) : (
            <span>
              Hover trajectory to inspect local pole coordinates &amp; sensitivity ·{' '}
              <span className="text-slate-300">×</span> Nominal (1.0×) ·{' '}
              <span className="text-slate-200">○</span> α={activeFactor.toFixed(2)}×
            </span>
          )}
          <span className="text-slate-500">{analysis.parameter.description}</span>
        </div>
      </div>

      {/* Branch Sensitivity Quantitative Breakdown Table */}
      <div className="px-5 py-3 border-t border-slate-800 bg-[#0B0E17]/70 overflow-x-auto">
        <table className="w-full text-left border-collapse text-[11px] font-mono tabular-nums">
          <thead>
            <tr className="text-slate-500 border-b border-slate-800">
              <th className="py-1.5 pr-3 font-medium">Pole Branch</th>
              <th className="py-1.5 px-3 font-medium">Nominal (α = 1.0×)</th>
              <th className="py-1.5 px-3 font-medium">
                Active (α = {activeFactor.toFixed(2)}×)
              </th>
              <th className="py-1.5 px-3 font-medium">Peak |S_p|</th>
              <th className="py-1.5 px-3 font-medium">ΔRe / ΔIm Span</th>
              <th className="py-1.5 pl-3 font-medium text-right">RHP Crossing</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800/60">
            {analysis.branches.map((branch, idx) => {
              const ap = analysis.activePoles[idx];
              const peakNorm =
                analysis.maxSensitivity > 1e-6
                  ? Math.min(1, branch.peakSensitivity / analysis.maxSensitivity)
                  : 0;
              return (
                <tr key={branch.id} className="hover:bg-slate-900/40">
                  <td className="py-1.5 pr-3 text-slate-200 flex items-center gap-2">
                    <svg viewBox="0 0 10 10" className="w-2.5 h-2.5 shrink-0">
                      <circle
                        cx="5"
                        cy="5"
                        r="5"
                        fill={sensitivityColorInterpolator(peakNorm)}
                      />
                    </svg>
                    λ{branch.id + 1}
                  </td>
                  <td className="py-1.5 px-3 text-slate-400">
                    {formatComplex(branch.nominalPole.re, branch.nominalPole.im)}
                  </td>
                  <td
                    className={`py-1.5 px-3 ${
                      ap?.stable ? 'text-slate-100' : 'text-rose-400'
                    }`}
                  >
                    {ap ? formatComplex(ap.re, ap.im) : '—'}
                  </td>
                  <td className="py-1.5 px-3 text-amber-300">
                    {formatNum(branch.peakSensitivity, 2)} rad/s
                  </td>
                  <td className="py-1.5 px-3 text-slate-400">
                    {formatNum(branch.realSpan, 2)} / {formatNum(branch.imagSpan, 2)}
                  </td>
                  <td className="py-1.5 pl-3 text-right">
                    {branch.criticalFactor !== null ? (
                      <span className="text-rose-300">
                        α ≈ {branch.criticalFactor.toFixed(2)}×
                      </span>
                    ) : (
                      <span className="text-slate-500">None</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
};
