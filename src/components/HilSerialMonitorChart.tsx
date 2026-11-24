import React, { useEffect, useMemo, useRef, useState } from 'react';
import * as d3 from 'd3';
import {
  Crosshair,
  Grid3x3,
  RotateCcw,
  Terminal,
  Trash2,
} from 'lucide-react';
import { ControlModel, HilFramePacket } from '../types/control';
import {
  analyzeTelemetryChannelWindow,
  computeNominalTelemetryRange,
  computeTelemetryChannelYScale,
  extractTelemetryStripSeries,
  getHilTelemetryChannels,
  isHilCobsEnabled,
  TelemetryChannelId,
  TelemetryChannelYScale,
  TelemetryStripSample,
} from '../engine/hil';

interface HilSerialMonitorChartProps {
  model: ControlModel;
  packets: HilFramePacket[];
  selectedSeq: number;
  onSelectSeq: (seq: number) => void;
  onClearBuffer: () => void;
  windowSize: 32 | 64 | 96;
  onChangeWindowSize: (next: 32 | 64 | 96) => void;
  isStreaming: boolean;
}

type GridMode = 'off' | 'major' | 'fine';
type GridLineStyle = 'solid' | 'dashed';
type GridContrast = 'subtle' | 'crisp';
type CursorMode = 'probe' | 'dual';
type CursorHandle = 'A' | 'B';

function formatMetricCompact(v: number): string {
  if (!Number.isFinite(v)) return '0';
  const abs = Math.abs(v);
  if (abs === 0) return '0.00';
  if (abs >= 100) return v.toFixed(1);
  if (abs >= 10) return v.toFixed(2);
  if (abs >= 1) return v.toFixed(3);
  return v.toFixed(4);
}

function formatSignedMetric(v: number): string {
  const prefix = v > 0 ? '+' : '';
  return `${prefix}${formatMetricCompact(v)}`;
}

