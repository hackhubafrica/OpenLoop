import React, { useEffect, useMemo, useRef, useState } from 'react';
import * as d3 from 'd3';
import { ControlModel } from '../types/control';
import { BodePoint, computeBodeAnalysis } from '../engine/bode';

interface BodePlotProps {
  model: ControlModel;
}

export const BodePlot: React.FC<BodePlotProps> = ({ model }) => {
  const [inputIdx, setInputIdx] = useState<number>(0);
  const [outputIdx, setOutputIdx] = useState<number>(model.pid.targetOutputIndex);
  const [mode, setMode] = useState<'plant' | 'open_loop'>('open_loop');
  const [hoverPoint, setHoverPoint] = useState<BodePoint | null>(null);

  const magSvgRef = useRef<SVGSVGElement | null>(null);
  const phaseSvgRef = useRef<SVGSVGElement | null>(null);

  // Sync input/output index if dimensions change
  useEffect(() => {
    setInputIdx((prev) => Math.min(prev, Math.max(0, model.plant.m - 1)));
    setOutputIdx(Math.min(model.pid.targetOutputIndex, Math.max(0, model.plant.p - 1)));
  }, [model.id, model.pid.targetOutputIndex, model.plant.m, model.plant.p]);

  const analysis = useMemo(
    () => computeBodeAnalysis(model, outputIdx, mode, inputIdx),
    [model, outputIdx, mode, inputIdx]
  );

  // Render D3 Magnitude & Phase Bode Charts
  useEffect(() => {
    const points = analysis.points;
    if (points.length === 0) return;

    const width = 760;
    const magHeight = 165;
    const phaseHeight = 155;
    const margin = { top: 14, right: 20, bottom: 24, left: 54 };
    const innerW = width - margin.left - margin.right;
    const magInnerH = magHeight - margin.top - margin.bottom;
    const phaseInnerH = phaseHeight - margin.top - margin.bottom;

    const xScale = d3
      .scaleLog()
      .domain([analysis.omegaMin, analysis.omegaMax])
      .range([0, innerW]);

    const magExtent = d3.extent(points, (d) => d.magDb) as [number, number];
    const magPad = Math.max(6, (magExtent[1] - magExtent[0]) * 0.12);
    const yMagScale = d3
      .scaleLinear()
      .domain([Math.min(-10, magExtent[0] - magPad), Math.max(10, magExtent[1] + magPad)])
      .range([magInnerH, 0]);

    const phaseExtent = d3.extent(points, (d) => d.phaseDeg) as [number, number];
    const phaseMin = Math.min(-195, Math.floor((phaseExtent[0] - 15) / 45) * 45);
    const phaseMax = Math.max(15, Math.ceil((phaseExtent[1] + 15) / 45) * 45);
    const yPhaseScale = d3
      .scaleLinear()
      .domain([phaseMin, phaseMax])
      .range([phaseInnerH, 0]);

    const bisectOmega = d3.bisector<BodePoint, number>((d) => d.omega).left;

    // Helper to draw Magnitude SVG
    if (magSvgRef.current) {
      const svg = d3.select(magSvgRef.current);
      svg.selectAll('*').remove();

      const g = svg
        .append('g')
        .attr('transform', `translate(${margin.left},${margin.top})`);

      // Grid lines
      g.append('g')
        .attr('class', 'grid-x')
        .selectAll('line')
        .data(xScale.ticks(6))
        .join('line')
        .attr('x1', (d) => xScale(d))
        .attr('x2', (d) => xScale(d))
        .attr('y1', 0)
        .attr('y2', magInnerH)
        .attr('stroke', '#151D2B')
        .attr('stroke-width', 1);

      g.append('g')
        .attr('class', 'grid-y')
        .selectAll('line')
        .data(yMagScale.ticks(5))
        .join('line')
        .attr('x1', 0)
        .attr('x2', innerW)
        .attr('y1', (d) => yMagScale(d))
        .attr('y2', (d) => yMagScale(d))
        .attr('stroke', '#1E293B')
        .attr('stroke-width', 1);

      // 0 dB critical unity-gain threshold line
      const yZeroDb = yMagScale(0);
      g.append('line')
        .attr('x1', 0)
        .attr('x2', innerW)
        .attr('y1', yZeroDb)
        .attr('y2', yZeroDb)
        .attr('stroke', '#64748B')
        .attr('stroke-dasharray', '4 3')
        .attr('stroke-width', 1.2);

      g.append('text')
        .attr('x', innerW - 4)
        .attr('y', Math.max(10, yZeroDb - 4))
        .attr('text-anchor', 'end')
        .attr('fill', '#64748B')
        .attr('font-size', '9px')
        .attr('font-family', 'IBM Plex Mono, monospace')
        .text('0 dB Unity Gain');

      const { phaseCrossoverOmega, gainMarginDb, gainCrossoverOmega } = analysis.margins;

      // Cross-plot vertical guide lines for ω_gc and ω_pc
      if (gainCrossoverOmega !== null) {
        const xGc = xScale(gainCrossoverOmega);
        g.append('line')
          .attr('x1', xGc)
          .attr('x2', xGc)
          .attr('y1', 0)
          .attr('y2', magInnerH)
          .attr('stroke', '#F59E0B')
          .attr('stroke-opacity', 0.45)
          .attr('stroke-dasharray', '3 3')
          .attr('stroke-width', 1.2);
      }

      if (phaseCrossoverOmega !== null) {
        const xPc = xScale(phaseCrossoverOmega);
        g.append('line')
          .attr('x1', xPc)
          .attr('x2', xPc)
          .attr('y1', 0)
          .attr('y2', magInnerH)
          .attr('stroke', '#10B981')
          .attr('stroke-opacity', 0.4)
          .attr('stroke-dasharray', '3 3')
          .attr('stroke-width', 1.2);
      }

      // Magnitude curve
      const magLine = d3
        .line<BodePoint>()
        .x((d) => xScale(d.omega))
        .y((d) => yMagScale(d.magDb));

      g.append('path')
        .datum(points)
        .attr('fill', 'none')
        .attr('stroke', '#06B6D4')
        .attr('stroke-width', 2)
        .attr('d', magLine);

      // Gain Margin span bar & marker at phase crossover ω_pc
      if (phaseCrossoverOmega !== null && gainMarginDb !== null) {
        const xPc = xScale(phaseCrossoverOmega);
        const yAtPc = yMagScale(-gainMarginDb);
        const gmColor = gainMarginDb >= 0 ? '#10B981' : '#F43F5E';

        g.append('line')
          .attr('x1', xPc)
          .attr('x2', xPc)
          .attr('y1', yZeroDb)
          .attr('y2', yAtPc)
          .attr('stroke', gmColor)
          .attr('stroke-width', 2.5);

        // End caps for GM span
        g.append('line')
          .attr('x1', xPc - 4)
          .attr('x2', xPc + 4)
          .attr('y1', yZeroDb)
          .attr('y2', yZeroDb)
          .attr('stroke', gmColor)
          .attr('stroke-width', 1.5);
        g.append('line')
          .attr('x1', xPc - 4)
          .attr('x2', xPc + 4)
          .attr('y1', yAtPc)
          .attr('y2', yAtPc)
          .attr('stroke', gmColor)
          .attr('stroke-width', 1.5);

        g.append('circle')
          .attr('cx', xPc)
          .attr('cy', yAtPc)
          .attr('r', 4)
          .attr('fill', gmColor)
          .attr('stroke', '#07090E')
          .attr('stroke-width', 1.2);

        g.append('text')
          .attr('x', xPc > innerW - 115 ? xPc - 8 : xPc + 7)
          .attr('y', (yZeroDb + yAtPc) / 2 + 3)
          .attr('text-anchor', xPc > innerW - 115 ? 'end' : 'start')
          .attr('fill', gmColor)
          .attr('font-size', '10px')
          .attr('font-weight', '600')
          .attr('font-family', 'IBM Plex Mono, monospace')
          .text(`GM ${gainMarginDb.toFixed(1)} dB`);
      }

      // Highlight Gain Crossover ω_gc on 0 dB line
      if (gainCrossoverOmega !== null) {
        const xGc = xScale(gainCrossoverOmega);
        g.append('circle')
          .attr('cx', xGc)
          .attr('cy', yZeroDb)
          .attr('r', 7)
          .attr('fill', '#F59E0B')
          .attr('fill-opacity', 0.2);

        g.append('circle')
          .attr('cx', xGc)
          .attr('cy', yZeroDb)
          .attr('r', 4)
          .attr('fill', '#F59E0B')
          .attr('stroke', '#07090E')
          .attr('stroke-width', 1.2);

        g.append('text')
          .attr('x', xGc > innerW - 120 ? xGc - 8 : xGc + 8)
          .attr('y', Math.max(12, yZeroDb - 8))
          .attr('text-anchor', xGc > innerW - 120 ? 'end' : 'start')
          .attr('fill', '#FCD34D')
          .attr('font-size', '9.5px')
          .attr('font-family', 'IBM Plex Mono, monospace')
          .text(`ω_gc ${gainCrossoverOmega.toFixed(1)}`);
      }

      // Axes
      const xAxis = d3
        .axisBottom(xScale)
        .ticks(6, '.0e')
        .tickSizeOuter(0);
      const yAxis = d3.axisLeft(yMagScale).ticks(5).tickSizeOuter(0);

      g.append('g')
        .attr('transform', `translate(0,${magInnerH})`)
        .call(xAxis)
        .call((ax) => ax.selectAll('path, line').attr('stroke', '#334155'))
        .call((ax) =>
          ax
            .selectAll('text')
            .attr('fill', '#64748B')
            .attr('font-size', '9.5px')
            .attr('font-family', 'IBM Plex Mono, monospace')
        );

      g.append('g')
        .call(yAxis)
        .call((ax) => ax.selectAll('path, line').attr('stroke', '#334155'))
        .call((ax) =>
          ax
            .selectAll('text')
            .attr('fill', '#94A3B8')
            .attr('font-size', '9.5px')
            .attr('font-family', 'IBM Plex Mono, monospace')
        );

      // Axis label
      g.append('text')
        .attr('x', 6)
        .attr('y', 10)
        .attr('fill', '#94A3B8')
        .attr('font-size', '10px')
        .attr('font-family', 'IBM Plex Mono, monospace')
        .text('Magnitude (dB)');

      // Interactive hover cursor elements
      const cursorLine = g
        .append('line')
        .attr('y1', 0)
        .attr('y2', magInnerH)
        .attr('stroke', '#94A3B8')
        .attr('stroke-opacity', 0.65)
        .attr('stroke-width', 1)
        .style('display', 'none');

      const cursorDot = g
        .append('circle')
        .attr('r', 3.5)
        .attr('fill', '#06B6D4')
        .attr('stroke', '#07090E')
        .attr('stroke-width', 1.5)
        .style('display', 'none');

      if (hoverPoint) {
        const hx = xScale(hoverPoint.omega);
        const hy = yMagScale(hoverPoint.magDb);
        cursorLine.attr('x1', hx).attr('x2', hx).style('display', null);
        cursorDot.attr('cx', hx).attr('cy', hy).style('display', null);
      }

      // Pointer capture overlay
      g.append('rect')
        .attr('width', innerW)
        .attr('height', magInnerH)
        .attr('fill', 'transparent')
        .style('cursor', 'crosshair')
        .on('pointermove', (event: PointerEvent) => {
          const [mx] = d3.pointer(event);
          const w = xScale.invert(Math.max(0, Math.min(innerW, mx)));
          const idx = Math.min(points.length - 1, Math.max(0, bisectOmega(points, w)));
          setHoverPoint(points[idx]);
        })
        .on('pointerleave', () => setHoverPoint(null));
    }

    // Helper to draw Phase SVG
    if (phaseSvgRef.current) {
      const svg = d3.select(phaseSvgRef.current);
      svg.selectAll('*').remove();

      const g = svg
        .append('g')
        .attr('transform', `translate(${margin.left},${margin.top})`);

      g.append('g')
        .selectAll('line')
        .data(xScale.ticks(6))
        .join('line')
        .attr('x1', (d) => xScale(d))
        .attr('x2', (d) => xScale(d))
        .attr('y1', 0)
        .attr('y2', phaseInnerH)
        .attr('stroke', '#151D2B')
        .attr('stroke-width', 1);

      g.append('g')
        .selectAll('line')
        .data(yPhaseScale.ticks(5))
        .join('line')
        .attr('x1', 0)
        .attr('x2', innerW)
        .attr('y1', (d) => yPhaseScale(d))
        .attr('y2', (d) => yPhaseScale(d))
        .attr('stroke', '#1E293B')
        .attr('stroke-width', 1);

      // Stability limit region shading below -180 deg
      const yCritPhase = yPhaseScale(-180);
      if (yCritPhase < phaseInnerH) {
        g.append('rect')
          .attr('x', 0)
          .attr('y', Math.max(0, yCritPhase))
          .attr('width', innerW)
          .attr('height', Math.max(0, phaseInnerH - Math.max(0, yCritPhase)))
          .attr('fill', '#F43F5E')
          .attr('fill-opacity', 0.06);
      }

      // -180 deg stability threshold line
      g.append('line')
        .attr('x1', 0)
        .attr('x2', innerW)
        .attr('y1', yCritPhase)
        .attr('y2', yCritPhase)
        .attr('stroke', '#F43F5E')
        .attr('stroke-opacity', 0.65)
        .attr('stroke-dasharray', '4 3')
        .attr('stroke-width', 1.2);

      g.append('text')
        .attr('x', innerW - 4)
        .attr('y', Math.max(10, yCritPhase - 4))
        .attr('text-anchor', 'end')
        .attr('fill', '#FDA4AF')
        .attr('font-size', '9px')
        .attr('font-family', 'IBM Plex Mono, monospace')
        .text('Stability Limit (-180°)');

      const { gainCrossoverOmega, phaseMarginDeg, phaseCrossoverOmega } = analysis.margins;

      // Cross-plot vertical guide lines on Phase plot
      if (gainCrossoverOmega !== null) {
        const xGc = xScale(gainCrossoverOmega);
        g.append('line')
          .attr('x1', xGc)
          .attr('x2', xGc)
          .attr('y1', 0)
          .attr('y2', phaseInnerH)
          .attr('stroke', '#F59E0B')
          .attr('stroke-opacity', 0.45)
          .attr('stroke-dasharray', '3 3')
          .attr('stroke-width', 1.2);
      }

      if (phaseCrossoverOmega !== null) {
        const xPc = xScale(phaseCrossoverOmega);
        g.append('line')
          .attr('x1', xPc)
          .attr('x2', xPc)
          .attr('y1', 0)
          .attr('y2', phaseInnerH)
          .attr('stroke', '#10B981')
          .attr('stroke-opacity', 0.4)
          .attr('stroke-dasharray', '3 3')
          .attr('stroke-width', 1.2);
      }

      // Phase curve
      const phaseLine = d3
        .line<BodePoint>()
        .x((d) => xScale(d.omega))
        .y((d) => yPhaseScale(d.phaseDeg));

      g.append('path')
        .datum(points)
        .attr('fill', 'none')
        .attr('stroke', '#F59E0B')
        .attr('stroke-width', 2)
        .attr('d', phaseLine);

      // Phase Margin span bar & marker at gain crossover ω_gc
      if (gainCrossoverOmega !== null && phaseMarginDeg !== null) {
        const xGc = xScale(gainCrossoverOmega);
        const yAtGc = yPhaseScale(-180 + phaseMarginDeg);
        const pmColor = phaseMarginDeg >= 0 ? '#10B981' : '#F43F5E';

        g.append('line')
          .attr('x1', xGc)
          .attr('x2', xGc)
          .attr('y1', yCritPhase)
          .attr('y2', yAtGc)
          .attr('stroke', pmColor)
          .attr('stroke-width', 2.5);

        // End caps for PM span
        g.append('line')
          .attr('x1', xGc - 4)
          .attr('x2', xGc + 4)
          .attr('y1', yCritPhase)
          .attr('y2', yCritPhase)
          .attr('stroke', pmColor)
          .attr('stroke-width', 1.5);
        g.append('line')
          .attr('x1', xGc - 4)
          .attr('x2', xGc + 4)
          .attr('y1', yAtGc)
          .attr('y2', yAtGc)
          .attr('stroke', pmColor)
          .attr('stroke-width', 1.5);

        g.append('circle')
          .attr('cx', xGc)
          .attr('cy', yAtGc)
          .attr('r', 4)
          .attr('fill', pmColor)
          .attr('stroke', '#07090E')
          .attr('stroke-width', 1.2);

        g.append('text')
          .attr('x', xGc > innerW - 110 ? xGc - 8 : xGc + 7)
          .attr('y', (yCritPhase + yAtGc) / 2 + 3)
          .attr('text-anchor', xGc > innerW - 110 ? 'end' : 'start')
          .attr('fill', pmColor)
          .attr('font-size', '10px')
          .attr('font-weight', '600')
          .attr('font-family', 'IBM Plex Mono, monospace')
          .text(`PM ${phaseMarginDeg.toFixed(1)}°`);
      }

      // Highlight Phase Crossover ω_pc on -180 deg threshold
      if (phaseCrossoverOmega !== null) {
        const xPc = xScale(phaseCrossoverOmega);
        g.append('circle')
          .attr('cx', xPc)
          .attr('cy', yCritPhase)
          .attr('r', 7)
          .attr('fill', '#10B981')
          .attr('fill-opacity', 0.2);

        g.append('circle')
          .attr('cx', xPc)
          .attr('cy', yCritPhase)
          .attr('r', 4)
          .attr('fill', '#10B981')
          .attr('stroke', '#07090E')
          .attr('stroke-width', 1.2);

        g.append('text')
          .attr('x', xPc > innerW - 120 ? xPc - 8 : xPc + 8)
          .attr('y', Math.max(12, yCritPhase - 8))
          .attr('text-anchor', xPc > innerW - 120 ? 'end' : 'start')
          .attr('fill', '#6EE7B7')
          .attr('font-size', '9.5px')
          .attr('font-family', 'IBM Plex Mono, monospace')
          .text(`ω_pc ${phaseCrossoverOmega.toFixed(1)}`);
      }

      const xAxis = d3
        .axisBottom(xScale)
        .ticks(6, '.0e')
        .tickSizeOuter(0);
      const yAxis = d3.axisLeft(yPhaseScale).ticks(5).tickSizeOuter(0);

      g.append('g')
        .attr('transform', `translate(0,${phaseInnerH})`)
        .call(xAxis)
        .call((ax) => ax.selectAll('path, line').attr('stroke', '#334155'))
        .call((ax) =>
          ax
            .selectAll('text')
            .attr('fill', '#64748B')
            .attr('font-size', '9.5px')
            .attr('font-family', 'IBM Plex Mono, monospace')
        );

      g.append('g')
        .call(yAxis)
        .call((ax) => ax.selectAll('path, line').attr('stroke', '#334155'))
        .call((ax) =>
          ax
            .selectAll('text')
            .attr('fill', '#94A3B8')
            .attr('font-size', '9.5px')
            .attr('font-family', 'IBM Plex Mono, monospace')
        );

      g.append('text')
        .attr('x', 6)
        .attr('y', 10)
        .attr('fill', '#94A3B8')
        .attr('font-size', '10px')
        .attr('font-family', 'IBM Plex Mono, monospace')
        .text('Phase (deg) · ω (rad/s)');

      if (hoverPoint) {
        const hx = xScale(hoverPoint.omega);
        const hy = yPhaseScale(hoverPoint.phaseDeg);
        g.append('line')
          .attr('x1', hx)
          .attr('x2', hx)
          .attr('y1', 0)
          .attr('y2', phaseInnerH)
          .attr('stroke', '#94A3B8')
          .attr('stroke-opacity', 0.65)
          .attr('stroke-width', 1);

        g.append('circle')
          .attr('cx', hx)
          .attr('cy', hy)
          .attr('r', 3.5)
          .attr('fill', '#F59E0B')
          .attr('stroke', '#07090E')
          .attr('stroke-width', 1.5);
      }

      g.append('rect')
        .attr('width', innerW)
        .attr('height', phaseInnerH)
        .attr('fill', 'transparent')
        .style('cursor', 'crosshair')
        .on('pointermove', (event: PointerEvent) => {
          const [mx] = d3.pointer(event);
          const w = xScale.invert(Math.max(0, Math.min(innerW, mx)));
          const idx = Math.min(points.length - 1, Math.max(0, bisectOmega(points, w)));
          setHoverPoint(points[idx]);
        })
        .on('pointerleave', () => setHoverPoint(null));
    }
  }, [analysis, hoverPoint]);

  const { margins } = analysis;

  return (
    <div className="flex flex-col bg-[#07090E] border-t border-slate-800">
      {/* Bode Toolbar & Margin Readouts */}
      <div className="px-5 py-2.5 border-b border-slate-800 bg-[#0F141E] flex flex-wrap items-center justify-between gap-4">
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-xs font-semibold text-slate-200">
            Bode Frequency Response (D3.js)
          </span>

          {/* Plant G(jw) vs Open-Loop L(jw) selector */}
          <div className="flex items-center gap-1 p-0.5 bg-[#07090E] border border-slate-800 rounded">
            <button
              type="button"
              onClick={() => setMode('open_loop')}
              className={`px-2.5 py-1 text-[11px] font-mono rounded transition-colors cursor-pointer whitespace-nowrap ${
                mode === 'open_loop'
                  ? 'bg-slate-800 text-cyan-300'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              Open-Loop L(jω)
            </button>
            <button
              type="button"
              onClick={() => setMode('plant')}
              className={`px-2.5 py-1 text-[11px] font-mono rounded transition-colors cursor-pointer whitespace-nowrap ${
                mode === 'plant'
                  ? 'bg-slate-800 text-cyan-300'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              Plant G(jω)
            </button>
          </div>

          {/* Input & Output channel selectors */}
          {model.plant.m > 1 && (
            <select
              aria-label="Select Bode input channel"
              value={inputIdx}
              onChange={(e) => setInputIdx(Number(e.target.value))}
              className="bg-[#07090E] border border-slate-700 text-amber-200 text-[11px] font-mono rounded px-2 py-1 focus:outline-none focus:border-cyan-400 cursor-pointer"
            >
              {model.plant.inputNames.map((name, idx) => (
                <option key={idx} value={idx}>
                  u[{idx}]: {name}
                </option>
              ))}
            </select>
          )}
          {model.plant.p > 1 && (
            <select
              aria-label="Select Bode output channel"
              value={outputIdx}
              onChange={(e) => setOutputIdx(Number(e.target.value))}
              className="bg-[#07090E] border border-slate-700 text-slate-200 text-[11px] font-mono rounded px-2 py-1 focus:outline-none focus:border-cyan-400 cursor-pointer"
            >
              {model.plant.outputNames.map((name, idx) => (
                <option key={idx} value={idx}>
                  y[{idx}]: {name}
                </option>
              ))}
            </select>
          )}
        </div>

        {/* Margin Summary, Crossover Frequencies & Crosshair Readout */}
        <div className="flex flex-wrap items-center gap-4 text-xs font-mono tabular-nums">
          <span>
            <span className="text-slate-500">PM:</span>{' '}
            <span
              className={
                margins.phaseMarginDeg === null
                  ? 'text-slate-300'
                  : margins.phaseMarginDeg >= 0
                  ? 'text-emerald-400'
                  : 'text-rose-400'
              }
            >
              {margins.phaseMarginDeg !== null
                ? `${margins.phaseMarginDeg.toFixed(1)}°`
                : '—'}
            </span>
            {margins.gainCrossoverOmega !== null && (
              <span className="text-amber-300/90 ml-1">
                (@{margins.gainCrossoverOmega.toFixed(1)})
              </span>
            )}
          </span>

          <span>
            <span className="text-slate-500">GM:</span>{' '}
            <span
              className={
                margins.gainMarginDb === null
                  ? 'text-slate-300'
                  : margins.gainMarginDb >= 0
                  ? 'text-emerald-400'
                  : 'text-rose-400'
              }
            >
              {margins.gainMarginDb !== null
                ? `${margins.gainMarginDb.toFixed(2)} dB`
                : '∞'}
            </span>
            {margins.phaseCrossoverOmega !== null && (
              <span className="text-emerald-300/90 ml-1">
                (@{margins.phaseCrossoverOmega.toFixed(1)})
              </span>
            )}
          </span>

          <span
            className={
              margins.closedLoopStableHint === 'MARGIN_POSITIVE'
                ? 'text-emerald-400'
                : margins.closedLoopStableHint === 'MARGIN_NEGATIVE'
                ? 'text-rose-400'
                : margins.closedLoopStableHint === 'OPEN_LOOP_UNSTABLE'
                ? 'text-amber-300'
                : 'text-slate-400'
            }
          >
            {margins.closedLoopStableHint === 'MARGIN_POSITIVE'
              ? '● Stable Margins'
              : margins.closedLoopStableHint === 'MARGIN_NEGATIVE'
              ? '✖ Negative Margin'
              : margins.closedLoopStableHint === 'OPEN_LOOP_UNSTABLE'
              ? '▲ Open-Loop Unstable'
              : '● No 0dB Cross'}
          </span>

          {hoverPoint && (
            <span className="text-[11px] text-slate-300 pl-3 border-l border-slate-800">
              ω={hoverPoint.omega.toFixed(2)} rad/s ({hoverPoint.hz.toFixed(2)} Hz) ·{' '}
              <span className="text-cyan-300">{hoverPoint.magDb.toFixed(2)} dB</span> ·{' '}
              <span className="text-amber-300">{hoverPoint.phaseDeg.toFixed(1)}°</span>
            </span>
          )}
        </div>
      </div>

      {/* Stacked D3 SVG Charts */}
      <div className="px-3 py-2 space-y-1">
        <svg
          ref={magSvgRef}
          viewBox="0 0 760 165"
          className="w-full h-[165px] select-none"
        />
        <svg
          ref={phaseSvgRef}
          viewBox="0 0 760 155"
          className="w-full h-[155px] select-none"
        />
      </div>
    </div>
  );
};
