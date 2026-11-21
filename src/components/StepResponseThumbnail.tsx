import React, { useEffect, useMemo, useRef, useState } from 'react';
import * as d3 from 'd3';
import { ControlModel } from '../types/control';
import {
  computeTransferFunctionStepResponse,
  StepResponsePoint,
} from '../engine/stability';

interface StepResponseThumbnailProps {
  model: ControlModel;
}

export const StepResponseThumbnail: React.FC<StepResponseThumbnailProps> = ({
  model,
}) => {
  const [stepMode, setStepMode] = useState<'open' | 'closed'>('open');
  const [hovered, setHovered] = useState<StepResponsePoint | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);

  const stepAnalysis = useMemo(
    () =>
      computeTransferFunctionStepResponse(
        model,
        stepMode,
        model.pid.targetOutputIndex,
        0
      ),
    [model, stepMode]
  );

  useEffect(() => {
    const svgEl = svgRef.current;
    if (!svgEl) return;

    const pts = stepAnalysis.points;
    const width = 280;
    const height = 152;
    const margin = { top: 12, right: 12, bottom: 22, left: 38 };
    const innerW = width - margin.left - margin.right;
    const innerH = height - margin.top - margin.bottom;

    const svg = d3.select(svgEl);
    svg.selectAll('*').remove();

    const g = svg
      .append('g')
      .attr('transform', `translate(${margin.left},${margin.top})`);

    const maxT = Math.max(1e-4, pts[pts.length - 1]?.t ?? stepAnalysis.horizonSec);
    const xScale = d3.scaleLinear().domain([0, maxT]).range([0, innerW]);

    const ys = pts.map((p) => p.y);
    if (stepAnalysis.dcSteadyState !== null) {
      ys.push(stepAnalysis.dcSteadyState);
    }
    const rawMin = Math.min(0, ...ys);
    const rawMax = Math.max(0.1, ...ys);
    const span = Math.max(1e-3, rawMax - rawMin);
    const yScale = d3
      .scaleLinear()
      .domain([rawMin - span * 0.08, rawMax + span * 0.14])
      .range([innerH, 0]);

    // Grid lines
    g.append('g')
      .selectAll('line')
      .data(yScale.ticks(4))
      .join('line')
      .attr('x1', 0)
      .attr('x2', innerW)
      .attr('y1', (d) => yScale(d))
      .attr('y2', (d) => yScale(d))
      .attr('stroke', '#1E293B')
      .attr('stroke-width', 1);

    // Zero baseline
    const yZero = yScale(0);
    g.append('line')
      .attr('x1', 0)
      .attr('x2', innerW)
      .attr('y1', yZero)
      .attr('y2', yZero)
      .attr('stroke', '#334155')
      .attr('stroke-width', 1);

    // Steady-state dashed reference
    if (stepAnalysis.dcSteadyState !== null) {
      const ySs = yScale(stepAnalysis.dcSteadyState);
      g.append('line')
        .attr('x1', 0)
        .attr('x2', innerW)
        .attr('y1', ySs)
        .attr('y2', ySs)
        .attr('stroke', '#F59E0B')
        .attr('stroke-opacity', 0.65)
        .attr('stroke-dasharray', '3 3')
        .attr('stroke-width', 1.1);
    }

    const strokeColor = stepAnalysis.divergent ? '#F43F5E' : '#06B6D4';

    // Area fill
    const areaGen = d3
      .area<StepResponsePoint>()
      .x((d) => xScale(d.t))
      .y0(yZero)
      .y1((d) => yScale(d.y));

    g.append('path')
      .datum(pts)
      .attr('fill', strokeColor)
      .attr('fill-opacity', 0.09)
      .attr('d', areaGen);

    // Response curve
    const lineGen = d3
      .line<StepResponsePoint>()
      .x((d) => xScale(d.t))
      .y((d) => yScale(d.y));

    g.append('path')
      .datum(pts)
      .attr('fill', 'none')
      .attr('stroke', strokeColor)
      .attr('stroke-width', 1.75)
      .attr('d', lineGen);

    // Axes ticks
    const xAxis = d3
      .axisBottom(xScale)
      .ticks(4)
      .tickFormat((d) => `${Number(d)}s`)
      .tickSizeOuter(0);
    const yAxis = d3.axisLeft(yScale).ticks(4).tickSizeOuter(0);

    g.append('g')
      .attr('transform', `translate(0,${innerH})`)
      .call(xAxis)
      .call((ax) => ax.selectAll('path, line').attr('stroke', '#334155'))
      .call((ax) =>
        ax
          .selectAll('text')
          .attr('fill', '#64748B')
          .attr('font-size', '8.5px')
          .attr('font-family', 'IBM Plex Mono, monospace')
      );

    g.append('g')
      .call(yAxis)
      .call((ax) => ax.selectAll('path, line').attr('stroke', '#334155'))
      .call((ax) =>
        ax
          .selectAll('text')
          .attr('fill', '#94A3B8')
          .attr('font-size', '8.5px')
          .attr('font-family', 'IBM Plex Mono, monospace')
      );

    // Lightweight hover crosshair overlay
    const hoverGroup = g.append('g').style('display', 'none');
    const hoverLine = hoverGroup
      .append('line')
      .attr('y1', 0)
      .attr('y2', innerH)
      .attr('stroke', '#64748B')
      .attr('stroke-dasharray', '2 2')
      .attr('stroke-width', 1);
    const hoverDot = hoverGroup
      .append('circle')
      .attr('r', 3.5)
      .attr('fill', strokeColor)
      .attr('stroke', '#07090E')
      .attr('stroke-width', 1.2);

    const bisectT = d3.bisector<StepResponsePoint, number>((d) => d.t).left;

    g.append('rect')
      .attr('width', innerW)
      .attr('height', innerH)
      .attr('fill', 'transparent')
      .style('cursor', 'crosshair')
      .on('pointermove', (event: PointerEvent) => {
        if (pts.length === 0) return;
        const [mx] = d3.pointer(event);
        const tVal = xScale.invert(mx);
        const idx = Math.min(pts.length - 1, Math.max(0, bisectT(pts, tVal)));
        const pt = pts[idx];
        hoverGroup.style('display', null);
        hoverLine.attr('x1', xScale(pt.t)).attr('x2', xScale(pt.t));
        hoverDot.attr('cx', xScale(pt.t)).attr('cy', yScale(pt.y));
        setHovered(pt);
      })
      .on('pointerleave', () => {
        hoverGroup.style('display', 'none');
        setHovered(null);
      });
  }, [stepAnalysis]);

  return (
    <div className="flex flex-col bg-[#07090E] h-full">
      {/* Header */}
      <div className="px-4 py-2.5 border-b border-slate-800 bg-[#0F141E] flex items-center justify-between gap-2">
        <div>
          <div className="text-xs font-semibold text-slate-200">
            Step Response y(t)
          </div>
          <div className="text-[10px] font-mono text-slate-400 tabular-nums">
            {hovered
              ? `t=${hovered.t.toFixed(3)}s · y=${hovered.y.toFixed(3)}`
              : `Horizon 0–${stepAnalysis.horizonSec}s`}
          </div>
        </div>
        <div className="flex items-center gap-0.5 p-0.5 bg-[#07090E] border border-slate-800 rounded shrink-0">
          {(
            [
              { id: 'open', label: 'G(s)' },
              { id: 'closed', label: 'Closed' },
            ] as const
          ).map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setStepMode(item.id)}
              className={`px-2 py-0.5 text-[10px] font-mono rounded transition-colors cursor-pointer ${
                stepMode === item.id
                  ? 'bg-slate-800 text-cyan-300'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>

      {/* Thumbnail SVG */}
      <div className="px-2 pt-2 pb-1">
        <svg
          ref={svgRef}
          viewBox="0 0 280 152"
          aria-label="Transfer function unit step response thumbnail"
          className="w-full h-[156px] select-none"
        />
      </div>

      {/* Compact Step Metrics */}
      <div className="px-3 pb-3 pt-1 mt-auto">
        <div className="grid grid-cols-3 gap-1.5 text-[10px] font-mono tabular-nums">
          <div className="p-2 rounded border border-slate-800 bg-[#0B0E17]">
            <div className="text-slate-500">y_ss</div>
            <div
              className={`font-semibold mt-0.5 ${
                stepAnalysis.divergent ? 'text-rose-400' : 'text-slate-100'
              }`}
            >
              {stepAnalysis.divergent
                ? 'Unstable'
                : stepAnalysis.dcSteadyState !== null
                ? stepAnalysis.dcSteadyState.toFixed(3)
                : stepAnalysis.finalValue.toFixed(2)}
            </div>
          </div>
          <div className="p-2 rounded border border-slate-800 bg-[#0B0E17]">
            <div className="text-slate-500">%OS</div>
            <div className="text-amber-300 font-semibold mt-0.5">
              {stepAnalysis.overshootPct !== null
                ? `${stepAnalysis.overshootPct.toFixed(1)}%`
                : '—'}
            </div>
          </div>
          <div className="p-2 rounded border border-slate-800 bg-[#0B0E17]">
            <div className="text-slate-500">t_settle</div>
            <div className="text-cyan-300 font-semibold mt-0.5">
              {stepAnalysis.settlingTimeSec !== null
                ? `${stepAnalysis.settlingTimeSec.toFixed(2)}s`
                : '—'}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
