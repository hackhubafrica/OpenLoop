import React, { useEffect, useMemo, useRef, useState } from 'react';
import * as d3 from 'd3';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { ControlModel } from '../types/control';
import { BodePoint, computeBodeAnalysis } from '../engine/bode';

interface FrequencyResponsePanelProps {
  model: ControlModel;
}

function formatOmega(w: number): string {
  if (w >= 1000 || w < 0.01) return w.toExponential(1);
  if (w >= 100) return w.toFixed(0);
  if (w >= 10) return w.toFixed(1);
  return w.toFixed(2);
}

export const FrequencyResponsePanel: React.FC<FrequencyResponsePanelProps> = ({
  model,
}) => {
  const [inputIdx, setInputIdx] = useState<number>(0);
  const [outputIdx, setOutputIdx] = useState<number>(model.pid.targetOutputIndex);
  const [mode, setMode] = useState<'open_loop' | 'plant'>('open_loop');
  const [layout, setLayout] = useState<'stacked' | 'split'>('stacked');
  const [collapsed, setCollapsed] = useState<boolean>(false);
  const [hoverPoint, setHoverPoint] = useState<BodePoint | null>(null);

  const magSvgRef = useRef<SVGSVGElement | null>(null);
  const phaseSvgRef = useRef<SVGSVGElement | null>(null);

  useEffect(() => {
    setInputIdx((prev) => Math.min(prev, Math.max(0, model.plant.m - 1)));
    setOutputIdx(Math.min(model.pid.targetOutputIndex, Math.max(0, model.plant.p - 1)));
  }, [model.id, model.pid.targetOutputIndex, model.plant.m, model.plant.p]);

  const safeInIdx = Math.min(inputIdx, Math.max(0, model.plant.m - 1));
  const safeOutIdx = Math.min(outputIdx, Math.max(0, model.plant.p - 1));

  const analysis = useMemo(
    () => computeBodeAnalysis(model, safeOutIdx, mode, safeInIdx),
    [model, safeOutIdx, mode, safeInIdx]
  );

  // Dimensions tuned so Stacked aligns cleanly with 920px Oscilloscope/Impulse width
  const magDims = useMemo(
    () =>
      layout === 'stacked'
        ? {
            width: 920,
            height: 175,
            margin: { top: 16, right: 28, bottom: 26, left: 56 },
          }
        : {
            width: 460,
            height: 225,
            margin: { top: 18, right: 22, bottom: 30, left: 52 },
          },
    [layout]
  );

  const phaseDims = useMemo(
    () =>
      layout === 'stacked'
        ? {
            width: 920,
            height: 165,
            margin: { top: 14, right: 28, bottom: 28, left: 56 },
          }
        : {
            width: 460,
            height: 225,
            margin: { top: 18, right: 22, bottom: 30, left: 52 },
          },
    [layout]
  );

  // Compute shared D3 scales so static rendering & interactive cursor stay strictly synchronized
  const scales = useMemo(() => {
    const points = analysis.points;
    const magInnerW = magDims.width - magDims.margin.left - magDims.margin.right;
    const magInnerH = magDims.height - magDims.margin.top - magDims.margin.bottom;
    const phaseInnerW = phaseDims.width - phaseDims.margin.left - phaseDims.margin.right;
    const phaseInnerH = phaseDims.height - phaseDims.margin.top - phaseDims.margin.bottom;

    const xMagScale = d3
      .scaleLog()
      .domain([analysis.omegaMin, analysis.omegaMax])
      .range([0, magInnerW]);

    const xPhaseScale = d3
      .scaleLog()
      .domain([analysis.omegaMin, analysis.omegaMax])
      .range([0, phaseInnerW]);

    const magExtent = d3.extent(points, (d) => d.magDb) as [number, number];
    const magMinVal = magExtent[0] ?? -20;
    const magMaxVal = magExtent[1] ?? 20;
    const magPad = Math.max(6, (magMaxVal - magMinVal) * 0.14);
    const yMagScale = d3
      .scaleLinear()
      .domain([Math.min(-10, magMinVal - magPad), Math.max(10, magMaxVal + magPad)])
      .range([magInnerH, 0]);

    const phaseExtent = d3.extent(points, (d) => d.phaseDeg) as [number, number];
    const pMinVal = phaseExtent[0] ?? -180;
    const pMaxVal = phaseExtent[1] ?? 0;
    const phaseMin = Math.min(-195, Math.floor((pMinVal - 15) / 45) * 45);
    const phaseMax = Math.max(15, Math.ceil((pMaxVal + 15) / 45) * 45);
    const yPhaseScale = d3
      .scaleLinear()
      .domain([phaseMin, phaseMax])
      .range([phaseInnerH, 0]);

    return {
      magInnerW,
      magInnerH,
      phaseInnerW,
      phaseInnerH,
      xMagScale,
      xPhaseScale,
      yMagScale,
      yPhaseScale,
    };
  }, [analysis, magDims, phaseDims]);

  // Effect 1: Render static D3 Bode Magnitude & Phase charts (no teardown on pointer move)
  useEffect(() => {
    if (collapsed) return;
    const points = analysis.points;
    if (points.length === 0) return;

    const {
      magInnerW,
      magInnerH,
      phaseInnerW,
      phaseInnerH,
      xMagScale,
      xPhaseScale,
      yMagScale,
      yPhaseScale,
    } = scales;

    const bisectOmega = d3.bisector<BodePoint, number>((d) => d.omega).left;
    const {
      gainCrossoverOmega,
      phaseCrossoverOmega,
      gainMarginDb,
      phaseMarginDeg,
    } = analysis.margins;

    // 1. Magnitude Bode Diagram
    if (magSvgRef.current) {
      const svg = d3.select(magSvgRef.current);
      svg.selectAll('*').remove();

      const defs = svg.append('defs');
      const magGrad = defs
        .append('linearGradient')
        .attr('id', 'wb-bode-mag-grad')
        .attr('x1', '0%')
        .attr('y1', '0%')
        .attr('x2', '0%')
        .attr('y2', '100%');
      magGrad
        .append('stop')
        .attr('offset', '0%')
        .attr('stop-color', '#06B6D4')
        .attr('stop-opacity', 0.16);
      magGrad
        .append('stop')
        .attr('offset', '100%')
        .attr('stop-color', '#06B6D4')
        .attr('stop-opacity', 0.0);

      const g = svg
        .append('g')
        .attr('transform', `translate(${magDims.margin.left},${magDims.margin.top})`);

      // Logarithmic frequency grid & linear dB grid
      g.append('g')
        .selectAll('line')
        .data(xMagScale.ticks(6))
        .join('line')
        .attr('x1', (d) => xMagScale(d))
        .attr('x2', (d) => xMagScale(d))
        .attr('y1', 0)
        .attr('y2', magInnerH)
        .attr('stroke', '#151D2B')
        .attr('stroke-width', 1);

      g.append('g')
        .selectAll('line')
        .data(yMagScale.ticks(5))
        .join('line')
        .attr('x1', 0)
        .attr('x2', magInnerW)
        .attr('y1', (d) => yMagScale(d))
        .attr('y2', (d) => yMagScale(d))
        .attr('stroke', '#1E293B')
        .attr('stroke-width', 1);

      // 0 dB Unity-Gain Line
      const yZeroDb = yMagScale(0);
      g.append('line')
        .attr('x1', 0)
        .attr('x2', magInnerW)
        .attr('y1', yZeroDb)
        .attr('y2', yZeroDb)
        .attr('stroke', '#64748B')
        .attr('stroke-dasharray', '4 3')
        .attr('stroke-width', 1.2);

      g.append('text')
        .attr('x', magInnerW - 4)
        .attr('y', Math.max(10, yZeroDb - 4))
        .attr('text-anchor', 'end')
        .attr('fill', '#64748B')
        .attr('font-size', '9px')
        .attr('font-family', 'IBM Plex Mono, monospace')
        .text('0 dB Unity Gain');

      // Crossover vertical guides
      if (gainCrossoverOmega !== null) {
        const xGc = xMagScale(gainCrossoverOmega);
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
        const xPc = xMagScale(phaseCrossoverOmega);
        g.append('line')
          .attr('x1', xPc)
          .attr('x2', xPc)
          .attr('y1', 0)
          .attr('y2', magInnerH)
          .attr('stroke', '#10B981')
          .attr('stroke-opacity', 0.45)
          .attr('stroke-dasharray', '3 3')
          .attr('stroke-width', 1.2);
      }

      // Magnitude Envelope Area + Curve
      const magArea = d3
        .area<BodePoint>()
        .x((d) => xMagScale(d.omega))
        .y0(magInnerH)
        .y1((d) => yMagScale(d.magDb));

      g.append('path')
        .datum(points)
        .attr('fill', 'url(#wb-bode-mag-grad)')
        .attr('d', magArea);

      const magLine = d3
        .line<BodePoint>()
        .x((d) => xMagScale(d.omega))
        .y((d) => yMagScale(d.magDb));

      g.append('path')
        .datum(points)
        .attr('fill', 'none')
        .attr('stroke', '#06B6D4')
        .attr('stroke-width', 2)
        .attr('d', magLine);

      // -3 dB Bandwidth Marker (only when rolloff crosses dcGain - 3dB)
      if (analysis.bandwidthOmega !== null) {
        const xBw = xMagScale(analysis.bandwidthOmega);
        const yBw = yMagScale(analysis.dcGainDb - 3.0103);
        g.append('circle')
          .attr('cx', xBw)
          .attr('cy', yBw)
          .attr('r', 3.2)
          .attr('fill', '#38BDF8')
          .attr('stroke', '#07090E')
          .attr('stroke-width', 1);

        g.append('text')
          .attr('x', xBw > magInnerW - 105 ? xBw - 6 : xBw + 6)
          .attr('y', Math.min(magInnerH - 6, yBw + 12))
          .attr('text-anchor', xBw > magInnerW - 105 ? 'end' : 'start')
          .attr('fill', '#7DD3FC')
          .attr('font-size', '9px')
          .attr('font-family', 'IBM Plex Mono, monospace')
          .text(`ω_bw ${formatOmega(analysis.bandwidthOmega)}`);
      }

      // Gain Margin Caliper at Phase Crossover ω_pc
      if (phaseCrossoverOmega !== null && gainMarginDb !== null) {
        const xPc = xMagScale(phaseCrossoverOmega);
        const yAtPc = yMagScale(-gainMarginDb);
        const gmColor = gainMarginDb >= 0 ? '#10B981' : '#F43F5E';

        g.append('line')
          .attr('x1', xPc)
          .attr('x2', xPc)
          .attr('y1', yZeroDb)
          .attr('y2', yAtPc)
          .attr('stroke', gmColor)
          .attr('stroke-width', 2.4);

        g.append('line')
          .attr('x1', xPc - 4)
          .attr('x2', xPc + 4)
          .attr('y1', yZeroDb)
          .attr('y2', yZeroDb)
          .attr('stroke', gmColor)
          .attr('stroke-width', 1.4);

        g.append('line')
          .attr('x1', xPc - 4)
          .attr('x2', xPc + 4)
          .attr('y1', yAtPc)
          .attr('y2', yAtPc)
          .attr('stroke', gmColor)
          .attr('stroke-width', 1.4);

        g.append('circle')
          .attr('cx', xPc)
          .attr('cy', yAtPc)
          .attr('r', 3.8)
          .attr('fill', gmColor)
          .attr('stroke', '#07090E')
          .attr('stroke-width', 1.2);

        g.append('text')
          .attr('x', xPc > magInnerW - 115 ? xPc - 8 : xPc + 7)
          .attr('y', (yZeroDb + yAtPc) / 2 + 3)
          .attr('text-anchor', xPc > magInnerW - 115 ? 'end' : 'start')
          .attr('fill', gmColor)
          .attr('font-size', '9.5px')
          .attr('font-weight', '600')
          .attr('font-family', 'IBM Plex Mono, monospace')
          .text(`GM ${gainMarginDb.toFixed(1)} dB`);
      }

      // Gain Crossover ω_gc Dot & Callout
      if (gainCrossoverOmega !== null) {
        const xGc = xMagScale(gainCrossoverOmega);
        g.append('circle')
          .attr('cx', xGc)
          .attr('cy', yZeroDb)
          .attr('r', 6.5)
          .attr('fill', '#F59E0B')
          .attr('fill-opacity', 0.22);

        g.append('circle')
          .attr('cx', xGc)
          .attr('cy', yZeroDb)
          .attr('r', 3.8)
          .attr('fill', '#F59E0B')
          .attr('stroke', '#07090E')
          .attr('stroke-width', 1.2);

        g.append('text')
          .attr('x', xGc > magInnerW - 115 ? xGc - 8 : xGc + 8)
          .attr('y', Math.max(12, yZeroDb - 8))
          .attr('text-anchor', xGc > magInnerW - 115 ? 'end' : 'start')
          .attr('fill', '#FCD34D')
          .attr('font-size', '9.5px')
          .attr('font-family', 'IBM Plex Mono, monospace')
          .text(`ω_gc ${formatOmega(gainCrossoverOmega)}`);
      }

      // Axes
      const xAxis = d3
        .axisBottom(xMagScale)
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

      g.append('text')
        .attr('x', 6)
        .attr('y', 10)
        .attr('fill', '#22D3EE')
        .attr('font-size', '10px')
        .attr('font-family', 'IBM Plex Mono, monospace')
        .text('Magnitude |H(jω)| (dB)');

      // Dedicated hover cursor group updated independently in Effect 2
      const cursorGroup = g.append('g').attr('class', 'wb-bode-hover').style('display', 'none');
      cursorGroup
        .append('line')
        .attr('class', 'wb-bode-cursor-line')
        .attr('y1', 0)
        .attr('y2', magInnerH)
        .attr('stroke', '#94A3B8')
        .attr('stroke-opacity', 0.7)
        .attr('stroke-width', 1);
      cursorGroup
        .append('circle')
        .attr('class', 'wb-bode-cursor-dot')
        .attr('r', 3.6)
        .attr('fill', '#06B6D4')
        .attr('stroke', '#07090E')
        .attr('stroke-width', 1.5);

      g.append('rect')
        .attr('width', magInnerW)
        .attr('height', magInnerH)
        .attr('fill', 'transparent')
        .style('cursor', 'crosshair')
        .on('pointermove', (event: PointerEvent) => {
          const [mx] = d3.pointer(event);
          const w = xMagScale.invert(Math.max(0, Math.min(magInnerW, mx)));
          const idx = Math.min(points.length - 1, Math.max(0, bisectOmega(points, w)));
          setHoverPoint(points[idx]);
        })
        .on('pointerleave', () => setHoverPoint(null));
    }

    // 2. Phase Bode Diagram
    if (phaseSvgRef.current) {
      const svg = d3.select(phaseSvgRef.current);
      svg.selectAll('*').remove();

      const g = svg
        .append('g')
        .attr('transform', `translate(${phaseDims.margin.left},${phaseDims.margin.top})`);

      g.append('g')
        .selectAll('line')
        .data(xPhaseScale.ticks(6))
        .join('line')
        .attr('x1', (d) => xPhaseScale(d))
        .attr('x2', (d) => xPhaseScale(d))
        .attr('y1', 0)
        .attr('y2', phaseInnerH)
        .attr('stroke', '#151D2B')
        .attr('stroke-width', 1);

      g.append('g')
        .selectAll('line')
        .data(yPhaseScale.ticks(5))
        .join('line')
        .attr('x1', 0)
        .attr('x2', phaseInnerW)
        .attr('y1', (d) => yPhaseScale(d))
        .attr('y2', (d) => yPhaseScale(d))
        .attr('stroke', '#1E293B')
        .attr('stroke-width', 1);

      // -180° stability threshold shading & line
      const yCritPhase = yPhaseScale(-180);
      if (yCritPhase < phaseInnerH) {
        g.append('rect')
          .attr('x', 0)
          .attr('y', Math.max(0, yCritPhase))
          .attr('width', phaseInnerW)
          .attr('height', Math.max(0, phaseInnerH - Math.max(0, yCritPhase)))
          .attr('fill', '#F43F5E')
          .attr('fill-opacity', 0.06);
      }

      g.append('line')
        .attr('x1', 0)
        .attr('x2', phaseInnerW)
        .attr('y1', yCritPhase)
        .attr('y2', yCritPhase)
        .attr('stroke', '#F43F5E')
        .attr('stroke-opacity', 0.65)
        .attr('stroke-dasharray', '4 3')
        .attr('stroke-width', 1.2);

      g.append('text')
        .attr('x', phaseInnerW - 4)
        .attr('y', Math.max(10, yCritPhase - 4))
        .attr('text-anchor', 'end')
        .attr('fill', '#FDA4AF')
        .attr('font-size', '9px')
        .attr('font-family', 'IBM Plex Mono, monospace')
        .text('Stability Limit (-180°)');

      // Crossover vertical guides
      if (gainCrossoverOmega !== null) {
        const xGc = xPhaseScale(gainCrossoverOmega);
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
        const xPc = xPhaseScale(phaseCrossoverOmega);
        g.append('line')
          .attr('x1', xPc)
          .attr('x2', xPc)
          .attr('y1', 0)
          .attr('y2', phaseInnerH)
          .attr('stroke', '#10B981')
          .attr('stroke-opacity', 0.45)
          .attr('stroke-dasharray', '3 3')
          .attr('stroke-width', 1.2);
      }

      // Phase Curve
      const phaseLine = d3
        .line<BodePoint>()
        .x((d) => xPhaseScale(d.omega))
        .y((d) => yPhaseScale(d.phaseDeg));

      g.append('path')
        .datum(points)
        .attr('fill', 'none')
        .attr('stroke', '#F59E0B')
        .attr('stroke-width', 2)
        .attr('d', phaseLine);

      // Phase Margin Caliper at Gain Crossover ω_gc
      if (gainCrossoverOmega !== null && phaseMarginDeg !== null) {
        const xGc = xPhaseScale(gainCrossoverOmega);
        const yAtGc = yPhaseScale(-180 + phaseMarginDeg);
        const pmColor = phaseMarginDeg >= 0 ? '#10B981' : '#F43F5E';

        g.append('line')
          .attr('x1', xGc)
          .attr('x2', xGc)
          .attr('y1', yCritPhase)
          .attr('y2', yAtGc)
          .attr('stroke', pmColor)
          .attr('stroke-width', 2.4);

        g.append('line')
          .attr('x1', xGc - 4)
          .attr('x2', xGc + 4)
          .attr('y1', yCritPhase)
          .attr('y2', yCritPhase)
          .attr('stroke', pmColor)
          .attr('stroke-width', 1.4);

        g.append('line')
          .attr('x1', xGc - 4)
          .attr('x2', xGc + 4)
          .attr('y1', yAtGc)
          .attr('y2', yAtGc)
          .attr('stroke', pmColor)
          .attr('stroke-width', 1.4);

        g.append('circle')
          .attr('cx', xGc)
          .attr('cy', yAtGc)
          .attr('r', 3.8)
          .attr('fill', pmColor)
          .attr('stroke', '#07090E')
          .attr('stroke-width', 1.2);

        g.append('text')
          .attr('x', xGc > phaseInnerW - 110 ? xGc - 8 : xGc + 7)
          .attr('y', (yCritPhase + yAtGc) / 2 + 3)
          .attr('text-anchor', xGc > phaseInnerW - 110 ? 'end' : 'start')
          .attr('fill', pmColor)
          .attr('font-size', '9.5px')
          .attr('font-weight', '600')
          .attr('font-family', 'IBM Plex Mono, monospace')
          .text(`PM ${phaseMarginDeg.toFixed(1)}°`);
      }

      // Phase Crossover ω_pc Dot & Callout
      if (phaseCrossoverOmega !== null) {
        const xPc = xPhaseScale(phaseCrossoverOmega);
        g.append('circle')
          .attr('cx', xPc)
          .attr('cy', yCritPhase)
          .attr('r', 6.5)
          .attr('fill', '#10B981')
          .attr('fill-opacity', 0.22);

        g.append('circle')
          .attr('cx', xPc)
          .attr('cy', yCritPhase)
          .attr('r', 3.8)
          .attr('fill', '#10B981')
          .attr('stroke', '#07090E')
          .attr('stroke-width', 1.2);

        g.append('text')
          .attr('x', xPc > phaseInnerW - 115 ? xPc - 8 : xPc + 8)
          .attr('y', Math.max(12, yCritPhase - 8))
          .attr('text-anchor', xPc > phaseInnerW - 115 ? 'end' : 'start')
          .attr('fill', '#6EE7B7')
          .attr('font-size', '9.5px')
          .attr('font-family', 'IBM Plex Mono, monospace')
          .text(`ω_pc ${formatOmega(phaseCrossoverOmega)}`);
      }

      // Axes
      const xAxis = d3
        .axisBottom(xPhaseScale)
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
        .attr('fill', '#FBBF24')
        .attr('font-size', '10px')
        .attr('font-family', 'IBM Plex Mono, monospace')
        .text('Phase ∠H(jω) (deg) · ω (rad/s)');

      // Dedicated hover cursor group updated independently in Effect 2
      const cursorGroup = g.append('g').attr('class', 'wb-bode-hover').style('display', 'none');
      cursorGroup
        .append('line')
        .attr('class', 'wb-bode-cursor-line')
        .attr('y1', 0)
        .attr('y2', phaseInnerH)
        .attr('stroke', '#94A3B8')
        .attr('stroke-opacity', 0.7)
        .attr('stroke-width', 1);
      cursorGroup
        .append('circle')
        .attr('class', 'wb-bode-cursor-dot')
        .attr('r', 3.6)
        .attr('fill', '#F59E0B')
        .attr('stroke', '#07090E')
        .attr('stroke-width', 1.5);

      g.append('rect')
        .attr('width', phaseInnerW)
        .attr('height', phaseInnerH)
        .attr('fill', 'transparent')
        .style('cursor', 'crosshair')
        .on('pointermove', (event: PointerEvent) => {
          const [mx] = d3.pointer(event);
          const w = xPhaseScale.invert(Math.max(0, Math.min(phaseInnerW, mx)));
          const idx = Math.min(points.length - 1, Math.max(0, bisectOmega(points, w)));
          setHoverPoint(points[idx]);
        })
        .on('pointerleave', () => setHoverPoint(null));
    }
  }, [analysis, magDims, phaseDims, scales, collapsed]);

  // Effect 2: Smooth 60fps crosshair update without rebuilding D3 SVG trees
  useEffect(() => {
    if (collapsed) return;
    const { xMagScale, xPhaseScale, yMagScale, yPhaseScale } = scales;

    if (magSvgRef.current) {
      const group = d3.select(magSvgRef.current).select<SVGGElement>('.wb-bode-hover');
      if (hoverPoint) {
        const hx = xMagScale(hoverPoint.omega);
        const hy = yMagScale(hoverPoint.magDb);
        group.style('display', null);
        group.select('.wb-bode-cursor-line').attr('x1', hx).attr('x2', hx);
        group.select('.wb-bode-cursor-dot').attr('cx', hx).attr('cy', hy);
      } else {
        group.style('display', 'none');
      }
    }

    if (phaseSvgRef.current) {
      const group = d3.select(phaseSvgRef.current).select<SVGGElement>('.wb-bode-hover');
      if (hoverPoint) {
        const hx = xPhaseScale(hoverPoint.omega);
        const hy = yPhaseScale(hoverPoint.phaseDeg);
        group.style('display', null);
        group.select('.wb-bode-cursor-line').attr('x1', hx).attr('x2', hx);
        group.select('.wb-bode-cursor-dot').attr('cx', hx).attr('cy', hy);
      } else {
        group.style('display', 'none');
      }
    }
  }, [hoverPoint, scales, collapsed]);

  const { margins } = analysis;
  const inName = model.plant.inputNames[safeInIdx] ?? `u_${safeInIdx}`;
  const outName = model.plant.outputNames[safeOutIdx] ?? `y_${safeOutIdx}`;
  const effectiveOpenLoop = mode === 'open_loop' && model.pid.enabled;

  return (
    <section
      aria-label="Frequency Response Bode Magnitude and Phase"
      className="border-t border-slate-800 bg-[#0B0E17] flex flex-col shrink-0"
    >
      {/* Panel Header & Controls */}
      <div className="px-4 py-2.5 border-b border-slate-800/80 bg-[#0F141E] flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={() => setCollapsed((v) => !v)}
            className="flex items-center gap-1.5 text-left group cursor-pointer"
            aria-expanded={!collapsed}
          >
            {collapsed ? (
              <ChevronRight className="w-3.5 h-3.5 text-slate-400 group-hover:text-slate-200" />
            ) : (
              <ChevronDown className="w-3.5 h-3.5 text-slate-400 group-hover:text-slate-200" />
            )}
            <div>
              <h3 className="text-xs font-semibold text-slate-200 whitespace-nowrap">
                Frequency Response · Bode Diagrams (D3.js)
              </h3>
              <p className="text-[11px] text-slate-400 whitespace-nowrap">
                State-space {effectiveOpenLoop ? 'L(jω) = C_pid(jω)·G(jω)' : 'G(jω) = C(jωI−A)⁻¹B+D'} · {inName} → {outName}
              </p>
            </div>
          </button>

          {model.plant.m > 1 && (
            <select
              aria-label="Select Bode input channel"
              value={safeInIdx}
              onChange={(e) => setInputIdx(Number(e.target.value))}
              className="bg-[#07090E] border border-slate-700 text-amber-200 text-[10px] font-mono rounded px-2 py-1 focus:outline-none focus:border-cyan-400 cursor-pointer"
            >
              {model.plant.inputNames.map((name, idx) => (
                <option key={idx} value={idx}>
                  u[{idx}]: {name}
                </option>
              ))}
            </select>
          )}

          {model.plant.p > 1 && (
            <div className="flex items-center gap-1 p-0.5 bg-[#07090E] border border-slate-800 rounded">
              {model.plant.outputNames.map((name, idx) => (
                <button
                  key={idx}
                  type="button"
                  onClick={() => setOutputIdx(idx)}
                  className={`px-2 py-0.5 text-[10px] font-mono rounded transition-colors cursor-pointer whitespace-nowrap ${
                    safeOutIdx === idx
                      ? 'bg-slate-800 text-cyan-300'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  y[{idx}]: {name}
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {/* Open-Loop vs Plant Transfer Selector */}
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
              Open-Loop L(jω)
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

          {/* Stacked vs Side-by-Side Layout */}
          <div className="flex items-center gap-0.5 p-0.5 bg-[#07090E] border border-slate-800 rounded">
            <button
              type="button"
              onClick={() => setLayout('stacked')}
              className={`px-2 py-0.5 text-[10px] font-mono rounded transition-colors cursor-pointer whitespace-nowrap ${
                layout === 'stacked'
                  ? 'bg-slate-800 text-slate-100'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              Stacked
            </button>
            <button
              type="button"
              onClick={() => setLayout('split')}
              className={`px-2 py-0.5 text-[10px] font-mono rounded transition-colors cursor-pointer whitespace-nowrap ${
                layout === 'split'
                  ? 'bg-slate-800 text-slate-100'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              Side-by-Side
            </button>
          </div>
        </div>
      </div>

      {!collapsed && (
        <>
          {/* Legend + Synchronized Frequency Probe */}
          <div className="px-4 py-1.5 border-b border-slate-800/60 bg-[#07090E] flex flex-wrap items-center justify-between gap-3 text-[11px] font-mono tabular-nums">
            <div className="flex flex-wrap items-center gap-4">
              <span className="inline-flex items-center gap-1.5 text-cyan-300">
                <span className="w-3.5 h-0.5 bg-cyan-400 inline-block" />
                <span>Magnitude (dB)</span>
              </span>
              <span className="inline-flex items-center gap-1.5 text-amber-300">
                <span className="w-3.5 h-0.5 bg-amber-400 inline-block" />
                <span>Phase (deg)</span>
              </span>
              <span className="inline-flex items-center gap-1.5 text-slate-400">
                <span className="w-3 border-t border-dashed border-slate-500 inline-block" />
                <span>0 dB Unity</span>
              </span>
              <span className="inline-flex items-center gap-1.5 text-rose-300/90">
                <span className="w-3 border-t border-dashed border-rose-500/80 inline-block" />
                <span>−180° Limit</span>
              </span>
            </div>

            {hoverPoint ? (
              <div className="flex flex-wrap items-center gap-3 text-slate-300">
                <span>
                  ω={formatOmega(hoverPoint.omega)} rad/s ({hoverPoint.hz.toFixed(2)} Hz)
                </span>
                <span className="text-cyan-300">
                  {hoverPoint.magDb.toFixed(2)} dB (|H|={Math.pow(10, hoverPoint.magDb / 20).toFixed(3)})
                </span>
                <span className="text-amber-300">{hoverPoint.phaseDeg.toFixed(1)}°</span>
              </div>
            ) : (
              <div className="text-slate-500">
                Hover either Bode plot to probe ω, dB magnitude, and phase
              </div>
            )}
          </div>

          {/* D3.js Magnitude & Phase Diagrams */}
          <div
            className={`px-2 py-2 bg-[#07090E] ${
              layout === 'split'
                ? 'grid grid-cols-1 lg:grid-cols-2 gap-2'
                : 'flex flex-col gap-1'
            }`}
          >
            <svg
              ref={magSvgRef}
              viewBox={`0 0 ${magDims.width} ${magDims.height}`}
              aria-label="Bode Magnitude Diagram (dB vs log frequency)"
              className={`w-full select-none ${
                layout === 'split' ? 'h-[225px]' : 'h-[175px]'
              }`}
            />
            <svg
              ref={phaseSvgRef}
              viewBox={`0 0 ${phaseDims.width} ${phaseDims.height}`}
              aria-label="Bode Phase Diagram (degrees vs log frequency)"
              className={`w-full select-none ${
                layout === 'split' ? 'h-[225px]' : 'h-[165px]'
              }`}
            />
          </div>
        </>
      )}

      {/* Frequency-Domain Stability & Bandwidth Summary Bar */}
      <div className="px-4 py-2 border-t border-slate-800/80 bg-[#0F141E] grid grid-cols-2 sm:grid-cols-4 gap-4 text-xs font-mono tabular-nums">
        <div>
          <div className="text-[11px] font-sans text-slate-400">
            Phase Margin (PM)
          </div>
          <div
            className={`font-semibold mt-0.5 ${
              margins.phaseMarginDeg === null
                ? 'text-slate-300'
                : margins.phaseMarginDeg >= 0
                ? 'text-emerald-400'
                : 'text-rose-400'
            }`}
          >
            {margins.phaseMarginDeg !== null
              ? `${margins.phaseMarginDeg.toFixed(1)}°`
              : '—'}{' '}
            {margins.gainCrossoverOmega !== null && (
              <span className="text-[10px] font-normal text-amber-300/90">
                @ ω_gc={formatOmega(margins.gainCrossoverOmega)}
              </span>
            )}
          </div>
        </div>

        <div>
          <div className="text-[11px] font-sans text-slate-400">
            Gain Margin (GM)
          </div>
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
              : '∞'}{' '}
            {margins.phaseCrossoverOmega !== null && (
              <span className="text-[10px] font-normal text-emerald-300/90">
                @ ω_pc={formatOmega(margins.phaseCrossoverOmega)}
              </span>
            )}
          </div>
        </div>

        <div>
          <div className="text-[11px] font-sans text-slate-400">
            −3 dB Bandwidth / Peak M_r
          </div>
          <div className="text-cyan-300 font-semibold mt-0.5">
            {analysis.bandwidthOmega !== null
              ? `${formatOmega(analysis.bandwidthOmega)} rad/s`
              : 'No rolloff'}{' '}
            <span className="text-[10px] font-normal text-slate-400">
              / {analysis.peakMagDb.toFixed(1)} dB
            </span>
          </div>
        </div>

        <div>
          <div className="text-[11px] font-sans text-slate-400">
            Low-Freq Gain & Verdict
          </div>
          <div className="flex items-center gap-2 font-semibold mt-0.5">
            <span className="text-slate-200">
              {analysis.dcGainDb.toFixed(1)} dB
            </span>
            <span
              className={`text-[10px] ${
                margins.closedLoopStableHint === 'MARGIN_POSITIVE'
                  ? 'text-emerald-400'
                  : margins.closedLoopStableHint === 'MARGIN_NEGATIVE'
                  ? 'text-rose-400'
                  : margins.closedLoopStableHint === 'OPEN_LOOP_UNSTABLE'
                  ? 'text-amber-300'
                  : 'text-slate-400'
              }`}
            >
              {margins.closedLoopStableHint === 'MARGIN_POSITIVE'
                ? '● Stable Margins'
                : margins.closedLoopStableHint === 'MARGIN_NEGATIVE'
                ? '✖ Negative Margin'
                : margins.closedLoopStableHint === 'OPEN_LOOP_UNSTABLE'
                ? '▲ Open-Loop RHP'
                : '● No 0dB Cross'}
            </span>
          </div>
        </div>
      </div>
    </section>
  );
};
