import React, { useEffect, useMemo, useRef, useState } from 'react';
import * as d3 from 'd3';
import { ControlModel } from '../types/control';
import { NyquistPoint, computeNyquistAnalysis } from '../engine/bode';

interface NyquistPlotProps {
  model: ControlModel;
}

type ZoomScope = 'critical' | 'wide' | 'full';

export const NyquistPlot: React.FC<NyquistPlotProps> = ({ model }) => {
  const [inputIdx, setInputIdx] = useState<number>(0);
  const [outputIdx, setOutputIdx] = useState<number>(model.pid.targetOutputIndex);
  const [mode, setMode] = useState<'plant' | 'open_loop'>('open_loop');
  const [showMirror, setShowMirror] = useState<boolean>(true);
  const [zoomScope, setZoomScope] = useState<ZoomScope>('critical');
  const [hoverPoint, setHoverPoint] = useState<NyquistPoint | null>(null);

  const svgRef = useRef<SVGSVGElement | null>(null);

  useEffect(() => {
    setInputIdx((prev) => Math.min(prev, Math.max(0, model.plant.m - 1)));
    setOutputIdx(Math.min(model.pid.targetOutputIndex, Math.max(0, model.plant.p - 1)));
  }, [model.id, model.pid.targetOutputIndex, model.plant.m, model.plant.p]);

  const analysis = useMemo(
    () => computeNyquistAnalysis(model, outputIdx, mode, inputIdx),
    [model, outputIdx, mode, inputIdx]
  );

  useEffect(() => {
    const svgEl = svgRef.current;
    if (!svgEl || analysis.points.length === 0) return;

    const svg = d3.select(svgEl);
    svg.selectAll('*').remove();

    const width = 760;
    const height = 320;
    const margin = { top: 18, right: 24, bottom: 32, left: 54 };
    const innerW = width - margin.left - margin.right;
    const innerH = height - margin.top - margin.bottom;

    // Determine equal-aspect complex-plane bounds
    let halfSpanY = 1.65;
    let centerX = -0.35;
    const centerY = 0;

    if (zoomScope === 'critical') {
      // Include (-1,0), unit circle, and crossovers comfortably
      const extraRe = Math.max(
        1.5,
        Math.min(
          3.5,
          Math.abs(analysis.phaseCrossoverPoint?.re ?? 1) + 0.5
        )
      );
      halfSpanY = Math.max(1.55, extraRe * 0.65);
      centerX = -0.45;
    } else if (zoomScope === 'wide') {
      halfSpanY = 4.2;
      centerX = -0.8;
    } else {
      // Full finite locus clipped reasonably to avoid 1/s infinity blowing up scale
      const bounded = analysis.points.filter(
        (pt) => Math.hypot(pt.re, pt.im) <= 30
      );
      const ptsForBounds = bounded.length > 5 ? bounded : analysis.points;
      const reVals = [-1.4, 1.2, ...ptsForBounds.map((p) => p.re)];
      const imVals = [-1.2, 1.2, ...ptsForBounds.map((p) => p.im), ...ptsForBounds.map((p) => -p.im)];
      const minRe = Math.max(-30, Math.min(...reVals));
      const maxRe = Math.min(30, Math.max(...reVals));
      const maxIm = Math.min(24, Math.max(...imVals.map((v) => Math.abs(v))));
      centerX = (minRe + maxRe) / 2;
      const reqSpanX = (maxRe - minRe) * 0.58;
      halfSpanY = Math.max(1.6, maxIm * 1.15, (reqSpanX * innerH) / innerW);
    }

    const aspect = innerW / innerH;
    const halfSpanX = halfSpanY * aspect;

    const xScale = d3
      .scaleLinear()
      .domain([centerX - halfSpanX, centerX + halfSpanX])
      .range([0, innerW]);

    const yScale = d3
      .scaleLinear()
      .domain([centerY - halfSpanY, centerY + halfSpanY])
      .range([innerH, 0]);

    const pxPerUnit = innerW / (2 * halfSpanX);

    const defs = svg.append('defs');
    defs
      .append('clipPath')
      .attr('id', 'nyquist-plot-clip')
      .append('rect')
      .attr('x', 0)
      .attr('y', 0)
      .attr('width', innerW)
      .attr('height', innerH);

    defs
      .append('marker')
      .attr('id', 'nyquist-dir-arrow')
      .attr('viewBox', '0 0 10 10')
      .attr('refX', 7)
      .attr('refY', 5)
      .attr('markerWidth', 6)
      .attr('markerHeight', 6)
      .attr('orient', 'auto')
      .append('path')
      .attr('d', 'M 0 1 L 10 5 L 0 9 z')
      .attr('fill', '#22D3EE');

    const g = svg
      .append('g')
      .attr('transform', `translate(${margin.left},${margin.top})`);

    // Cartesian background grid
    g.append('g')
      .selectAll('line')
      .data(xScale.ticks(8))
      .join('line')
      .attr('x1', (d) => xScale(d))
      .attr('x2', (d) => xScale(d))
      .attr('y1', 0)
      .attr('y2', innerH)
      .attr('stroke', '#151D2B')
      .attr('stroke-width', 1);

    g.append('g')
      .selectAll('line')
      .data(yScale.ticks(6))
      .join('line')
      .attr('x1', 0)
      .attr('x2', innerW)
      .attr('y1', (d) => yScale(d))
      .attr('y2', (d) => yScale(d))
      .attr('stroke', '#151D2B')
      .attr('stroke-width', 1);

    const plotLayer = g
      .append('g')
      .attr('clip-path', 'url(#nyquist-plot-clip)');

    // Real and Imaginary Axes
    if (xScale.domain()[0] <= 0 && xScale.domain()[1] >= 0) {
      plotLayer
        .append('line')
        .attr('x1', xScale(0))
        .attr('x2', xScale(0))
        .attr('y1', 0)
        .attr('y2', innerH)
        .attr('stroke', '#334155')
        .attr('stroke-width', 1.1);
    }
    if (yScale.domain()[0] <= 0 && yScale.domain()[1] >= 0) {
      plotLayer
        .append('line')
        .attr('x1', 0)
        .attr('x2', innerW)
        .attr('y1', yScale(0))
        .attr('y2', yScale(0))
        .attr('stroke', '#334155')
        .attr('stroke-width', 1.1);
    }

    // Unit Circle |L(jw)| = 1
    const ox = xScale(0);
    const oy = yScale(0);
    plotLayer
      .append('circle')
      .attr('cx', ox)
      .attr('cy', oy)
      .attr('r', pxPerUnit)
      .attr('fill', 'none')
      .attr('stroke', '#475569')
      .attr('stroke-dasharray', '4 3')
      .attr('stroke-width', 1.2);

    plotLayer
      .append('text')
      .attr('x', ox + pxPerUnit * 0.72)
      .attr('y', oy - pxPerUnit * 0.72)
      .attr('fill', '#64748B')
      .attr('font-size', '9px')
      .attr('font-family', 'IBM Plex Mono, monospace')
      .text('|L| = 1');

    // Sensitivity Circle centered at (-1, 0) with radius d_min = 1/Ms
    const cxCrit = xScale(-1);
    const cyCrit = yScale(0);
    if (analysis.closestPoint && analysis.closestPoint.distance > 1e-4) {
      const rSens = analysis.closestPoint.distance * pxPerUnit;
      if (rSens < innerW * 1.4) {
        plotLayer
          .append('circle')
          .attr('cx', cxCrit)
          .attr('cy', cyCrit)
          .attr('r', rSens)
          .attr('fill', '#F43F5E')
          .attr('fill-opacity', 0.04)
          .attr('stroke', '#F43F5E')
          .attr('stroke-opacity', 0.35)
          .attr('stroke-dasharray', '2 3')
          .attr('stroke-width', 1);
      }
      plotLayer
        .append('line')
        .attr('x1', cxCrit)
        .attr('y1', cyCrit)
        .attr('x2', xScale(analysis.closestPoint.re))
        .attr('y2', yScale(analysis.closestPoint.im))
        .attr('stroke', '#FB7185')
        .attr('stroke-opacity', 0.65)
        .attr('stroke-dasharray', '2 2')
        .attr('stroke-width', 1.1);
    }

    const lineGen = d3
      .line<NyquistPoint>()
      .defined((d) => Number.isFinite(d.re) && Number.isFinite(d.im) && Math.hypot(d.re, d.im) < 500)
      .x((d) => xScale(d.re))
      .y((d) => yScale(d.im));

    // Mirror contour (omega < 0): conjugate L(-jw)
    if (showMirror) {
      const mirrorPoints = analysis.points.map((p) => ({ ...p, im: -p.im }));
      plotLayer
        .append('path')
        .datum(mirrorPoints)
        .attr('fill', 'none')
        .attr('stroke', '#818CF8')
        .attr('stroke-opacity', 0.45)
        .attr('stroke-dasharray', '4 3')
        .attr('stroke-width', 1.4)
        .attr('d', lineGen);
    }

    // Main positive-frequency locus (omega > 0)
    plotLayer
      .append('path')
      .datum(analysis.points)
      .attr('fill', 'none')
      .attr('stroke', '#06B6D4')
      .attr('stroke-width', 2.2)
      .attr('d', lineGen);

    // Directional arrowheads showing increasing omega
    const arrowIndices = [
      Math.floor(analysis.points.length * 0.25),
      Math.floor(analysis.points.length * 0.5),
      Math.floor(analysis.points.length * 0.72),
    ];
    for (const idx of arrowIndices) {
      const p0 = analysis.points[idx];
      const p1 = analysis.points[idx + 1];
      if (!p0 || !p1) continue;
      if (Math.hypot(p0.re, p0.im) > 200 || Math.hypot(p1.re, p1.im) > 200) continue;
      const sx0 = xScale(p0.re);
      const sy0 = yScale(p0.im);
      const sx1 = xScale(p1.re);
      const sy1 = yScale(p1.im);
      if (Math.hypot(sx1 - sx0, sy1 - sy0) < 0.5) continue;
      plotLayer
        .append('line')
        .attr('x1', sx0)
        .attr('y1', sy0)
        .attr('x2', sx1)
        .attr('y2', sy1)
        .attr('stroke', 'transparent')
        .attr('marker-end', 'url(#nyquist-dir-arrow)');
    }

    // Phase Margin visualization on unit circle
    const gcPt = analysis.gainCrossoverPoint;
    if (gcPt && analysis.margins.phaseMarginDeg !== null) {
      const gx = xScale(gcPt.re);
      const gy = yScale(gcPt.im);
      const pmColor = analysis.margins.phaseMarginDeg >= 0 ? '#F59E0B' : '#F43F5E';

      plotLayer
        .append('line')
        .attr('x1', ox)
        .attr('y1', oy)
        .attr('x2', gx)
        .attr('y2', gy)
        .attr('stroke', pmColor)
        .attr('stroke-opacity', 0.75)
        .attr('stroke-dasharray', '3 2')
        .attr('stroke-width', 1.4);

      plotLayer
        .append('circle')
        .attr('cx', gx)
        .attr('cy', gy)
        .attr('r', 4.5)
        .attr('fill', pmColor)
        .attr('stroke', '#07090E')
        .attr('stroke-width', 1.4);

      plotLayer
        .append('text')
        .attr('x', gx + (gcPt.re >= 0 ? 7 : -7))
        .attr('y', gy + (gcPt.im >= 0 ? -7 : 13))
        .attr('text-anchor', gcPt.re >= 0 ? 'start' : 'end')
        .attr('fill', pmColor)
        .attr('font-size', '9.5px')
        .attr('font-family', 'IBM Plex Mono, monospace')
        .text(`PM ${analysis.margins.phaseMarginDeg.toFixed(1)}°`);
    }

    // Gain Margin visualization on negative real axis
    const pcPt = analysis.phaseCrossoverPoint;
    if (pcPt && analysis.margins.gainMarginDb !== null) {
      const px = xScale(pcPt.re);
      const py = yScale(0);
      const gmColor = analysis.margins.gainMarginDb >= 0 ? '#10B981' : '#F43F5E';

      plotLayer
        .append('line')
        .attr('x1', cxCrit)
        .attr('y1', cyCrit)
        .attr('x2', px)
        .attr('y2', py)
        .attr('stroke', gmColor)
        .attr('stroke-width', 2.4);

      plotLayer
        .append('circle')
        .attr('cx', px)
        .attr('cy', py)
        .attr('r', 4.5)
        .attr('fill', gmColor)
        .attr('stroke', '#07090E')
        .attr('stroke-width', 1.4);

      plotLayer
        .append('text')
        .attr('x', (cxCrit + px) / 2)
        .attr('y', py - 8)
        .attr('text-anchor', 'middle')
        .attr('fill', gmColor)
        .attr('font-size', '9.5px')
        .attr('font-family', 'IBM Plex Mono, monospace')
        .text(`GM ${analysis.margins.gainMarginDb.toFixed(1)} dB`);
    }

    // Critical Point (-1, j0) crosshair
    plotLayer
      .append('line')
      .attr('x1', cxCrit - 7)
      .attr('x2', cxCrit + 7)
      .attr('y1', cyCrit)
      .attr('y2', cyCrit)
      .attr('stroke', '#F43F5E')
      .attr('stroke-width', 2);
    plotLayer
      .append('line')
      .attr('x1', cxCrit)
      .attr('x2', cxCrit)
      .attr('y1', cyCrit - 7)
      .attr('y2', cyCrit + 7)
      .attr('stroke', '#F43F5E')
      .attr('stroke-width', 2);
    plotLayer
      .append('circle')
      .attr('cx', cxCrit)
      .attr('cy', cyCrit)
      .attr('r', 3.5)
      .attr('fill', 'none')
      .attr('stroke', '#F43F5E')
      .attr('stroke-width', 1.5);
    plotLayer
      .append('text')
      .attr('x', cxCrit - 6)
      .attr('y', cyCrit + 16)
      .attr('text-anchor', 'end')
      .attr('fill', '#FDA4AF')
      .attr('font-size', '9.5px')
      .attr('font-family', 'IBM Plex Mono, monospace')
      .text('(-1, j0)');

    // Hover marker overlay
    const hoverLayer = plotLayer.append('g').style('display', 'none');
    const hoverDotPos = hoverLayer
      .append('circle')
      .attr('r', 4.2)
      .attr('fill', '#22D3EE')
      .attr('stroke', '#07090E')
      .attr('stroke-width', 1.4);
    const hoverDotNeg = hoverLayer
      .append('circle')
      .attr('r', 3.2)
      .attr('fill', '#818CF8')
      .attr('stroke', '#07090E')
      .attr('stroke-width', 1);

    // Axes frame
    const xAxis = d3.axisBottom(xScale).ticks(7);
    const yAxis = d3.axisLeft(yScale).ticks(6);

    g.append('g')
      .attr('transform', `translate(0,${innerH})`)
      .call(xAxis)
      .call((ax) => ax.select('.domain').attr('stroke', '#334155'))
      .call((ax) => ax.selectAll('line').attr('stroke', '#334155'))
      .call((ax) =>
        ax
          .selectAll('text')
          .attr('fill', '#64748B')
          .attr('font-size', '9.5px')
          .attr('font-family', 'IBM Plex Mono, monospace')
      );

    g.append('g')
      .call(yAxis)
      .call((ax) => ax.select('.domain').attr('stroke', '#334155'))
      .call((ax) => ax.selectAll('line').attr('stroke', '#334155'))
      .call((ax) =>
        ax
          .selectAll('text')
          .attr('fill', '#64748B')
          .attr('font-size', '9.5px')
          .attr('font-family', 'IBM Plex Mono, monospace')
      );

    g.append('text')
      .attr('x', innerW / 2)
      .attr('y', innerH + 26)
      .attr('text-anchor', 'middle')
      .attr('fill', '#94A3B8')
      .attr('font-size', '9.5px')
      .attr('font-family', 'IBM Plex Mono, monospace')
      .text(mode === 'open_loop' ? 'Re{L(jω)}' : 'Re{G(jω)}');

    g.append('text')
      .attr('transform', 'rotate(-90)')
      .attr('x', -innerH / 2)
      .attr('y', -38)
      .attr('text-anchor', 'middle')
      .attr('fill', '#94A3B8')
      .attr('font-size', '9.5px')
      .attr('font-family', 'IBM Plex Mono, monospace')
      .text(mode === 'open_loop' ? 'Im{L(jω)}' : 'Im{G(jω)}');

    // Interactive nearest-point tracker
    g.append('rect')
      .attr('width', innerW)
      .attr('height', innerH)
      .attr('fill', 'transparent')
      .style('cursor', 'crosshair')
      .on('pointermove', (event) => {
        const [mx, my] = d3.pointer(event);
        let bestPt: NyquistPoint | null = null;
        let bestDist = Infinity;
        for (const pt of analysis.points) {
          if (Math.hypot(pt.re, pt.im) > 500) continue;
          const dx = xScale(pt.re) - mx;
          const dy = yScale(pt.im) - my;
          const d = dx * dx + dy * dy;
          if (d < bestDist) {
            bestDist = d;
            bestPt = pt;
          }
        }
        if (bestPt) {
          hoverLayer.style('display', null);
          hoverDotPos.attr('cx', xScale(bestPt.re)).attr('cy', yScale(bestPt.im));
          if (showMirror) {
            hoverDotNeg
              .style('display', null)
              .attr('cx', xScale(bestPt.re))
              .attr('cy', yScale(-bestPt.im));
          } else {
            hoverDotNeg.style('display', 'none');
          }
          setHoverPoint(bestPt);
        }
      })
      .on('pointerleave', () => {
        hoverLayer.style('display', 'none');
        setHoverPoint(null);
      });
  }, [analysis, mode, showMirror, zoomScope]);

  const { margins, closestPoint, openLoopRhpPoles, cwEncirclements, verdict } = analysis;

  return (
    <div className="border-t border-slate-800 bg-[#0B0E17] flex flex-col">
      {/* Header Toolbar */}
      <div className="px-5 py-2.5 border-b border-slate-800 bg-[#0F141E] flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-xs font-semibold text-slate-200">
            Nyquist Stability Criterion (Complex Plane)
          </h3>
          <p className="text-[11px] text-slate-400">
            Frequency locus {mode === 'open_loop' ? 'L(jω) = C(jω)G(jω)' : 'G(jω)'} around critical point (-1, j0)
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {/* Input channel selector if MIMO */}
          {model.plant.m > 1 && (
            <select
              aria-label="Nyquist input channel"
              value={inputIdx}
              onChange={(e) => setInputIdx(Number(e.target.value))}
              className="bg-[#07090E] border border-slate-800 rounded px-2 py-1 text-[11px] font-mono text-slate-200 focus:outline-none focus:border-cyan-400 cursor-pointer"
            >
              {Array.from({ length: model.plant.m }, (_, j) => (
                <option key={j} value={j}>
                  u[{j}]: {(model.plant.inputNames?.[j] ?? `u_${j}`).slice(0, 14)}
                </option>
              ))}
            </select>
          )}

          {/* Output channel selector if MIMO */}
          {model.plant.p > 1 && (
            <select
              aria-label="Nyquist output channel"
              value={outputIdx}
              onChange={(e) => setOutputIdx(Number(e.target.value))}
              className="bg-[#07090E] border border-slate-800 rounded px-2 py-1 text-[11px] font-mono text-slate-200 focus:outline-none focus:border-cyan-400 cursor-pointer"
            >
              {model.plant.outputNames.map((name, k) => (
                <option key={k} value={k}>
                  y[{k}]: {name.slice(0, 16)}
                </option>
              ))}
            </select>
          )}

          {/* Loop vs Plant toggle */}
          <div className="flex items-center gap-0.5 p-0.5 bg-[#07090E] border border-slate-800 rounded">
            <button
              type="button"
              onClick={() => setMode('open_loop')}
              className={`px-2 py-0.5 text-[10px] font-mono rounded transition-colors cursor-pointer whitespace-nowrap ${
                mode === 'open_loop'
                  ? 'bg-slate-800 text-cyan-300'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              Loop L(jω)
            </button>
            <button
              type="button"
              onClick={() => setMode('plant')}
              className={`px-2 py-0.5 text-[10px] font-mono rounded transition-colors cursor-pointer whitespace-nowrap ${
                mode === 'plant'
                  ? 'bg-slate-800 text-cyan-300'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              Plant G(jω)
            </button>
          </div>

          {/* Zoom Focus toggle */}
          <div className="flex items-center gap-0.5 p-0.5 bg-[#07090E] border border-slate-800 rounded">
            {(
              [
                ['critical', 'Focus (-1,0)'],
                ['wide', 'Wide'],
                ['full', 'Fit Locus'],
              ] as const
            ).map(([zKey, zLabel]) => (
              <button
                key={zKey}
                type="button"
                onClick={() => setZoomScope(zKey)}
                className={`px-2 py-0.5 text-[10px] font-mono rounded transition-colors cursor-pointer whitespace-nowrap ${
                  zoomScope === zKey
                    ? 'bg-slate-800 text-cyan-300'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                {zLabel}
              </button>
            ))}
          </div>

          {/* Mirror (-w) toggle */}
          <button
            type="button"
            aria-pressed={showMirror}
            onClick={() => setShowMirror((v) => !v)}
            className={`px-2 py-0.5 text-[10px] font-mono rounded border transition-colors cursor-pointer whitespace-nowrap ${
              showMirror
                ? 'border-indigo-500/40 bg-indigo-500/15 text-indigo-300'
                : 'border-slate-800 bg-[#07090E] text-slate-400 hover:text-slate-200'
            }`}
          >
            Mirror (-ω)
          </button>
        </div>
      </div>

      {/* Live Frequency Probe Strip */}
      <div className="px-5 py-1.5 border-b border-slate-800/70 bg-[#07090E] flex flex-wrap items-center justify-between gap-3 text-[11px] font-mono tabular-nums">
        <div className="flex flex-wrap items-center gap-4 text-slate-400">
          <span className="inline-flex items-center gap-1.5 text-cyan-300">
            <span className="w-3 h-0.5 bg-cyan-400 inline-block" />
            ω &gt; 0
          </span>
          {showMirror && (
            <span className="inline-flex items-center gap-1.5 text-indigo-300">
              <span className="w-3 border-t border-dashed border-indigo-400 inline-block" />
              ω &lt; 0
            </span>
          )}
          <span className="inline-flex items-center gap-1.5 text-rose-300">
            <span>+ (-1, j0)</span>
          </span>
          <span className="inline-flex items-center gap-1.5 text-amber-300">
            <span>PM Arc</span>
          </span>
          <span className="inline-flex items-center gap-1.5 text-emerald-300">
            <span>GM Span</span>
          </span>
        </div>

        {hoverPoint ? (
          <div className="flex flex-wrap items-center gap-3 text-slate-200">
            <span>ω={hoverPoint.omega.toFixed(2)} rad/s ({hoverPoint.hz.toFixed(2)} Hz)</span>
            <span className="text-cyan-300">
              {hoverPoint.re.toFixed(3)} {hoverPoint.im >= 0 ? '+' : '−'} j{Math.abs(hoverPoint.im).toFixed(3)}
            </span>
            <span>|L|={hoverPoint.magDb.toFixed(2)} dB</span>
            <span>∠{hoverPoint.phaseDeg.toFixed(1)}°</span>
          </div>
        ) : (
          <span className="text-slate-500">Hover complex plane to inspect ω &amp; L(jω)</span>
        )}
      </div>

      {/* D3 Complex Plane Plot */}
      <div className="bg-[#07090E] p-2">
        <svg
          ref={svgRef}
          viewBox="0 0 760 320"
          aria-label="Nyquist stability diagram in the complex plane"
          className="w-full h-[320px] select-none"
        />
      </div>

      {/* Nyquist Margins & Criterion Verdict Footer */}
      <div className="px-5 py-2.5 border-t border-slate-800 bg-[#0F141E] grid grid-cols-2 sm:grid-cols-4 gap-4 text-xs font-mono tabular-nums">
        <div>
          <div className="text-[11px] font-sans text-slate-400">Gain Margin (GM)</div>
          <div
            className={`font-semibold mt-0.5 ${
              margins.gainMarginDb === null
                ? 'text-slate-300'
                : margins.gainMarginDb >= 0
                ? 'text-emerald-400'
                : 'text-rose-400'
            }`}
          >
            {margins.gainMarginDb !== null
              ? `${margins.gainMarginDb.toFixed(2)} dB`
              : '∞ (No -180°)'}
            {analysis.phaseCrossoverPoint && (
              <span className="text-[10px] font-normal text-slate-400">
                {' '}
                ({analysis.phaseCrossoverPoint.linearGainMargin.toFixed(2)}× @ {analysis.phaseCrossoverPoint.omega.toFixed(1)}r/s)
              </span>
            )}
          </div>
        </div>

        <div>
          <div className="text-[11px] font-sans text-slate-400">Phase Margin (PM)</div>
          <div
            className={`font-semibold mt-0.5 ${
              margins.phaseMarginDeg === null
                ? 'text-slate-300'
                : margins.phaseMarginDeg >= 0
                ? 'text-amber-300'
                : 'text-rose-400'
            }`}
          >
            {margins.phaseMarginDeg !== null
              ? `${margins.phaseMarginDeg.toFixed(2)}°`
              : 'N/A (|L|<1)'}
            {margins.gainCrossoverOmega !== null && (
              <span className="text-[10px] font-normal text-slate-400">
                {' '}
                @ {margins.gainCrossoverOmega.toFixed(2)} r/s
              </span>
            )}
          </div>
        </div>

        <div>
          <div className="text-[11px] font-sans text-slate-400">
            Vector Margin d_min (M_s)
          </div>
          <div className="text-slate-100 font-semibold mt-0.5">
            {closestPoint ? closestPoint.distance.toFixed(3) : '—'}{' '}
            {closestPoint && (
              <span className="text-[10px] font-normal text-slate-400">
                (M_s={closestPoint.sensitivityPeakMs.toFixed(2)})
              </span>
            )}
          </div>
        </div>

        <div>
          <div className="text-[11px] font-sans text-slate-400">
            Nyquist Z = N + P
          </div>
          <div
            className={`font-semibold mt-0.5 ${
              verdict === 'STABLE_MARGIN'
                ? 'text-emerald-400'
                : verdict === 'NO_CROSSOVER'
                ? 'text-cyan-300'
                : 'text-rose-400'
            }`}
          >
            N={cwEncirclements}, P={openLoopRhpPoles}{' '}
            <span className="text-[10px] font-normal">
              ({verdict === 'STABLE_MARGIN'
                ? 'Stable Margin'
                : verdict === 'OPEN_LOOP_RHP'
                ? 'Open-Loop RHP'
                : verdict === 'UNSTABLE_MARGIN'
                ? 'Encircled / Neg'
                : 'No Crossover'})
            </span>
          </div>
        </div>
      </div>
    </div>
  );
};