export const HilSerialMonitorChart: React.FC<HilSerialMonitorChartProps> = ({
  model,
  packets,
  selectedSeq,
  onSelectSeq,
  onClearBuffer,
  windowSize,
  onChangeWindowSize,
  isStreaming,
}) => {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const draggingCursorRef = useRef<CursorHandle | null>(null);

  const [hoverSample, setHoverSample] = useState<TelemetryStripSample | null>(null);
  const [showSerialLog, setShowSerialLog] = useState<boolean>(true);
  const [enabledChannels, setEnabledChannels] = useState<Record<TelemetryChannelId, boolean>>({
    ref: true,
    y0: true,
    y1: true,
    uCmd: true,
  });

  // Configurable oscilloscope grid overlay state
  const [gridMode, setGridMode] = useState<GridMode>('major');
  const [xDivs, setXDivs] = useState<4 | 8 | 12>(8);
  const [yDivs, setYDivs] = useState<2 | 4 | 6>(4);
  const [gridLineStyle, setGridLineStyle] = useState<GridLineStyle>('solid');
  const [gridContrast, setGridContrast] = useState<GridContrast>('subtle');
  const [showPeakMarkers, setShowPeakMarkers] = useState<boolean>(true);

  // Dynamic peak-to-peak Y-axis auto-scale toggle & manual range lock
  const [autoScaleY, setAutoScaleY] = useState<boolean>(true);
  const [lockedYRanges, setLockedYRanges] = useState<
    Record<TelemetryChannelId, { min: number; max: number }> | null
  >(null);

  // Cursor-based peak & delta measurement tool state
  const [cursorMode, setCursorMode] = useState<CursorMode>('dual');
  const [activeCursorHandle, setActiveCursorHandle] = useState<CursorHandle>('A');
  const [measureChannel, setMeasureChannel] = useState<TelemetryChannelId>('y0');
  const [cursorASeq, setCursorASeq] = useState<number | null>(null);
  const [cursorBSeq, setCursorBSeq] = useState<number | null>(null);

  const channels = useMemo(() => getHilTelemetryChannels(model), [model]);
  const visibleChannels = useMemo(
    () => channels.filter((ch) => enabledChannels[ch.id]),
    [channels, enabledChannels]
  );

  // Ensure the focused measurement channel stays synced to an enabled strip
  useEffect(() => {
    if (!enabledChannels[measureChannel] && visibleChannels.length > 0) {
      setMeasureChannel(visibleChannels[0].id);
    }
  }, [enabledChannels, measureChannel, visibleChannels]);

  // Reset locked ranges when switching plant models so scale stays calibrated
  useEffect(() => {
    setLockedYRanges(null);
  }, [model.id]);

  const visiblePackets = useMemo(
    () => packets.slice(-windowSize),
    [packets, windowSize]
  );

  const stripSamples = useMemo(
    () => extractTelemetryStripSeries(model, visiblePackets),
    [model, visiblePackets]
  );

  // Default / clamped sequence targets for Cursors A and B
  const resolvedCursorSeqs = useMemo(() => {
    if (stripSamples.length === 0) {
      return { seqA: null as number | null, seqB: null as number | null };
    }
    const defaultAIdx = Math.floor((stripSamples.length - 1) * 0.25);
    const defaultBIdx = Math.floor((stripSamples.length - 1) * 0.75);
    const minSeq = stripSamples[0].seq;
    const maxSeq = stripSamples[stripSamples.length - 1].seq;

    const clampOrDefault = (val: number | null, fallbackIdx: number) => {
      if (val === null) return stripSamples[fallbackIdx].seq;
      if (val < minSeq) return minSeq;
      if (val > maxSeq) return maxSeq;
      return val;
    };

    return {
      seqA: clampOrDefault(cursorASeq, defaultAIdx),
      seqB: clampOrDefault(cursorBSeq, defaultBIdx),
    };
  }, [stripSamples, cursorASeq, cursorBSeq]);

  const peakAnalysis = useMemo(
    () =>
      analyzeTelemetryChannelWindow(
        stripSamples,
        measureChannel,
        resolvedCursorSeqs.seqA,
        resolvedCursorSeqs.seqB
      ),
    [stripSamples, measureChannel, resolvedCursorSeqs.seqA, resolvedCursorSeqs.seqB]
  );

  const measureChannelMeta = useMemo(
    () => channels.find((c) => c.id === measureChannel) ?? channels[0],
    [channels, measureChannel]
  );

  // Clear cursor drag state on pointerup anywhere in window
  useEffect(() => {
    const stopDrag = () => {
      draggingCursorRef.current = null;
    };
    window.addEventListener('pointerup', stopDrag);
    return () => window.removeEventListener('pointerup', stopDrag);
  }, []);

  const cobsActive = isHilCobsEnabled(model);
  const laneHeight = visibleChannels.length <= 2 ? 84 : 62;
  const laneGap = 10;
  const marginTop = 22;
  const marginBottom = 24;
  const svgHeight = Math.max(
    120,
    marginTop +
      marginBottom +
      visibleChannels.length * laneHeight +
      Math.max(0, visibleChannels.length - 1) * laneGap
  );

  const toggleChannel = (id: TelemetryChannelId) => {
    setEnabledChannels((prev) => {
      const next = { ...prev, [id]: !prev[id] };
      if (!Object.values(next).some(Boolean)) return prev;
      return next;
    });
  };

  const handleSnapMinMax = () => {
    if (!peakAnalysis.windowMin || !peakAnalysis.windowMax) return;
    setCursorMode('dual');
    if (peakAnalysis.windowMin.seq <= peakAnalysis.windowMax.seq) {
      setCursorASeq(peakAnalysis.windowMin.seq);
      setCursorBSeq(peakAnalysis.windowMax.seq);
    } else {
      setCursorASeq(peakAnalysis.windowMax.seq);
      setCursorBSeq(peakAnalysis.windowMin.seq);
    }
  };

  const handleSnapTopTwoPeaks = () => {
    if (peakAnalysis.localPeaks.length < 2) return;
    const [p1, p2] = peakAnalysis.localPeaks;
    setCursorMode('dual');
    if (p1.seq <= p2.seq) {
      setCursorASeq(p1.seq);
      setCursorBSeq(p2.seq);
    } else {
      setCursorASeq(p2.seq);
      setCursorBSeq(p1.seq);
    }
  };

  const handleResetCursors = () => {
    if (stripSamples.length === 0) return;
    const idxA = Math.floor((stripSamples.length - 1) * 0.25);
    const idxB = Math.floor((stripSamples.length - 1) * 0.75);
    setCursorASeq(stripSamples[idxA].seq);
    setCursorBSeq(stripSamples[idxB].seq);
  };

  // Dynamic peak-to-peak Y scales computed from incoming telemetry signals
  const autoChannelScales = useMemo(() => {
    const out: Record<TelemetryChannelId, TelemetryChannelYScale> = {
      ref: computeTelemetryChannelYScale(stripSamples, 'ref', model, yDivs),
      y0: computeTelemetryChannelYScale(stripSamples, 'y0', model, yDivs),
      y1: computeTelemetryChannelYScale(stripSamples, 'y1', model, yDivs),
      uCmd: computeTelemetryChannelYScale(stripSamples, 'uCmd', model, yDivs),
    };
    return out;
  }, [stripSamples, model, yDivs]);

  // Active Y scale per channel (either dynamic Vpp auto-scale or locked fixed range)
  const channelGridScales = useMemo(() => {
    const ids: TelemetryChannelId[] = ['ref', 'y0', 'y1', 'uCmd'];
    const out = {} as Record<
      TelemetryChannelId,
      TelemetryChannelYScale & { clipped: boolean }
    >;

    for (const id of ids) {
      const auto = autoChannelScales[id];
      const locked = !autoScaleY ? lockedYRanges?.[id] : undefined;
      if (locked && locked.max > locked.min) {
        const clipped =
          stripSamples.length > 0 &&
          (auto.rawMax > locked.max || auto.rawMin < locked.min);
        out[id] = {
          ...auto,
          min: locked.min,
          max: locked.max,
          perDiv: (locked.max - locked.min) / Math.max(1, yDivs),
          clipped,
        };
      } else {
        out[id] = {
          ...auto,
          clipped: false,
        };
      }
    }
    return out;
  }, [autoChannelScales, autoScaleY, lockedYRanges, stripSamples.length, yDivs]);

  const handleToggleAutoScaleY = () => {
    if (autoScaleY) {
      setLockedYRanges({
        ref: { min: autoChannelScales.ref.min, max: autoChannelScales.ref.max },
        y0: { min: autoChannelScales.y0.min, max: autoChannelScales.y0.max },
        y1: { min: autoChannelScales.y1.min, max: autoChannelScales.y1.max },
        uCmd: { min: autoChannelScales.uCmd.min, max: autoChannelScales.uCmd.max },
      });
      setAutoScaleY(false);
    } else {
      setAutoScaleY(true);
    }
  };

  const handleFitVppOnce = () => {
    setLockedYRanges({
      ref: { min: autoChannelScales.ref.min, max: autoChannelScales.ref.max },
      y0: { min: autoChannelScales.y0.min, max: autoChannelScales.y0.max },
      y1: { min: autoChannelScales.y1.min, max: autoChannelScales.y1.max },
      uCmd: { min: autoChannelScales.uCmd.min, max: autoChannelScales.uCmd.max },
    });
  };

  const handleLockNominalRanges = () => {
    setLockedYRanges({
      ref: computeNominalTelemetryRange(model, 'ref'),
      y0: computeNominalTelemetryRange(model, 'y0'),
      y1: computeNominalTelemetryRange(model, 'y1'),
      uCmd: computeNominalTelemetryRange(model, 'uCmd'),
    });
  };

  const timePerDivSec = useMemo(() => {
    if (stripSamples.length < 2) return 0;
    const totalDt =
      stripSamples[stripSamples.length - 1].simTime - stripSamples[0].simTime;
    return Math.max(0, totalDt) / Math.max(1, xDivs);
  }, [stripSamples, xDivs]);

  useEffect(() => {
    if (!svgRef.current) return;
    const svg = d3.select(svgRef.current);
    svg.selectAll('*').remove();

    if (stripSamples.length === 0 || visibleChannels.length === 0) {
      svg
        .append('text')
        .attr('x', 470)
        .attr('y', svgHeight / 2)
        .attr('text-anchor', 'middle')
        .attr('fill', '#64748B')
        .attr('font-size', '11px')
        .attr('font-family', 'IBM Plex Mono, monospace')
        .text('Serial telemetry buffer empty — click Step Frame or Stream Live');
      return;
    }

    const width = 940;
    const margin = { top: marginTop, right: 18, bottom: marginBottom, left: 62 };
    const innerW = width - margin.left - margin.right;

    const minSeq = stripSamples[0].seq;
    const maxSeq = stripSamples[stripSamples.length - 1].seq;
    const xDomain: [number, number] =
      minSeq === maxSeq ? [minSeq - 1, maxSeq + 1] : [minSeq, maxSeq];
    const xScale = d3.scaleLinear().domain(xDomain).range([0, innerW]);

    const root = svg
      .append('g')
      .attr('transform', `translate(${margin.left},${margin.top})`);

    const bisectSeq = d3.bisector<TelemetryStripSample, number>((d) => d.seq).left;
    const latestSample = stripSamples[stripSamples.length - 1];
    const activeSample =
      hoverSample ??
      stripSamples.find((s) => s.seq === selectedSeq) ??
      latestSample;

    const totalTrackHeight =
      visibleChannels.length * laneHeight +
      Math.max(0, visibleChannels.length - 1) * laneGap;

    const majorStrokeColor = gridContrast === 'crisp' ? '#334155' : '#1E293B';
    const majorStrokeOpacity = gridContrast === 'crisp' ? 0.85 : 0.65;
    const minorStrokeColor = gridContrast === 'crisp' ? '#1E293B' : '#141C2B';
    const minorStrokeOpacity = gridContrast === 'crisp' ? 0.75 : 0.55;
    const majorDash = gridLineStyle === 'dashed' ? '3 3' : null;

    const cursorA = peakAnalysis.cursorA;
    const cursorB = peakAnalysis.cursorB;

    const defs = svg.append('defs');

    // Render one synchronized strip lane per enabled telemetry channel
    visibleChannels.forEach((ch, laneIdx) => {
      const yOffset = laneIdx * (laneHeight + laneGap);
      const clipId = `hil-strip-clip-${ch.id}`;
      defs
        .append('clipPath')
        .attr('id', clipId)
        .append('rect')
        .attr('x', 0)
        .attr('y', 0)
        .attr('width', innerW)
        .attr('height', laneHeight);

      const laneG = root
        .append('g')
        .attr('transform', `translate(0,${yOffset})`);

      const laneDom = channelGridScales[ch.id];
      const yScale = d3
        .scaleLinear()
        .domain([laneDom.min, laneDom.max])
        .range([laneHeight, 0]);

      const isMeasureTarget = cursorMode === 'dual' && ch.id === measureChannel;

      // Strip frame background
      laneG
        .append('rect')
        .attr('x', 0)
        .attr('y', 0)
        .attr('width', innerW)
        .attr('height', laneHeight)
        .attr('fill', '#0B0E17')
        .attr('stroke', isMeasureTarget ? '#334155' : '#1E293B')
        .attr('stroke-width', isMeasureTarget ? 1.2 : 1);

      // Dual-cursor interval band inside strip lane
      if (cursorMode === 'dual' && cursorA && cursorB) {
        const ax = xScale(cursorA.seq);
        const bx = xScale(cursorB.seq);
        const bandX = Math.min(ax, bx);
        const bandW = Math.abs(bx - ax);
        if (bandW > 0.5) {
          laneG
            .append('rect')
            .attr('x', bandX)
            .attr('y', 0)
            .attr('width', bandW)
            .attr('height', laneHeight)
            .attr('fill', isMeasureTarget ? '#38BDF8' : '#64748B')
            .attr('fill-opacity', isMeasureTarget ? 0.075 : 0.04);
        }
      }

      // Highlight packet timeouts & SAFE_CLAMP bands inside strip lane
      const seqStepPx =
        stripSamples.length > 1
          ? Math.max(3, innerW / Math.max(1, stripSamples.length - 1))
          : 6;
      stripSamples.forEach((s) => {
        if (s.watchdogState === 'SAFE_CLAMP' || s.dropped) {
          laneG
            .append('rect')
            .attr('x', Math.max(0, xScale(s.seq) - seqStepPx * 0.45))
            .attr('y', 0)
            .attr('width', Math.min(seqStepPx * 0.9, innerW))
            .attr('height', laneHeight)
            .attr(
              'fill',
              s.watchdogState === 'SAFE_CLAMP' ? '#F43F5E' : '#F59E0B'
            )
            .attr('fill-opacity', s.watchdogState === 'SAFE_CLAMP' ? 0.14 : 0.08);
        }
      });

      // Configurable Graticule / Grid Overlay
      if (gridMode !== 'off') {
        // Minor sub-divisions (4 sub-divs per major cell) when Fine mode is selected
        if (gridMode === 'fine') {
          const xMinorCount = xDivs * 4;
          for (let i = 1; i < xMinorCount; i++) {
            if (i % 4 === 0) continue;
            const gx = (i / xMinorCount) * innerW;
            laneG
              .append('line')
              .attr('x1', gx)
              .attr('x2', gx)
              .attr('y1', 0)
              .attr('y2', laneHeight)
              .attr('stroke', minorStrokeColor)
              .attr('stroke-opacity', minorStrokeOpacity)
              .attr('stroke-width', 0.6);
          }

          const yMinorCount = yDivs * 4;
          for (let j = 1; j < yMinorCount; j++) {
            if (j % 4 === 0) continue;
            const gy = (j / yMinorCount) * laneHeight;
            laneG
              .append('line')
              .attr('x1', 0)
              .attr('x2', innerW)
              .attr('y1', gy)
              .attr('y2', gy)
              .attr('stroke', minorStrokeColor)
              .attr('stroke-opacity', minorStrokeOpacity)
              .attr('stroke-width', 0.6);
          }
        }

        // Major vertical time/frame divisions
        for (let i = 1; i < xDivs; i++) {
          const gx = (i / xDivs) * innerW;
          const line = laneG
            .append('line')
            .attr('x1', gx)
            .attr('x2', gx)
            .attr('y1', 0)
            .attr('y2', laneHeight)
            .attr('stroke', majorStrokeColor)
            .attr('stroke-opacity', majorStrokeOpacity)
            .attr('stroke-width', 0.85);
          if (majorDash) line.attr('stroke-dasharray', majorDash);
        }

        // Major horizontal amplitude divisions
        for (let j = 1; j < yDivs; j++) {
          const gy = (j / yDivs) * laneHeight;
          const line = laneG
            .append('line')
            .attr('x1', 0)
            .attr('x2', innerW)
            .attr('y1', gy)
            .attr('y2', gy)
            .attr('stroke', majorStrokeColor)
            .attr('stroke-opacity', majorStrokeOpacity)
            .attr('stroke-width', 0.85);
          if (majorDash) line.attr('stroke-dasharray', majorDash);
        }

        // Center oscilloscope reticle ticks in Fine mode
        if (gridMode === 'fine') {
          const midX = innerW / 2;
          const midY = laneHeight / 2;
          const tickSteps = Math.max(8, xDivs * 2);
          for (let k = 1; k < tickSteps; k++) {
            const tx = (k / tickSteps) * innerW;
            laneG
              .append('line')
              .attr('x1', tx)
              .attr('x2', tx)
              .attr('y1', midY - 2)
              .attr('y2', midY + 2)
              .attr('stroke', '#475569')
              .attr('stroke-opacity', 0.55)
              .attr('stroke-width', 0.7);
          }
          const yTickSteps = Math.max(4, yDivs * 2);
          for (let k = 1; k < yTickSteps; k++) {
            const ty = (k / yTickSteps) * laneHeight;
            laneG
              .append('line')
              .attr('x1', midX - 2.5)
              .attr('x2', midX + 2.5)
              .attr('y1', ty)
              .attr('y2', ty)
              .attr('stroke', '#475569')
              .attr('stroke-opacity', 0.55)
              .attr('stroke-width', 0.7);
          }
        }
      }

      // Zero baseline dashed rule when 0 is within domain
      const [domMin, domMax] = yScale.domain();
      if (domMin <= 0 && domMax >= 0) {
        const y0Px = yScale(0);
        laneG
          .append('line')
          .attr('x1', 0)
          .attr('x2', innerW)
          .attr('y1', y0Px)
          .attr('y2', y0Px)
          .attr('stroke', '#475569')
          .attr('stroke-dasharray', '3 3')
          .attr('stroke-width', 0.9);
      }

      // Left Y axis aligned with configured Y divisions
      const yAxisValues = d3
        .range(0, yDivs + 1)
        .map((idx) => domMin + ((domMax - domMin) * idx) / yDivs);
      const yAxis = d3
        .axisLeft(yScale)
        .tickValues(yAxisValues)
        .tickFormat((v) => formatMetricCompact(Number(v)))
        .tickSizeOuter(0);

      laneG
        .append('g')
        .call(yAxis)
        .call((ax) => ax.selectAll('path, line').attr('stroke', '#334155'))
        .call((ax) =>
          ax
            .selectAll('text')
            .attr('fill', '#64748B')
            .attr('font-size', '9px')
            .attr('font-family', 'IBM Plex Mono, monospace')
        );

      const laneClippedG = laneG
        .append('g')
        .attr('clip-path', `url(#${clipId})`);

      // Subtle translucent area fill
      const baselineVal = domMin <= 0 && domMax >= 0 ? 0 : domMin;
      const areaGen = d3
        .area<TelemetryStripSample>()
        .x((d) => xScale(d.seq))
        .y0(yScale(baselineVal))
        .y1((d) => yScale(d[ch.id]))
        .curve(ch.stepped ? d3.curveStepAfter : d3.curveLinear);

      laneClippedG
        .append('path')
        .datum(stripSamples)
        .attr('fill', ch.color)
        .attr('fill-opacity', 0.1)
        .attr('d', areaGen);

      // Signal trace
      const lineGen = d3
        .line<TelemetryStripSample>()
        .x((d) => xScale(d.seq))
        .y((d) => yScale(d[ch.id]))
        .curve(ch.stepped ? d3.curveStepAfter : d3.curveLinear);

      laneClippedG
        .append('path')
        .datum(stripSamples)
        .attr('fill', 'none')
        .attr('stroke', ch.color)
        .attr('stroke-width', isMeasureTarget ? 1.9 : 1.6)
        .attr('d', lineGen);

      // Horizontal Cursor A & B amplitude calipers on the active measurement channel
      if (isMeasureTarget && cursorA && cursorB) {
        const yAPx = yScale(cursorA[ch.id]);
        const yBPx = yScale(cursorB[ch.id]);

        laneClippedG
          .append('line')
          .attr('x1', 0)
          .attr('x2', innerW)
          .attr('y1', yAPx)
          .attr('y2', yAPx)
          .attr('stroke', '#38BDF8')
          .attr('stroke-opacity', 0.45)
          .attr('stroke-dasharray', '2 3')
          .attr('stroke-width', 0.9);

        laneClippedG
          .append('line')
          .attr('x1', 0)
          .attr('x2', innerW)
          .attr('y1', yBPx)
          .attr('y2', yBPx)
          .attr('stroke', '#C084FC')
          .attr('stroke-opacity', 0.45)
          .attr('stroke-dasharray', '2 3')
          .attr('stroke-width', 0.9);
      }

      // Dropped / SAFE_CLAMP anomaly markers
      laneClippedG
        .selectAll('circle.fault-dot')
        .data(
          stripSamples.filter(
            (s) => s.dropped || s.watchdogState === 'SAFE_CLAMP'
          )
        )
        .join('circle')
        .attr('class', 'fault-dot')
        .attr('cx', (d) => xScale(d.seq))
        .attr('cy', (d) => yScale(d[ch.id]))
        .attr('r', 2.8)
        .attr('fill', '#07090E')
        .attr('stroke', (d) =>
          d.watchdogState === 'SAFE_CLAMP' ? '#F43F5E' : '#F59E0B'
        )
        .attr('stroke-width', 1.4);

      // Peak & Trough Markers (▲ MAX / ▼ MIN)
      if (showPeakMarkers && stripSamples.length >= 2) {
        let laneMinSample = stripSamples[0];
        let laneMaxSample = stripSamples[0];
        for (let i = 1; i < stripSamples.length; i++) {
          const s = stripSamples[i];
          if (s[ch.id] < laneMinSample[ch.id]) laneMinSample = s;
          if (s[ch.id] > laneMaxSample[ch.id]) laneMaxSample = s;
        }

        const maxVal = laneMaxSample[ch.id];
        const minVal = laneMinSample[ch.id];
        if (Math.abs(maxVal - minVal) > 1e-9) {
          const maxX = xScale(laneMaxSample.seq);
          const maxY = yScale(maxVal);
          const minX = xScale(laneMinSample.seq);
          const minY = yScale(minVal);

          // Peak triangle marker ▲
          laneClippedG
            .append('path')
            .attr('d', `M ${maxX} ${maxY - 5} L ${maxX - 3.8} ${maxY + 2} L ${maxX + 3.8} ${maxY + 2} Z`)
            .attr('fill', ch.color)
            .attr('stroke', '#07090E')
            .attr('stroke-width', 0.9);

          const maxAlignEnd = maxX > innerW - 86;
          laneClippedG
            .append('text')
            .attr('x', maxAlignEnd ? maxX - 7 : maxX + 7)
            .attr('y', Math.max(12, Math.min(laneHeight - 4, maxY + 3)))
            .attr('text-anchor', maxAlignEnd ? 'end' : 'start')
            .attr('fill', ch.color)
            .attr('font-size', '9px')
            .attr('font-family', 'IBM Plex Mono, monospace')
            .text(`▲ ${formatMetricCompact(maxVal)}`);

          // Trough triangle marker ▼
          laneClippedG
            .append('path')
            .attr('d', `M ${minX} ${minY + 5} L ${minX - 3.8} ${minY - 2} L ${minX + 3.8} ${minY - 2} Z`)
            .attr('fill', '#94A3B8')
            .attr('stroke', '#07090E')
            .attr('stroke-width', 0.9);

          const minAlignEnd = minX > innerW - 86;
          laneClippedG
            .append('text')
            .attr('x', minAlignEnd ? minX - 7 : minX + 7)
            .attr('y', Math.max(12, Math.min(laneHeight - 4, minY + 3)))
            .attr('text-anchor', minAlignEnd ? 'end' : 'start')
            .attr('fill', '#94A3B8')
            .attr('font-size', '9px')
            .attr('font-family', 'IBM Plex Mono, monospace')
            .text(`▼ ${formatMetricCompact(minVal)}`);
        }

        // Secondary local peaks P1/P2 ring highlights on the active measurement channel
        if (isMeasureTarget && peakAnalysis.localPeaks.length > 1) {
          peakAnalysis.localPeaks.slice(0, 3).forEach((pk) => {
            if (pk.seq === laneMaxSample.seq) return;
            const px = xScale(pk.seq);
            const py = yScale(pk.value);
            laneClippedG
              .append('circle')
              .attr('cx', px)
              .attr('cy', py)
              .attr('r', 3.1)
              .attr('fill', 'none')
              .attr('stroke', '#FBBF24')
              .attr('stroke-width', 1.2);
          });
        }
      }

      // Dual Cursor intersection markers on each strip lane
      if (cursorMode === 'dual' && cursorA && cursorB) {
        const xA = xScale(cursorA.seq);
        const yA = yScale(cursorA[ch.id]);
        const xB = xScale(cursorB.seq);
        const yB = yScale(cursorB[ch.id]);

        laneClippedG
          .append('circle')
          .attr('cx', xA)
          .attr('cy', yA)
          .attr('r', isMeasureTarget ? 4 : 3)
          .attr('fill', '#38BDF8')
          .attr('stroke', '#07090E')
          .attr('stroke-width', 1.2);

        laneClippedG
          .append('circle')
          .attr('cx', xB)
          .attr('cy', yB)
          .attr('r', isMeasureTarget ? 4 : 3)
          .attr('fill', '#C084FC')
          .attr('stroke', '#07090E')
          .attr('stroke-width', 1.2);
      }

      // Active sample dot (Probe hover or selected frame)
      if (
        activeSample &&
        activeSample.seq >= minSeq &&
        activeSample.seq <= maxSeq &&
        (cursorMode === 'probe' || hoverSample !== null)
      ) {
        laneClippedG
          .append('circle')
          .attr('cx', xScale(activeSample.seq))
          .attr('cy', yScale(activeSample[ch.id]))
          .attr('r', 3.2)
          .attr('fill', ch.color)
          .attr('stroke', '#07090E')
          .attr('stroke-width', 1.2);
      }

      // Channel label + instantaneous value + unit/div scale readout inside strip top-left
      const headVal = activeSample ? activeSample[ch.id] : 0;
      const divStr =
        gridMode !== 'off'
          ? ` · ${formatMetricCompact(laneDom.perDiv)}${ch.unit ? ` ${ch.unit}` : ''}/div`
          : '';
      const clipStr = laneDom.clipped ? ' [CLIP]' : '';
      const labelText = `${ch.shortLabel} (${ch.label}) · ${formatMetricCompact(headVal)}${
        ch.unit ? ` ${ch.unit}` : ''
      }${
        ch.id === 'uCmd' && activeSample?.watchdogState === 'SAFE_CLAMP'
          ? ' [CLAMPED]'
          : ''
      }${divStr}${clipStr}`;

      laneG
        .append('text')
        .attr('x', 8)
        .attr('y', 12)
        .attr('fill', laneDom.clipped ? '#FBBF24' : ch.color)
        .attr('font-size', '9.5px')
        .attr('font-weight', '600')
        .attr('font-family', 'IBM Plex Mono, monospace')
        .text(labelText);
    });

    // Bottom synchronized X-axis aligned with configured X divisions
    const xTickValues = d3
      .range(0, xDivs + 1)
      .map((i) => xDomain[0] + ((xDomain[1] - xDomain[0]) * i) / xDivs);

    const xAxis = d3
      .axisBottom(xScale)
      .tickValues(xTickValues)
      .tickFormat((d) => {
        const seqNum = Math.round(Number(d));
        const match = stripSamples.find((s) => s.seq === seqNum);
        return match ? `#${seqNum} (${match.simTime.toFixed(2)}s)` : `#${seqNum}`;
      })
      .tickSizeOuter(0);

    root
      .append('g')
      .attr('transform', `translate(0,${totalTrackHeight})`)
      .call(xAxis)
      .call((ax) => ax.selectAll('path, line').attr('stroke', '#334155'))
      .call((ax) =>
        ax
          .selectAll('text')
          .attr('fill', '#64748B')
          .attr('font-size', '9.5px')
          .attr('font-family', 'IBM Plex Mono, monospace')
      );

    // Selected packet vertical hairline across all strips
    const selSample = stripSamples.find((s) => s.seq === selectedSeq);
    if (selSample) {
      root
        .append('line')
        .attr('x1', xScale(selSample.seq))
        .attr('x2', xScale(selSample.seq))
        .attr('y1', 0)
        .attr('y2', totalTrackHeight)
        .attr('stroke', '#06B6D4')
        .attr('stroke-opacity', 0.35)
        .attr('stroke-dasharray', '3 3')
        .attr('stroke-width', 1);
    }

    // Dual Cursor A & B Vertical Calipers + Grab Tabs
    if (cursorMode === 'dual' && cursorA && cursorB) {
      const renderCursorCaliper = (
        handle: CursorHandle,
        sample: TelemetryStripSample,
        color: string
      ) => {
        const cx = xScale(sample.seq);
        root
          .append('line')
          .attr('x1', cx)
          .attr('x2', cx)
          .attr('y1', -2)
          .attr('y2', totalTrackHeight)
          .attr('stroke', color)
          .attr('stroke-opacity', 0.85)
          .attr('stroke-width', activeCursorHandle === handle ? 1.5 : 1.15);

        const tabW = 34;
        const tabH = 14;
        const tabX = Math.max(0, Math.min(innerW - tabW, cx - tabW / 2));

        root
          .append('rect')
          .attr('x', tabX)
          .attr('y', -16)
          .attr('width', tabW)
          .attr('height', tabH)
          .attr('rx', 2)
          .attr('fill', '#07090E')
          .attr('stroke', color)
          .attr('stroke-width', activeCursorHandle === handle ? 1.4 : 1);

        root
          .append('text')
          .attr('x', tabX + tabW / 2)
          .attr('y', -6)
          .attr('text-anchor', 'middle')
          .attr('fill', color)
          .attr('font-size', '9px')
          .attr('font-weight', '600')
          .attr('font-family', 'IBM Plex Mono, monospace')
          .text(`${handle} #${sample.seq}`);
      };

      renderCursorCaliper('A', cursorA, '#38BDF8');
      renderCursorCaliper('B', cursorB, '#C084FC');
    }

    // Hover crosshair synced across all strips
    if (hoverSample && hoverSample.seq >= minSeq && hoverSample.seq <= maxSeq) {
      root
        .append('line')
        .attr('x1', xScale(hoverSample.seq))
        .attr('x2', xScale(hoverSample.seq))
        .attr('y1', 0)
        .attr('y2', totalTrackHeight)
        .attr('stroke', '#E2E8F0')
        .attr('stroke-opacity', 0.55)
        .attr('stroke-width', 1);
    }

    const resolveSampleAtPointer = (mx: number): TelemetryStripSample | null => {
      const clampedX = Math.max(0, Math.min(innerW, mx));
      const seqEst = xScale.invert(clampedX);
      const rightIdx = Math.min(
        stripSamples.length - 1,
        Math.max(0, bisectSeq(stripSamples, seqEst))
      );
      if (rightIdx === 0) return stripSamples[0] ?? null;
      const leftSample = stripSamples[rightIdx - 1];
      const rightSample = stripSamples[rightIdx];
      return Math.abs(seqEst - leftSample.seq) <= Math.abs(rightSample.seq - seqEst)
        ? leftSample
        : rightSample;
    };

    // Interactive pointer overlay (covers header tab zone for cursor grabbing + plot tracks)
    root
      .append('rect')
      .attr('x', 0)
      .attr('y', -18)
      .attr('width', innerW)
      .attr('height', totalTrackHeight + 18)
      .attr('fill', 'transparent')
      .style('cursor', cursorMode === 'dual' ? 'ew-resize' : 'crosshair')
      .on('pointerdown', (event: PointerEvent) => {
        const [mx] = d3.pointer(event);
        const chosen = resolveSampleAtPointer(mx);
        if (!chosen) return;

        if (cursorMode === 'dual' && cursorA && cursorB) {
          const distA = Math.abs(mx - xScale(cursorA.seq));
          const distB = Math.abs(mx - xScale(cursorB.seq));
          let targetHandle: CursorHandle = activeCursorHandle;
          if (distA <= 14 || distB <= 14) {
            targetHandle = distA <= distB ? 'A' : 'B';
            setActiveCursorHandle(targetHandle);
          }
          draggingCursorRef.current = targetHandle;
          if (targetHandle === 'A') {
            setCursorASeq(chosen.seq);
          } else {
            setCursorBSeq(chosen.seq);
          }
        }
      })
      .on('pointermove', (event: PointerEvent) => {
        const [mx] = d3.pointer(event);
        const chosen = resolveSampleAtPointer(mx);
        if (!chosen) return;
        setHoverSample(chosen);

        if (cursorMode === 'dual' && draggingCursorRef.current) {
          if (draggingCursorRef.current === 'A') {
            setCursorASeq(chosen.seq);
          } else {
            setCursorBSeq(chosen.seq);
          }
        }
      })
      .on('pointerleave', () => {
        setHoverSample(null);
      })
      .on('click', (event: MouseEvent) => {
        if (cursorMode === 'probe' || event.shiftKey) {
          const [mx] = d3.pointer(event);
          const chosen = resolveSampleAtPointer(mx);
          if (chosen) onSelectSeq(chosen.seq);
        }
      });
  }, [
    stripSamples,
    visibleChannels,
    laneHeight,
    svgHeight,
    selectedSeq,
    hoverSample,
    onSelectSeq,
    gridMode,
    xDivs,
    yDivs,
    gridLineStyle,
    gridContrast,
    showPeakMarkers,
    cursorMode,
    activeCursorHandle,
    measureChannel,
    peakAnalysis,
    channelGridScales,
  ]);

  const readoutSample =
    hoverSample ??
    stripSamples.find((s) => s.seq === selectedSeq) ??
    stripSamples[stripSamples.length - 1];

  const recentConsoleSamples = useMemo(
    () => stripSamples.slice(-4).reverse(),
    [stripSamples]
  );

  const targetUnit = measureChannelMeta?.unit ?? '';

  return (
    <section
      aria-label="ESP32 Real-Time Serial Monitor Multi-Channel Strip Chart"
      className="px-6 py-4 border-b border-slate-800 bg-[#07090E] space-y-3"
    >
      {/* Monitor Header + Channel Toggles + Window Controls */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2">
            <Terminal className="w-3.5 h-3.5 text-cyan-400" />
            <span className="text-xs font-medium text-slate-200">
              ESP32 Real-Time Serial Monitor (Multi-Channel Strip Chart)
            </span>
          </div>
          <span
            className={`text-[11px] font-mono tabular-nums ${
              isStreaming ? 'text-emerald-400' : 'text-slate-400'
            }`}
          >
            {isStreaming ? '● RX Active' : '❚❚ Hold'} ·{' '}
            {cobsActive ? 'COBS + CRC16' : 'RAW Binary'} · {model.hil.baudOrRate}
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {/* Channel strip toggles */}
          <div className="flex flex-wrap items-center gap-1">
            {channels.map((ch) => {
              const active = enabledChannels[ch.id];
              const latestVal = readoutSample ? readoutSample[ch.id] : 0;
              return (
                <button
                  key={ch.id}
                  type="button"
                  onClick={() => toggleChannel(ch.id)}
                  title={`Toggle ${ch.label} strip`}
                  className={`inline-flex items-center gap-1.5 px-2 py-1 text-[10px] font-mono tabular-nums rounded border transition-colors cursor-pointer whitespace-nowrap shrink-0 ${
                    active
                      ? 'border-slate-700 bg-[#0B0E17] text-slate-200'
                      : 'border-slate-800/80 bg-[#07090E] text-slate-500 opacity-60 hover:opacity-90'
                  }`}
                >
                  <span
                    className="w-2 h-2 rounded-full shrink-0"
                    style={{ backgroundColor: ch.color }}
                  />
                  <span>{ch.shortLabel}</span>
                  <span style={{ color: ch.color }}>
                    {formatMetricCompact(latestVal)}
                  </span>
                </button>
              );
            })}
          </div>

          {/* Rolling Window Selector */}
          <div className="flex items-center gap-0.5 p-0.5 bg-[#0B0E17] border border-slate-800 rounded">
            {([32, 64, 96] as const).map((sz) => (
              <button
                key={sz}
                type="button"
                onClick={() => onChangeWindowSize(sz)}
                className={`px-2 py-0.5 text-[10px] font-mono tabular-nums rounded transition-colors cursor-pointer whitespace-nowrap shrink-0 ${
                  windowSize === sz
                    ? 'bg-slate-800 text-cyan-300'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                {sz}F
              </button>
            ))}
          </div>

          <button
            type="button"
            onClick={() => setShowSerialLog((s) => !s)}
            className={`px-2 py-1 text-[10px] font-mono rounded border transition-colors cursor-pointer whitespace-nowrap shrink-0 ${
              showSerialLog
                ? 'border-cyan-500/40 bg-cyan-500/10 text-cyan-200'
                : 'border-slate-800 bg-[#0B0E17] text-slate-400 hover:text-slate-200'
            }`}
          >
            {showSerialLog ? 'Hide Log' : 'Serial Log'}
          </button>

          <button
            type="button"
            onClick={onClearBuffer}
            title="Clear serial monitor buffer"
            className="inline-flex items-center gap-1 px-2 py-1 text-[10px] font-mono rounded border border-slate-800 bg-[#0B0E17] hover:bg-slate-800 text-slate-300 transition-colors cursor-pointer whitespace-nowrap shrink-0"
          >
            <Trash2 className="w-3 h-3 text-slate-400" />
            Clear
          </button>
        </div>
      </div>

      {/* Graticule Grid Overlay & Cursor Measurement Toolbar */}
      <div className="px-3 py-2 rounded border border-slate-800 bg-[#0B0E17] flex flex-wrap items-center justify-between gap-3 text-[11px] font-mono">
        {/* Left: Configurable Grid Overlay Controls */}
        <div className="flex flex-wrap items-center gap-2.5">
          <span className="inline-flex items-center gap-1.5 text-slate-400 whitespace-nowrap">
            <Grid3x3 className="w-3.5 h-3.5 text-cyan-400" />
            Grid
          </span>

          <div
            role="group"
            aria-label="Grid overlay density"
            className="flex items-center gap-0.5 p-0.5 bg-[#07090E] border border-slate-800 rounded"
          >
            {(
              [
                { id: 'off', label: 'Off' },
                { id: 'major', label: 'Major' },
                { id: 'fine', label: 'Fine' },
              ] as const
            ).map((opt) => (
              <button
                key={opt.id}
                type="button"
                onClick={() => setGridMode(opt.id)}
                className={`px-2 py-0.5 text-[10px] rounded transition-colors cursor-pointer whitespace-nowrap shrink-0 ${
                  gridMode === opt.id
                    ? 'bg-slate-800 text-cyan-300'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>

          {gridMode !== 'off' && (
            <>
              <div className="flex items-center gap-1 text-[10px] text-slate-400">
                <span>X</span>
                <div className="flex items-center gap-0.5 p-0.5 bg-[#07090E] border border-slate-800 rounded">
                  {([4, 8, 12] as const).map((n) => (
                    <button
                      key={n}
                      type="button"
                      onClick={() => setXDivs(n)}
                      className={`px-1.5 py-0.5 rounded tabular-nums cursor-pointer whitespace-nowrap shrink-0 ${
                        xDivs === n
                          ? 'bg-slate-800 text-slate-100'
                          : 'text-slate-400 hover:text-slate-200'
                      }`}
                    >
                      {n}
                    </button>
                  ))}
                </div>
              </div>

              <div className="flex items-center gap-1 text-[10px] text-slate-400">
                <span>Y</span>
                <div className="flex items-center gap-0.5 p-0.5 bg-[#07090E] border border-slate-800 rounded">
                  {([2, 4, 6] as const).map((n) => (
                    <button
                      key={n}
                      type="button"
                      onClick={() => setYDivs(n)}
                      className={`px-1.5 py-0.5 rounded tabular-nums cursor-pointer whitespace-nowrap shrink-0 ${
                        yDivs === n
                          ? 'bg-slate-800 text-slate-100'
                          : 'text-slate-400 hover:text-slate-200'
                      }`}
                    >
                      {n}
                    </button>
                  ))}
                </div>
              </div>

              <button
                type="button"
                onClick={() =>
                  setGridLineStyle((s) => (s === 'solid' ? 'dashed' : 'solid'))
                }
                title="Toggle solid or dashed major grid lines"
                className="px-2 py-0.5 text-[10px] rounded border border-slate-800 bg-[#07090E] hover:bg-slate-800 text-slate-300 cursor-pointer whitespace-nowrap shrink-0"
              >
                {gridLineStyle === 'solid' ? 'Solid' : 'Dashed'}
              </button>

              <button
                type="button"
                onClick={() =>
                  setGridContrast((c) => (c === 'subtle' ? 'crisp' : 'subtle'))
                }
                title="Toggle graticule line contrast"
                className="px-2 py-0.5 text-[10px] rounded border border-slate-800 bg-[#07090E] hover:bg-slate-800 text-slate-300 cursor-pointer whitespace-nowrap shrink-0"
              >
                {gridContrast === 'subtle' ? 'Dim' : 'Crisp'}
              </button>
            </>
          )}

          <button
            type="button"
            aria-pressed={showPeakMarkers}
            onClick={() => setShowPeakMarkers((v) => !v)}
            className={`px-2 py-0.5 text-[10px] rounded border transition-colors cursor-pointer whitespace-nowrap shrink-0 ${
              showPeakMarkers
                ? 'border-amber-500/40 bg-amber-500/10 text-amber-200'
                : 'border-slate-800 bg-[#07090E] text-slate-400 hover:text-slate-200'
            }`}
          >
            {showPeakMarkers ? '▲ Peaks ON' : '▲ Peaks OFF'}
          </button>

          {/* Dynamic Peak-to-Peak Y-Axis Auto-Scale Toggle */}
          <div className="flex items-center gap-1">
            <button
              type="button"
              role="switch"
              aria-checked={autoScaleY}
              onClick={handleToggleAutoScaleY}
              title="Dynamically adjust each strip's Y-axis range from incoming peak-to-peak telemetry amplitude"
              className={`px-2 py-0.5 text-[10px] rounded border transition-colors cursor-pointer whitespace-nowrap shrink-0 ${
                autoScaleY
                  ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300'
                  : 'border-slate-700 bg-[#07090E] text-amber-300 hover:bg-slate-800'
              }`}
            >
              {autoScaleY ? 'Auto-Scale Y: ON (Vpp)' : 'Auto-Scale Y: Locked'}
            </button>
            {!autoScaleY && (
              <>
                <button
                  type="button"
                  onClick={handleFitVppOnce}
                  title="Snap locked Y ranges once to current peak-to-peak amplitude"
                  className="px-1.5 py-0.5 text-[10px] rounded border border-slate-700 bg-[#07090E] hover:bg-slate-800 text-cyan-300 cursor-pointer whitespace-nowrap shrink-0"
                >
                  Fit Vpp
                </button>
                <button
                  type="button"
                  onClick={handleLockNominalRanges}
                  title="Set locked Y ranges to model nominal reference and actuator saturation limits"
                  className="px-1.5 py-0.5 text-[10px] rounded border border-slate-800 bg-[#07090E] hover:bg-slate-800 text-slate-300 cursor-pointer whitespace-nowrap shrink-0"
                >
                  Nominal
                </button>
              </>
            )}
          </div>
        </div>

        {/* Right: Cursor Measurement Controls */}
        <div className="flex flex-wrap items-center gap-2">
          <span className="inline-flex items-center gap-1.5 text-slate-400 whitespace-nowrap">
            <Crosshair className="w-3.5 h-3.5 text-sky-400" />
            Cursor
          </span>

          <div
            role="group"
            aria-label="Cursor measurement mode"
            className="flex items-center gap-0.5 p-0.5 bg-[#07090E] border border-slate-800 rounded"
          >
            <button
              type="button"
              onClick={() => setCursorMode('probe')}
              className={`px-2 py-0.5 text-[10px] rounded transition-colors cursor-pointer whitespace-nowrap shrink-0 ${
                cursorMode === 'probe'
                  ? 'bg-slate-800 text-cyan-300'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              Probe
            </button>
            <button
              type="button"
              onClick={() => setCursorMode('dual')}
              className={`px-2 py-0.5 text-[10px] rounded transition-colors cursor-pointer whitespace-nowrap shrink-0 ${
                cursorMode === 'dual'
                  ? 'bg-slate-800 text-sky-300'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              Δ Cursors (A/B)
            </button>
          </div>

          {cursorMode === 'dual' && (
            <>
              <div className="flex items-center gap-0.5 p-0.5 bg-[#07090E] border border-slate-800 rounded">
                <button
                  type="button"
                  onClick={() => setActiveCursorHandle('A')}
                  className={`px-2 py-0.5 text-[10px] rounded transition-colors cursor-pointer whitespace-nowrap shrink-0 ${
                    activeCursorHandle === 'A'
                      ? 'bg-sky-500/20 text-sky-300'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  Place A
                </button>
                <button
                  type="button"
                  onClick={() => setActiveCursorHandle('B')}
                  className={`px-2 py-0.5 text-[10px] rounded transition-colors cursor-pointer whitespace-nowrap shrink-0 ${
                    activeCursorHandle === 'B'
                      ? 'bg-purple-500/20 text-purple-300'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  Place B
                </button>
              </div>

              <select
                aria-label="Peak measurement target channel"
                value={measureChannel}
                onChange={(e) =>
                  setMeasureChannel(e.target.value as TelemetryChannelId)
                }
                className="bg-[#07090E] border border-slate-800 text-slate-200 text-[10px] font-mono rounded px-2 py-0.5 focus:outline-none focus:border-cyan-400 cursor-pointer"
              >
                {visibleChannels.map((ch) => (
                  <option key={ch.id} value={ch.id}>
                    {ch.shortLabel}
                  </option>
                ))}
              </select>

              <button
                type="button"
                disabled={!peakAnalysis.windowMin || !peakAnalysis.windowMax}
                onClick={handleSnapMinMax}
                title="Snap Cursor A to window trough and Cursor B to signal peak"
                className="px-2 py-0.5 text-[10px] rounded border border-slate-700 bg-[#07090E] hover:bg-slate-800 text-cyan-300 cursor-pointer whitespace-nowrap shrink-0 disabled:opacity-40"
              >
                Snap Min→Max
              </button>

              <button
                type="button"
                disabled={peakAnalysis.localPeaks.length < 2}
                onClick={handleSnapTopTwoPeaks}
                title="Snap A and B to the top 2 local peaks to measure period and frequency"
                className="px-2 py-0.5 text-[10px] rounded border border-slate-700 bg-[#07090E] hover:bg-slate-800 text-amber-300 cursor-pointer whitespace-nowrap shrink-0 disabled:opacity-40"
              >
                Snap 2 Peaks
              </button>

              <button
                type="button"
                onClick={handleResetCursors}
                title="Reset A/B cursors to 25% and 75% of window"
                className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] rounded border border-slate-800 bg-[#07090E] hover:bg-slate-800 text-slate-400 hover:text-slate-200 cursor-pointer whitespace-nowrap shrink-0"
              >
                <RotateCcw className="w-2.5 h-2.5" />
                Reset
              </button>
            </>
          )}
        </div>
      </div>

      {/* Synchronized Multi-Channel Strip Chart SVG */}
      <svg
        ref={svgRef}
        viewBox={`0 0 940 ${svgHeight}`}
        style={{ height: `${svgHeight}px` }}
        className="w-full select-none"
      />

      {/* Cursor & Signal Peak Measurement Telemetry Bar */}
      {(cursorMode === 'dual' || showPeakMarkers) && stripSamples.length > 0 && (
        <div
          aria-label="Cursor and Signal Peak Measurement Readout"
          className="rounded border border-slate-800 bg-[#0B0E17] px-3 py-2.5 space-y-2 font-mono tabular-nums"
        >
          <div className="flex flex-wrap items-center justify-between gap-2 text-[10.5px] border-b border-slate-800/70 pb-1.5">
            <span className="text-slate-300">
              Peak &amp; Cursor Analyzer ·{' '}
              <span style={{ color: measureChannelMeta?.color }}>
                {measureChannelMeta?.shortLabel} ({measureChannelMeta?.label})
              </span>
            </span>
            <span className="text-slate-400">
              {autoScaleY ? 'Y: Auto (Vpp)' : 'Y: Locked'} ·{' '}
              {gridMode !== 'off'
                ? `Grid: ${xDivs}×${yDivs} divs (${timePerDivSec.toFixed(3)} s/div · ${formatMetricCompact(
                    channelGridScales[measureChannel].perDiv
                  )}${targetUnit ? ` ${targetUnit}` : ''}/div)`
                : 'Grid overlay off'}
              {cursorMode === 'dual' ? ' · Drag A/B tabs or click to place · Shift+Click selects packet' : ''}
            </span>
          </div>

          <div className="grid grid-cols-2 lg:grid-cols-5 gap-3 text-xs">
            <div className="p-2 rounded border border-slate-800 bg-[#07090E]">
              <div className="text-[10px] text-sky-400">Cursor A</div>
              {cursorMode === 'dual' && peakAnalysis.cursorA ? (
                <>
                  <div className="text-slate-100 font-semibold mt-0.5">
                    {formatMetricCompact(peakAnalysis.cursorA[measureChannel])}
                    {targetUnit ? ` ${targetUnit}` : ''}
                  </div>
                  <div className="text-[10px] text-slate-400">
                    #{peakAnalysis.cursorA.seq} · t={peakAnalysis.cursorA.simTime.toFixed(3)}s
                  </div>
                </>
              ) : (
                <div className="text-slate-500 mt-0.5">Switch to Δ Cursors</div>
              )}
            </div>

            <div className="p-2 rounded border border-slate-800 bg-[#07090E]">
              <div className="text-[10px] text-purple-300">Cursor B</div>
              {cursorMode === 'dual' && peakAnalysis.cursorB ? (
                <>
                  <div className="text-slate-100 font-semibold mt-0.5">
                    {formatMetricCompact(peakAnalysis.cursorB[measureChannel])}
                    {targetUnit ? ` ${targetUnit}` : ''}
                  </div>
                  <div className="text-[10px] text-slate-400">
                    #{peakAnalysis.cursorB.seq} · t={peakAnalysis.cursorB.simTime.toFixed(3)}s
                  </div>
                </>
              ) : (
                <div className="text-slate-500 mt-0.5">Switch to Δ Cursors</div>
              )}
            </div>

            <div className="p-2 rounded border border-slate-800 bg-[#07090E]">
              <div className="text-[10px] text-slate-400">Δ Time / Frequency</div>
              {cursorMode === 'dual' && peakAnalysis.deltaTimeSec !== null ? (
                <>
                  <div className="text-cyan-300 font-semibold mt-0.5">
                    {peakAnalysis.deltaTimeSec >= 0 ? '+' : ''}
                    {peakAnalysis.deltaTimeSec.toFixed(3)} s
                  </div>
                  <div className="text-[10px] text-slate-400">
                    Δseq {peakAnalysis.deltaSeq} ·{' '}
                    {peakAnalysis.frequencyHz !== null
                      ? `f=${peakAnalysis.frequencyHz.toFixed(2)} Hz`
                      : 'DC / 0 Δt'}
                  </div>
                </>
              ) : (
                <div className="text-slate-500 mt-0.5">—</div>
              )}
            </div>

            <div className="p-2 rounded border border-slate-800 bg-[#07090E]">
              <div className="text-[10px] text-slate-400">Δ Amplitude (B − A)</div>
              {cursorMode === 'dual' && peakAnalysis.deltaValue !== null ? (
                <>
                  <div className="text-amber-300 font-semibold mt-0.5">
                    {formatSignedMetric(peakAnalysis.deltaValue)}
                    {targetUnit ? ` ${targetUnit}` : ''}
                  </div>
                  <div className="text-[10px] text-slate-400">
                    {peakAnalysis.deltaPct !== null
                      ? `${peakAnalysis.deltaPct >= 0 ? '+' : ''}${peakAnalysis.deltaPct.toFixed(1)}% vs A`
                      : 'Baseline zero'}
                  </div>
                </>
              ) : (
                <div className="text-slate-500 mt-0.5">—</div>
              )}
            </div>

            <div className="p-2 rounded border border-slate-800 bg-[#07090E]">
              <div className="text-[10px] text-slate-400">
                {cursorMode === 'dual' && peakAnalysis.intervalPeakToPeak !== null
                  ? 'Interval [A..B] Peaks'
                  : 'Window Peaks'}
              </div>
              <div className="text-emerald-300 font-semibold mt-0.5">
                Vpp{' '}
                {formatMetricCompact(
                  cursorMode === 'dual' && peakAnalysis.intervalPeakToPeak !== null
                    ? peakAnalysis.intervalPeakToPeak
                    : peakAnalysis.windowPeakToPeak
                )}
                {targetUnit ? ` ${targetUnit}` : ''}
              </div>
              <div className="text-[10px] text-slate-400">
                ▲{' '}
                {formatMetricCompact(
                  (cursorMode === 'dual' && peakAnalysis.intervalMax
                    ? peakAnalysis.intervalMax[measureChannel]
                    : peakAnalysis.windowMax?.[measureChannel]) ?? 0
                )}{' '}
                · ▼{' '}
                {formatMetricCompact(
                  (cursorMode === 'dual' && peakAnalysis.intervalMin
                    ? peakAnalysis.intervalMin[measureChannel]
                    : peakAnalysis.windowMin?.[measureChannel]) ?? 0
                )}
                {peakAnalysis.localPeaks.length > 0
                  ? ` · ${peakAnalysis.localPeaks.length} pk`
                  : ''}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Decoded Incoming ESP32 Serial Telemetry Stream Log */}
      {showSerialLog && (
        <div className="rounded border border-slate-800 bg-[#0B0E17] px-3 py-2 space-y-1 font-mono text-[10.5px] tabular-nums">
          <div className="flex items-center justify-between text-[10px] text-slate-500 border-b border-slate-800/70 pb-1">
            <span>
              DECODED SERIAL RX FEED ({visiblePackets.length}/{windowSize} frames buffered)
            </span>
            {readoutSample && (
              <span className="text-slate-400">
                Cursor #{readoutSample.seq} · t={readoutSample.simTime.toFixed(3)}s ·{' '}
                {readoutSample.tickUs} μs
              </span>
            )}
          </div>
          {recentConsoleSamples.length === 0 ? (
            <div className="text-slate-500 py-1">
              Waiting for incoming ESP32 serial frames…
            </div>
          ) : (
            <div className="space-y-0.5 max-h-[76px] overflow-y-auto">
              {recentConsoleSamples.map((s) => (
                <div
                  key={s.seq}
                  onClick={() => onSelectSeq(s.seq)}
                  className={`flex flex-wrap items-center justify-between gap-3 px-1.5 py-0.5 rounded cursor-pointer transition-colors ${
                    s.seq === selectedSeq
                      ? 'bg-cyan-500/10 text-slate-100'
                      : 'hover:bg-slate-800/50 text-slate-300'
                  }`}
                >
                  <span className="flex items-center gap-2">
                    <span
                      className={
                        s.watchdogState === 'SAFE_CLAMP'
                          ? 'text-rose-400'
                          : s.dropped
                          ? 'text-amber-300'
                          : 'text-emerald-400'
                      }
                    >
                      [{s.dropped ? 'TIMEOUT' : s.watchdogState}]
                    </span>
                    <span className="text-slate-400">
                      #{String(s.seq).padStart(3, '0')} @{s.tickUs}us
                    </span>
                  </span>
                  <span className="flex flex-wrap items-center gap-3">
                    <span className="text-slate-200">
                      ref={formatMetricCompact(s.ref)}
                    </span>
                    <span className="text-cyan-300">
                      {channels[1]?.shortLabel.replace('CH1 · ', '')}={formatMetricCompact(s.y0)}
                    </span>
                    <span className="text-emerald-300">
                      {channels[2]?.shortLabel.replace('CH2 · ', '')}={formatMetricCompact(s.y1)}
                    </span>
                    <span
                      className={
                        s.watchdogState === 'SAFE_CLAMP'
                          ? 'text-rose-400'
                          : 'text-amber-300'
                      }
                    >
                      {channels[3]?.shortLabel.replace('CH3 · ', '')}={formatMetricCompact(s.uCmd)}
                      {s.watchdogState === 'SAFE_CLAMP' ? ' [SAFE_CLAMP]' : ''}
                    </span>
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  );
};
