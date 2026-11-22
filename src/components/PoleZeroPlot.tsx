import React, { useEffect, useMemo, useRef, useState } from 'react';
import * as d3 from 'd3';
import { ControlModel } from '../types/control';
import {
  analyzeSystemStability,
  ComplexPoleZero,
  computeSPlaneStabilityHeatmap,
  RootLocusAnalysis,
  RootLocusPoint,
  SPlaneHeatmapCell,
} from '../engine/stability';

interface PoleZeroPlotProps {
  model: ControlModel;
  rootLocus?: RootLocusAnalysis | null;
  onClearRootLocus?: () => void;
  controllerFocusTick?: number;
  onLoopModeChange?: (mode: 'open' | 'closed') => void;
}

const LOCUS_BRANCH_COLORS = [
  '#38BDF8',
  '#A78BFA',
  '#34D399',
  '#FBBF24',
  '#F472B6',
  '#60A5FA',
  '#2DD4BF',
  '#FB7185',
];

export const PoleZeroPlot: React.FC<PoleZeroPlotProps> = ({
  model,
  rootLocus = null,
  onClearRootLocus,
  controllerFocusTick = 0,
  onLoopModeChange,
}) => {
  const [plane, setPlane] = useState<'s' | 'z'>('s');
  const [loopMode, setLoopMode] = useState<'open' | 'closed'>('open');
  const [inputIdx, setInputIdx] = useState<number>(0);
  const [outputIdx, setOutputIdx] = useState<number>(model.pid.targetOutputIndex);
  const [hovered, setHovered] = useState<ComplexPoleZero | null>(null);
  const [hoveredLocus, setHoveredLocus] = useState<RootLocusPoint | null>(null);
  const [showStabilityHeatmap, setShowStabilityHeatmap] = useState<boolean>(false);
  const [gainScale, setGainScale] = useState<number>(1.0);
  const [maxTimeConstantSec, setMaxTimeConstantSec] = useState<number>(1.0);
  const [minDampingRatio, setMinDampingRatio] = useState<number>(0.2);
  const [hoveredCell, setHoveredCell] = useState<SPlaneHeatmapCell | null>(null);

  const svgRef = useRef<SVGSVGElement | null>(null);
  const scalesRef = useRef<{
    xScale: d3.ScaleLinear<number, number>;
    yScale: d3.ScaleLinear<number, number>;
    innerW: number;
    innerH: number;
  } | null>(null);

  useEffect(() => {
    setInputIdx((prev) => Math.min(prev, Math.max(0, model.plant.m - 1)));
    setOutputIdx(Math.min(model.pid.targetOutputIndex, Math.max(0, model.plant.p - 1)));
  }, [model.id, model.pid.targetOutputIndex, model.plant.m, model.plant.p]);

  useEffect(() => {
    if (rootLocus && rootLocus.branches.length > 0) {
      setPlane('s');
      setLoopMode('open');
    }
  }, [rootLocus]);

  useEffect(() => {
    if (controllerFocusTick > 0) {
      setPlane('s');
      setLoopMode('closed');
    }
  }, [controllerFocusTick]);

  useEffect(() => {
    onLoopModeChange?.(loopMode);
  }, [loopMode, onLoopModeChange]);

  const analysis = useMemo(
    () => analyzeSystemStability(model, outputIdx, inputIdx),
    [model, outputIdx, inputIdx]
  );

  const activePoles =
    plane === 'z'
      ? analysis.discretePoles
      : loopMode === 'closed'
      ? analysis.closedLoopPoles
      : analysis.openLoopPoles;

  const activeZeros = useMemo(
    () =>
      plane === 's'
        ? loopMode === 'open'
          ? analysis.plantZeros
          : [...analysis.plantZeros, ...analysis.pidZeros]
        : [],
    [plane, loopMode, analysis.plantZeros, analysis.pidZeros]
  );
  const allMarkers = useMemo(
    () => [...activePoles, ...activeZeros],
    [activePoles, activeZeros]
  );

  const activeVerdict =
    plane === 'z'
      ? analysis.discreteVerdict
      : loopMode === 'closed'
      ? analysis.closedLoopVerdict
      : analysis.openLoopVerdict;

  const heatmapSummary = useMemo(() => {
    if (!showStabilityHeatmap || plane !== 's') return null;
    return computeSPlaneStabilityHeatmap(model, [-4, 1], [-4, 4], {
      scope: loopMode,
      gainScale,
      maxTimeConstantSec,
      minDampingRatio,
      cols: 6,
      rows: 4,
    });
  }, [
    showStabilityHeatmap,
    plane,
    model,
    loopMode,
    gainScale,
    maxTimeConstantSec,
    minDampingRatio,
  ]);

  useEffect(() => {
    const svgEl = svgRef.current;
    if (!svgEl) return;

    const width = 760;
    const height = 270;
    const margin = { top: 18, right: 24, bottom: 28, left: 54 };
    const innerW = width - margin.left - margin.right;
    const innerH = height - margin.top - margin.bottom;

    const svg = d3.select(svgEl);
    svg.selectAll('*').remove();

    const g = svg
      .append('g')
      .attr('transform', `translate(${margin.left},${margin.top})`);

    let xDomain: [number, number];
    let yDomain: [number, number];

    if (plane === 'z') {
      const maxCoord = Math.max(
        1.25,
        ...allMarkers.map((p) => Math.max(Math.abs(p.re), Math.abs(p.im)) * 1.2)
      );
      const halfSpanY = maxCoord;
      const aspect = innerW / innerH;
      const halfSpanX = halfSpanY * aspect;
      xDomain = [-halfSpanX, halfSpanX];
      yDomain = [-halfSpanY, halfSpanY];
    } else {
      const locusPoints =
        rootLocus && loopMode === 'open'
          ? rootLocus.branches.flatMap((b) => b.points)
          : [];
      const reals = [
        ...allMarkers.map((p) => p.re),
        ...locusPoints.map((p) => p.re),
      ];
      const imags = [
        ...allMarkers.map((p) => p.im),
        ...locusPoints.map((p) => p.im),
      ];
      if (showStabilityHeatmap) {
        reals.push(-1 / Math.max(0.02, maxTimeConstantSec));
      }
      const minRe = Math.min(-2, ...reals, 0);
      const maxRe = Math.max(1, ...reals, 0);
      const spanRe = Math.max(2, maxRe - minRe);
      const padRe = spanRe * 0.14;
      const maxIm = Math.max(1.5, ...imags.map((v) => Math.abs(v)));
      const padIm = maxIm * 0.18;
      xDomain = [minRe - padRe, maxRe + padRe];
      yDomain = [-(maxIm + padIm), maxIm + padIm];
    }

    const xScale = d3.scaleLinear().domain(xDomain).range([0, innerW]);
    const yScale = d3.scaleLinear().domain(yDomain).range([innerH, 0]);
    scalesRef.current = { xScale, yScale, innerW, innerH };

    const activeHeatmap =
      plane === 's' && showStabilityHeatmap
        ? computeSPlaneStabilityHeatmap(model, xDomain, yDomain, {
            scope: loopMode,
            gainScale,
            maxTimeConstantSec,
            minDampingRatio,
            cols: 44,
            rows: 26,
          })
        : null;

    // Interactive Stability Margin Heatmap Layer (rendered underneath grid & poles)
    if (activeHeatmap) {
      const cellW = innerW / activeHeatmap.cols;
      const cellH = innerH / activeHeatmap.rows;

      const colorForScore = (score: number, inRegion: boolean): string => {
        if (score >= 0) {
          if (inRegion) {
            return d3.interpolateRgb('#0891B2', '#10B981')(Math.min(1, score));
          }
          return d3.interpolateRgb('#B45309', '#06B6D4')(Math.min(1, score * 1.4));
        }
        return d3.interpolateRgb('#D97706', '#9F1239')(Math.min(1, Math.abs(score)));
      };

      const heatGroup = g.append('g').attr('class', 'pz-stability-heatmap');
      heatGroup
        .selectAll('rect')
        .data(activeHeatmap.cells)
        .join('rect')
        .attr('x', (_, idx) => (idx % activeHeatmap.cols) * cellW)
        .attr('y', (_, idx) => Math.floor(idx / activeHeatmap.cols) * cellH)
        .attr('width', cellW + 0.6)
        .attr('height', cellH + 0.6)
        .attr('fill', (d) => colorForScore(d.marginScore, d.inStableRegion))
        .attr('fill-opacity', (d) =>
          d.inStableRegion
            ? 0.22 + 0.34 * Math.max(0, d.marginScore)
            : 0.14 + 0.28 * Math.min(1, Math.abs(d.marginScore))
        );
    }

    // Grid lines
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
      .attr('stroke', '#1E293B')
      .attr('stroke-width', 1);

    const originX = xScale(0);
    const originY = yScale(0);

    // Stability regions & boundaries
    if (plane === 's') {
      if (originX < innerW) {
        g.append('rect')
          .attr('x', Math.max(0, originX))
          .attr('y', 0)
          .attr('width', Math.max(0, innerW - Math.max(0, originX)))
          .attr('height', innerH)
          .attr('fill', '#F43F5E')
          .attr('fill-opacity', 0.055);
      }

      // Constant damping guide rays (zeta = 0.5, 0.707) from origin into LHP
      for (const zeta of [0.5, 0.707]) {
        const angle = Math.acos(zeta);
        const rayLen = Math.max(Math.abs(xDomain[0]), yDomain[1]) * 1.4;
        const endRe = -rayLen * Math.cos(angle);
        const endIm = rayLen * Math.sin(angle);
        for (const sgn of [1, -1]) {
          g.append('line')
            .attr('x1', originX)
            .attr('y1', originY)
            .attr('x2', xScale(endRe))
            .attr('y2', yScale(sgn * endIm))
            .attr('stroke', '#334155')
            .attr('stroke-dasharray', '2 4')
            .attr('stroke-opacity', 0.6)
            .attr('stroke-width', 1);
        }
      }

      // Real & Imaginary axes
      g.append('line')
        .attr('x1', 0)
        .attr('x2', innerW)
        .attr('y1', originY)
        .attr('y2', originY)
        .attr('stroke', '#475569')
        .attr('stroke-width', 1);

      g.append('line')
        .attr('x1', originX)
        .attr('x2', originX)
        .attr('y1', 0)
        .attr('y2', innerH)
        .attr('stroke', '#F43F5E')
        .attr('stroke-opacity', 0.65)
        .attr('stroke-dasharray', '4 3')
        .attr('stroke-width', 1.2);

      g.append('text')
        .attr('x', Math.min(innerW - 6, Math.max(6, originX + 6)))
        .attr('y', 12)
        .attr('fill', '#FDA4AF')
        .attr('font-size', '9px')
        .attr('font-family', 'IBM Plex Mono, monospace')
        .text('RHP Unstable (Re > 0)');

      // Target Time-Constant & Minimum Damping Spec Boundaries when Heatmap Active
      if (showStabilityHeatmap) {
        const sigmaReq = -1 / Math.max(0.02, maxTimeConstantSec);
        const xTau = xScale(sigmaReq);
        if (xTau >= 0 && xTau <= innerW) {
          g.append('line')
            .attr('x1', xTau)
            .attr('x2', xTau)
            .attr('y1', 0)
            .attr('y2', innerH)
            .attr('stroke', '#34D399')
            .attr('stroke-opacity', 0.85)
            .attr('stroke-dasharray', '5 3')
            .attr('stroke-width', 1.4);

          g.append('text')
            .attr('x', Math.max(6, xTau - 6))
            .attr('y', innerH - 6)
            .attr('text-anchor', 'end')
            .attr('fill', '#6EE7B7')
            .attr('font-size', '9px')
            .attr('font-family', 'IBM Plex Mono, monospace')
            .text(`τ≤${maxTimeConstantSec.toFixed(2)}s (σ=${sigmaReq.toFixed(2)})`);
        }

        if (minDampingRatio > 0.01 && minDampingRatio < 0.99) {
          const dampAngle = Math.acos(minDampingRatio);
          const rayLen = Math.max(Math.abs(xDomain[0]), yDomain[1]) * 1.4;
          const endRe = -rayLen * Math.cos(dampAngle);
          const endIm = rayLen * Math.sin(dampAngle);
          for (const sgn of [1, -1]) {
            g.append('line')
              .attr('x1', originX)
              .attr('y1', originY)
              .attr('x2', xScale(endRe))
              .attr('y2', yScale(sgn * endIm))
              .attr('stroke', '#22D3EE')
              .attr('stroke-opacity', 0.65)
              .attr('stroke-dasharray', '3 3')
              .attr('stroke-width', 1.2);
          }
        }
      }
    } else {
      // z-plane axes + unit circle
      g.append('line')
        .attr('x1', 0)
        .attr('x2', innerW)
        .attr('y1', originY)
        .attr('y2', originY)
        .attr('stroke', '#475569')
        .attr('stroke-width', 1);
      g.append('line')
        .attr('x1', originX)
        .attr('x2', originX)
        .attr('y1', 0)
        .attr('y2', innerH)
        .attr('stroke', '#475569')
        .attr('stroke-width', 1);

      const rx = Math.abs(xScale(1) - originX);
      const ry = Math.abs(yScale(1) - originY);
      g.append('ellipse')
        .attr('cx', originX)
        .attr('cy', originY)
        .attr('rx', rx)
        .attr('ry', ry)
        .attr('fill', '#06B6D4')
        .attr('fill-opacity', 0.04)
        .attr('stroke', '#10B981')
        .attr('stroke-opacity', 0.65)
        .attr('stroke-dasharray', '4 3')
        .attr('stroke-width', 1.3);

      g.append('text')
        .attr('x', originX + rx + 6)
        .attr('y', originY - 6)
        .attr('fill', '#6EE7B7')
        .attr('font-size', '9px')
        .attr('font-family', 'IBM Plex Mono, monospace')
        .text('|z| = 1 Unit Circle');
    }

    // Overlay Root Locus trajectories (when active on s-plane)
    const activeLocusBranches =
      plane === 's' && loopMode === 'open' && rootLocus ? rootLocus.branches : [];
    if (activeLocusBranches.length > 0) {
      const lineGen = d3
        .line<RootLocusPoint>()
        .x((d) => xScale(d.re))
        .y((d) => yScale(d.im));

      activeLocusBranches.forEach((branch, idx) => {
        if (branch.points.length < 2) return;
        const color = LOCUS_BRANCH_COLORS[idx % LOCUS_BRANCH_COLORS.length];
        g.append('path')
          .datum(branch.points)
          .attr('fill', 'none')
          .attr('stroke', color)
          .attr('stroke-opacity', 0.8)
          .attr('stroke-width', 1.75)
          .attr('d', lineGen);

        // Endpoint arrow dot at K_max
        const endPt = branch.points[branch.points.length - 1];
        g.append('circle')
          .attr('cx', xScale(endPt.re))
          .attr('cy', yScale(endPt.im))
          .attr('r', 2.4)
          .attr('fill', color)
          .attr('fill-opacity', 0.9);
      });
    }

    // Subtle open-loop baseline pole ghosts when inspecting Closed-Loop shift
    if (plane === 's' && loopMode === 'closed') {
      for (const p of analysis.openLoopPoles) {
        const cx = xScale(p.re);
        const cy = yScale(p.im);
        if (cx < 0 || cx > innerW || cy < 0 || cy > innerH) continue;
        const r = 3.6;
        g.append('line')
          .attr('x1', cx - r)
          .attr('y1', cy - r)
          .attr('x2', cx + r)
          .attr('y2', cy + r)
          .attr('stroke', '#64748B')
          .attr('stroke-opacity', 0.45)
          .attr('stroke-width', 1.4);
        g.append('line')
          .attr('x1', cx - r)
          .attr('y1', cy + r)
          .attr('x2', cx + r)
          .attr('y2', cy - r)
          .attr('stroke', '#64748B')
          .attr('stroke-opacity', 0.45)
          .attr('stroke-width', 1.4);
      }
    }

    // Plot Zeros (O)
    for (const z of activeZeros) {
      const cx = xScale(z.re);
      const cy = yScale(z.im);
      const zeroColor = z.source === 'pid' ? '#A78BFA' : '#F59E0B';
      g.append('circle')
        .attr('cx', cx)
        .attr('cy', cy)
        .attr('r', 5)
        .attr('fill', 'none')
        .attr('stroke', zeroColor)
        .attr('stroke-width', 1.8);
    }

    // Plot Poles (X)
    for (const p of activePoles) {
      const cx = xScale(p.re);
      const cy = yScale(p.im);
      const color = p.stable ? '#06B6D4' : p.marginal ? '#F59E0B' : '#F43F5E';
      const r = 4.8;

      g.append('line')
        .attr('x1', cx - r)
        .attr('y1', cy - r)
        .attr('x2', cx + r)
        .attr('y2', cy + r)
        .attr('stroke', color)
        .attr('stroke-width', 2);
      g.append('line')
        .attr('x1', cx - r)
        .attr('y1', cy + r)
        .attr('x2', cx + r)
        .attr('y2', cy - r)
        .attr('stroke', color)
        .attr('stroke-width', 2);
    }

    // Plot Scaled Controller Poles (diamonds) when Gain Multiplier != 1.0 under Stability Margin overlay
    if (
      plane === 's' &&
      showStabilityHeatmap &&
      loopMode === 'closed' &&
      Math.abs(gainScale - 1.0) > 1e-3
    ) {
      const scaledStats = computeSPlaneStabilityHeatmap(model, xDomain, yDomain, {
        scope: 'closed',
        gainScale,
        maxTimeConstantSec,
        minDampingRatio,
        cols: 4,
        rows: 4,
      });
      for (const sp of scaledStats.scaledPoles) {
        const cx = xScale(sp.re);
        const cy = yScale(sp.im);
        if (cx < -10 || cx > innerW + 10 || cy < -10 || cy > innerH + 10) continue;
        const fill = sp.re < -1e-6 ? '#34D399' : '#FB7185';
        g.append('path')
          .attr('d', `M ${cx} ${cy - 5} L ${cx + 5} ${cy} L ${cx} ${cy + 5} L ${cx - 5} ${cy} Z`)
          .attr('fill', fill)
          .attr('stroke', '#07090E')
          .attr('stroke-width', 1.2);
      }
    }

    // Axes ticks
    const xAxis = d3.axisBottom(xScale).ticks(7).tickSizeOuter(0);
    const yAxis = d3.axisLeft(yScale).ticks(5).tickSizeOuter(0);

    g.append('g')
      .attr('transform', `translate(0,${innerH})`)
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
      .text(plane === 's' ? 'Im(s) vs Re(s)' : 'Im(z) vs Re(z)');

    // Dedicated lightweight hover overlay layer
    g.append('g').attr('class', 'pz-hover-overlay').style('pointer-events', 'none');

    // Pointer hover target
    const locusPtsForHover =
      plane === 's' && loopMode === 'open' && rootLocus
        ? rootLocus.branches.flatMap((b) => b.points)
        : [];

    g.append('rect')
      .attr('width', innerW)
      .attr('height', innerH)
      .attr('fill', 'transparent')
      .style('cursor', 'crosshair')
      .on('pointermove', (event: PointerEvent) => {
        const [mx, my] = d3.pointer(event);
        let best: ComplexPoleZero | null = null;
        let bestDist = Infinity;
        for (const item of allMarkers) {
          const dx = xScale(item.re) - mx;
          const dy = yScale(item.im) - my;
          const dist = Math.hypot(dx, dy);
          if (dist < bestDist && dist < 30) {
            bestDist = dist;
            best = item;
          }
        }
        if (best) {
          setHovered(best);
          setHoveredLocus(null);
          setHoveredCell(null);
          return;
        }
        setHovered(null);

        if (locusPtsForHover.length > 0) {
          let bestLocus: RootLocusPoint | null = null;
          let bestLocusDist = Infinity;
          for (const pt of locusPtsForHover) {
            const dx = xScale(pt.re) - mx;
            const dy = yScale(pt.im) - my;
            const dist = Math.hypot(dx, dy);
            if (dist < bestLocusDist && dist < 24) {
              bestLocusDist = dist;
              bestLocus = pt;
            }
          }
          setHoveredLocus(bestLocus);
          if (bestLocus) {
            setHoveredCell(null);
            return;
          }
        } else {
          setHoveredLocus(null);
        }

        if (activeHeatmap) {
          const re = xScale.invert(mx);
          const im = yScale.invert(my);
          let nearestCell: SPlaneHeatmapCell | null = null;
          let nearestDist = Infinity;
          for (const cell of activeHeatmap.cells) {
            const d = Math.hypot(cell.re - re, cell.im - im);
            if (d < nearestDist) {
              nearestDist = d;
              nearestCell = cell;
            }
          }
          setHoveredCell(nearestCell);
        } else {
          setHoveredCell(null);
        }
      })
      .on('pointerleave', () => {
        setHovered(null);
        setHoveredLocus(null);
        setHoveredCell(null);
      });
  }, [
    plane,
    loopMode,
    allMarkers,
    activePoles,
    activeZeros,
    analysis.openLoopPoles,
    rootLocus,
    showStabilityHeatmap,
    gainScale,
    maxTimeConstantSec,
    minDampingRatio,
    model,
  ]);

  // Lightweight hover ring + crosshair overlay update without tearing down the SVG
  useEffect(() => {
    const svgEl = svgRef.current;
    const scales = scalesRef.current;
    if (!svgEl || !scales) return;

    const overlay = d3.select(svgEl).select<SVGGElement>('.pz-hover-overlay');
    if (overlay.empty()) return;
    overlay.selectAll('*').remove();

    const target = hovered ?? (hoveredLocus ? { re: hoveredLocus.re, im: hoveredLocus.im } : null);
    if (!target) return;

    const cx = scales.xScale(target.re);
    const cy = scales.yScale(target.im);
    const color = hovered
      ? hovered.kind === 'zero'
        ? hovered.source === 'pid'
          ? '#A78BFA'
          : '#F59E0B'
        : hovered.stable
        ? '#06B6D4'
        : hovered.marginal
        ? '#F59E0B'
        : '#F43F5E'
      : '#38BDF8';

    overlay
      .append('line')
      .attr('x1', cx)
      .attr('x2', cx)
      .attr('y1', 0)
      .attr('y2', scales.innerH)
      .attr('stroke', color)
      .attr('stroke-opacity', 0.28)
      .attr('stroke-dasharray', '2 3')
      .attr('stroke-width', 1);

    overlay
      .append('line')
      .attr('x1', 0)
      .attr('x2', scales.innerW)
      .attr('y1', cy)
      .attr('y2', cy)
      .attr('stroke', color)
      .attr('stroke-opacity', 0.28)
      .attr('stroke-dasharray', '2 3')
      .attr('stroke-width', 1);

    overlay
      .append('circle')
      .attr('cx', cx)
      .attr('cy', cy)
      .attr('r', hovered ? 10 : 6.5)
      .attr('fill', color)
      .attr('fill-opacity', 0.16)
      .attr('stroke', color)
      .attr('stroke-width', 1.2);
  }, [hovered, hoveredLocus]);

  const formatComplex = (p: ComplexPoleZero) => {
    const sign = p.im >= 0 ? '+' : '-';
    return Math.abs(p.im) < 1e-6
      ? p.re.toFixed(4)
      : `${p.re.toFixed(3)} ${sign} j${Math.abs(p.im).toFixed(3)}`;
  };

  return (
    <div className="flex flex-col bg-[#07090E] border-t border-slate-800">
      {/* Toolbar */}
      <div className="px-5 py-2.5 border-b border-slate-800 bg-[#0F141E] flex flex-wrap items-center justify-between gap-4">
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-xs font-semibold text-slate-200">
            Pole-Zero Map &amp; Eigenvalues (D3.js)
          </span>

          {/* s-Plane vs z-Plane */}
          <div className="flex items-center gap-1 p-0.5 bg-[#07090E] border border-slate-800 rounded">
            <button
              type="button"
              onClick={() => setPlane('s')}
              className={`px-2.5 py-1 text-[11px] font-mono rounded transition-colors cursor-pointer whitespace-nowrap ${
                plane === 's'
                  ? 'bg-slate-800 text-cyan-300'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              s-Plane (Cont.)
            </button>
            <button
              type="button"
              onClick={() => setPlane('z')}
              className={`px-2.5 py-1 text-[11px] font-mono rounded transition-colors cursor-pointer whitespace-nowrap ${
                plane === 'z'
                  ? 'bg-slate-800 text-cyan-300'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              z-Plane (Disc.)
            </button>
          </div>

          {plane === 's' && (
            <div className="flex items-center gap-1 p-0.5 bg-[#07090E] border border-slate-800 rounded">
              <button
                type="button"
                onClick={() => setLoopMode('open')}
                className={`px-2.5 py-1 text-[11px] font-mono rounded transition-colors cursor-pointer whitespace-nowrap ${
                  loopMode === 'open'
                    ? 'bg-slate-800 text-amber-300'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                Open-Loop λ(A)
              </button>
              <button
                type="button"
                onClick={() => setLoopMode('closed')}
                className={`px-2.5 py-1 text-[11px] font-mono rounded transition-colors cursor-pointer whitespace-nowrap ${
                  loopMode === 'closed'
                    ? 'bg-slate-800 text-emerald-300'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                Closed-Loop λ(Acl)
              </button>
            </div>
          )}

          {plane === 's' && loopMode === 'open' && model.plant.m > 1 && (
            <select
              aria-label="Select zero channel input"
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
          {plane === 's' && loopMode === 'open' && model.plant.p > 1 && (
            <select
              aria-label="Select zero channel output"
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

          <button
            type="button"
            aria-pressed={showStabilityHeatmap && plane === 's'}
            onClick={() => {
              const next = !showStabilityHeatmap;
              setShowStabilityHeatmap(next);
              if (next) {
                setPlane('s');
                setLoopMode('closed');
              }
            }}
            className={`px-2.5 py-1 text-[11px] font-mono rounded border transition-colors cursor-pointer whitespace-nowrap shrink-0 ${
              showStabilityHeatmap && plane === 's'
                ? 'border-emerald-500/50 bg-emerald-500/15 text-emerald-300'
                : 'border-slate-700 bg-[#07090E] text-slate-300 hover:border-slate-600 hover:text-slate-100'
            }`}
          >
            Stability Margin
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-4 text-xs font-mono tabular-nums">
          <span
            className={
              activeVerdict === 'STABLE'
                ? 'text-emerald-400'
                : activeVerdict === 'MARGINAL'
                ? 'text-amber-300'
                : 'text-rose-400'
            }
          >
            {activeVerdict === 'STABLE'
              ? plane === 's'
                ? '● LHP Stable'
                : '● Unit-Circle Stable'
              : activeVerdict === 'MARGINAL'
              ? '▲ Marginal Boundary'
              : plane === 's'
              ? '✖ RHP Unstable'
              : '✖ |z| > 1 Unstable'}
          </span>

          {hovered ? (
            <span className="text-[11px] text-slate-200 pl-3 border-l border-slate-800">
              {hovered.kind === 'pole'
                ? 'Pole'
                : hovered.source === 'pid'
                ? 'PID Zero'
                : 'Plant Zero'}
              : {formatComplex(hovered)}
              {plane === 's' && hovered.dampingRatio !== null
                ? ` · ζ=${hovered.dampingRatio.toFixed(3)} · ωn=${hovered.naturalFreqRad.toFixed(2)}`
                : ` · |z|=${hovered.mag.toFixed(5)}`}
            </span>
          ) : hoveredLocus ? (
            <span className="text-[11px] text-sky-300 pl-3 border-l border-slate-800">
              Locus (K={hoveredLocus.k < 10 ? hoveredLocus.k.toFixed(2) : hoveredLocus.k.toFixed(1)}):{' '}
              {Math.abs(hoveredLocus.im) < 1e-5
                ? hoveredLocus.re.toFixed(3)
                : `${hoveredLocus.re.toFixed(3)} ${hoveredLocus.im >= 0 ? '+' : '-'} j${Math.abs(hoveredLocus.im).toFixed(3)}`}
            </span>
          ) : (
            hoveredCell &&
            showStabilityHeatmap &&
            plane === 's' && (
              <span className="text-[11px] text-slate-200 pl-3 border-l border-slate-800">
                s={hoveredCell.re.toFixed(2)}
                {hoveredCell.im >= 0 ? '+' : '-'}j{Math.abs(hoveredCell.im).toFixed(2)} · τ=
                {hoveredCell.timeConstantSec !== null
                  ? `${hoveredCell.timeConstantSec.toFixed(2)}s`
                  : '∞'}{' '}
                · ζ={hoveredCell.dampingRatio.toFixed(2)} · Margin{' '}
                <span
                  className={
                    hoveredCell.inStableRegion
                      ? 'text-emerald-400'
                      : hoveredCell.re < 0
                      ? 'text-amber-300'
                      : 'text-rose-400'
                  }
                >
                  {(hoveredCell.marginScore * 100).toFixed(0)}%
                </span>
              </span>
            )
          )}

          {rootLocus && rootLocus.branches.length > 0 && onClearRootLocus && (
            <button
              type="button"
              onClick={onClearRootLocus}
              className="px-2 py-0.5 text-[10px] font-mono border border-slate-700 bg-[#07090E] hover:bg-slate-800 text-slate-300 rounded transition-colors cursor-pointer"
            >
              Clear Locus
            </button>
          )}
        </div>
      </div>

      {/* Interactive Stability Margin Heatmap Controls */}
      {showStabilityHeatmap && plane === 's' && heatmapSummary && (
        <div
          aria-label="Stability Margin s-plane parameter controls"
          className="px-5 py-2 border-b border-slate-800 bg-[#0B0E17] flex flex-wrap items-center justify-between gap-4 text-[11px] font-mono tabular-nums"
        >
          <div className="flex flex-wrap items-center gap-4">
            <label className="flex items-center gap-2 text-slate-300">
              <span className="text-slate-400 whitespace-nowrap">Gain Scale K/K₀</span>
              <input
                aria-label="Gain scale multiplier"
                type="range"
                min={0.1}
                max={4.0}
                step={0.05}
                value={gainScale}
                onChange={(e) => setGainScale(Number(e.target.value))}
                className="w-24 h-1.5 bg-slate-800 rounded accent-emerald-400 cursor-pointer"
              />
              <span className="text-emerald-300 w-10 text-right">
                {gainScale.toFixed(2)}×
              </span>
              {Math.abs(gainScale - 1.0) > 1e-3 && (
                <button
                  type="button"
                  onClick={() => setGainScale(1.0)}
                  className="px-1.5 py-0.5 text-[10px] border border-slate-700 rounded text-slate-400 hover:text-slate-200 cursor-pointer"
                >
                  1×
                </button>
              )}
            </label>

            <label className="flex items-center gap-2 text-slate-300">
              <span className="text-slate-400 whitespace-nowrap">Target τ_max</span>
              <input
                aria-label="Target maximum time constant tau"
                type="range"
                min={0.05}
                max={3.0}
                step={0.05}
                value={maxTimeConstantSec}
                onChange={(e) => setMaxTimeConstantSec(Number(e.target.value))}
                className="w-24 h-1.5 bg-slate-800 rounded accent-cyan-400 cursor-pointer"
              />
              <span className="text-cyan-300 w-11 text-right">
                {maxTimeConstantSec.toFixed(2)}s
              </span>
            </label>

            <div className="flex items-center gap-1">
              <span className="text-slate-400 mr-1">Min ζ</span>
              {[0, 0.2, 0.5, 0.707].map((zetaVal) => (
                <button
                  key={zetaVal}
                  type="button"
                  onClick={() => setMinDampingRatio(zetaVal)}
                  className={`px-1.5 py-0.5 text-[10px] rounded border transition-colors cursor-pointer ${
                    Math.abs(minDampingRatio - zetaVal) < 0.01
                      ? 'border-cyan-500/50 bg-cyan-500/15 text-cyan-200'
                      : 'border-slate-800 bg-[#07090E] text-slate-400 hover:text-slate-200'
                  }`}
                >
                  {zetaVal}
                </button>
              ))}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-3 text-[10.5px]">
            <span className="text-slate-400">
              Stable Gain K:{' '}
              <span className="text-emerald-300 font-semibold">
                {heatmapSummary.stableGainRange.min !== null &&
                heatmapSummary.stableGainRange.max !== null
                  ? `[${heatmapSummary.stableGainRange.min.toFixed(2)}×, ${heatmapSummary.stableGainRange.max.toFixed(2)}×]`
                  : 'None in [0.05×, 8×]'}
              </span>
            </span>
            <span className="text-slate-600" aria-hidden="true">
              ·
            </span>
            <span className="text-slate-400">
              Dom τ:{' '}
              <span
                className={
                  heatmapSummary.meetsTimeConstantSpec
                    ? 'text-emerald-300 font-semibold'
                    : heatmapSummary.activeSystemStable
                    ? 'text-amber-300 font-semibold'
                    : 'text-rose-400 font-semibold'
                }
              >
                {heatmapSummary.dominantTimeConstantSec !== null
                  ? `${heatmapSummary.dominantTimeConstantSec.toFixed(3)}s`
                  : 'Unstable'}
              </span>
            </span>
          </div>
        </div>
      )}

      {/* Complex Plane Legend */}
      <div className="px-5 pt-2.5 flex flex-wrap items-center justify-between gap-3 text-[10px] font-mono text-slate-400">
        <div className="flex flex-wrap items-center gap-4">
          <span className="inline-flex items-center gap-1.5">
            <span className="text-cyan-400 font-bold">×</span>
            <span>Stable Pole ({plane === 's' ? 'LHP' : '|z| < 1'})</span>
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="text-amber-400 font-bold">×</span>
            <span>Marginal</span>
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="text-rose-400 font-bold">×</span>
            <span>Unstable ({plane === 's' ? 'RHP' : '|z| > 1'})</span>
          </span>
          {plane === 's' && loopMode === 'closed' && (
            <span className="inline-flex items-center gap-1.5">
              <span className="text-slate-500 font-bold">×</span>
              <span>Open-Loop Ref</span>
            </span>
          )}
          {plane === 's' && (
            <span className="inline-flex items-center gap-1.5">
              <span className="text-amber-300 font-bold">○</span>
              <span>Plant Zero</span>
            </span>
          )}
          {plane === 's' && loopMode === 'closed' && analysis.pidZeros.length > 0 && (
            <span className="inline-flex items-center gap-1.5">
              <span className="text-violet-400 font-bold">○</span>
              <span>PID Zero</span>
            </span>
          )}
          {plane === 's' && loopMode === 'open' && rootLocus && rootLocus.branches.length > 0 && (
            <span className="inline-flex items-center gap-1.5">
              <span className="text-sky-400 font-bold">—</span>
              <span>
                Root Locus (K ∈ [0, {rootLocus.kMax.toFixed(0)}])
              </span>
            </span>
          )}
        </div>
        {plane === 's' && (
          <span className="text-slate-500">Dashed rays: ζ = 0.5, 0.707</span>
        )}
      </div>

      {/* Complex Plane Plot */}
      <div className="px-3 py-1">
        <svg
          ref={svgRef}
          viewBox="0 0 760 270"
          aria-label="Interactive Pole-Zero Map on Complex Plane"
          className="w-full h-[270px] select-none"
        />
      </div>

      {/* Heatmap Color Scale Legend */}
      {showStabilityHeatmap && plane === 's' && (
        <div className="px-5 pb-2.5 flex flex-wrap items-center justify-between gap-3 text-[10px] font-mono text-slate-400">
          <div className="flex items-center gap-2">
            <span className="text-rose-400">−100% Unstable (RHP)</span>
            <div
              aria-hidden="true"
              className="w-36 h-2 rounded-sm border border-slate-800"
              style={{
                background:
                  'linear-gradient(90deg, #9F1239 0%, #F43F5E 28%, #D97706 48%, #0891B2 68%, #10B981 100%)',
              }}
            />
            <span className="text-emerald-400">+100% Stable Region (τ ≤ τ_max)</span>
          </div>
          <span className="text-slate-500">
            Hover any s-plane coordinate for local time constant τ = −1/σ &amp; margin
          </span>
        </div>
      )}

      {/* Eigenvalue & Zero Table */}
      <div className="px-5 pb-4">
        <div className="rounded border border-slate-800 bg-[#0B0E17] overflow-hidden">
          <table className="w-full text-left text-[11px] font-mono tabular-nums">
            <thead className="bg-[#0F141E] text-slate-400 border-b border-slate-800">
              <tr>
                <th className="py-1.5 px-3 font-medium">Type</th>
                <th className="py-1.5 px-3 font-medium">Coordinate</th>
                <th className="py-1.5 px-3 font-medium text-right">
                  {plane === 's' ? 'ωn (rad/s)' : '|z|'}
                </th>
                <th className="py-1.5 px-3 font-medium text-right">
                  {plane === 's' ? 'Damping ζ' : 'Angle (deg)'}
                </th>
                <th className="py-1.5 px-3 font-medium text-right">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60">
              {activePoles.map((p, idx) => (
                <tr
                  key={`p-${idx}`}
                  onMouseEnter={() => setHovered(p)}
                  onMouseLeave={() => setHovered(null)}
                  className={`transition-colors cursor-crosshair ${
                    hovered === p ? 'bg-slate-800/70' : 'hover:bg-slate-900/50'
                  }`}
                >
                  <td className="py-1.5 px-3 text-cyan-300">× Pole p{idx + 1}</td>
                  <td className="py-1.5 px-3 text-slate-200">{formatComplex(p)}</td>
                  <td className="py-1.5 px-3 text-right text-slate-300">
                    {plane === 's' ? p.naturalFreqRad.toFixed(3) : p.mag.toFixed(5)}
                  </td>
                  <td className="py-1.5 px-3 text-right text-slate-300">
                    {plane === 's'
                      ? p.dampingRatio !== null
                        ? p.dampingRatio.toFixed(3)
                        : '—'
                      : `${((Math.atan2(p.im, p.re) * 180) / Math.PI).toFixed(1)}°`}
                  </td>
                  <td
                    className={`py-1.5 px-3 text-right ${
                      p.stable
                        ? 'text-emerald-400'
                        : p.marginal
                        ? 'text-amber-300'
                        : 'text-rose-400'
                    }`}
                  >
                    {p.stable
                      ? plane === 's'
                        ? '● LHP'
                        : '● |z|<1'
                      : p.marginal
                      ? '▲ Margin'
                      : plane === 's'
                      ? '✖ RHP'
                      : '✖ |z|>1'}
                  </td>
                </tr>
              ))}
              {activeZeros.map((z, idx) => (
                <tr
                  key={`z-${idx}`}
                  onMouseEnter={() => setHovered(z)}
                  onMouseLeave={() => setHovered(null)}
                  className={`transition-colors cursor-crosshair ${
                    hovered === z ? 'bg-slate-800/70' : 'hover:bg-slate-900/50'
                  }`}
                >
                  <td
                    className={`py-1.5 px-3 ${
                      z.source === 'pid' ? 'text-violet-300' : 'text-amber-300'
                    }`}
                  >
                    ○ {z.source === 'pid' ? 'PID Zero' : 'Plant Zero'} z{idx + 1}
                  </td>
                  <td className="py-1.5 px-3 text-slate-200">{formatComplex(z)}</td>
                  <td className="py-1.5 px-3 text-right text-slate-300">
                    {z.naturalFreqRad.toFixed(3)}
                  </td>
                  <td className="py-1.5 px-3 text-right text-slate-300">
                    {z.dampingRatio !== null ? z.dampingRatio.toFixed(3) : '—'}
                  </td>
                  <td className="py-1.5 px-3 text-right text-slate-400">
                    {z.re < 0 ? 'Minimum-Phase' : z.re > 0 ? 'Non-Min-Phase' : 'Origin/Imag'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};
