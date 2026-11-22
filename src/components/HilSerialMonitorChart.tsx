import React, { useEffect, useMemo, useRef, useState } from 'react';
import * as d3 from 'd3';
import { Terminal, Trash2 } from 'lucide-react';
import { ControlModel, HilFramePacket } from '../types/control';
import {
  extractTelemetryStripSeries,
  getHilTelemetryChannels,
  isHilCobsEnabled,
  TelemetryChannelMeta,
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

type ChannelId = TelemetryChannelMeta['id'];

function formatMetricCompact(v: number): string {
  if (!Number.isFinite(v)) return '0';
  const abs = Math.abs(v);
  if (abs === 0) return '0.00';
  if (abs >= 100) return v.toFixed(1);
  if (abs >= 10) return v.toFixed(2);
  if (abs >= 1) return v.toFixed(3);
  return v.toFixed(4);
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
  const [hoverSample, setHoverSample] = useState<TelemetryStripSample | null>(null);
  const [showSerialLog, setShowSerialLog] = useState<boolean>(true);
  const [enabledChannels, setEnabledChannels] = useState<Record<ChannelId, boolean>>({
    ref: true,
    y0: true,
    y1: true,
    uCmd: true,
  });

  const channels = useMemo(() => getHilTelemetryChannels(model), [model]);
  const visibleChannels = useMemo(
    () => channels.filter((ch) => enabledChannels[ch.id]),
    [channels, enabledChannels]
  );

  const visiblePackets = useMemo(
    () => packets.slice(-windowSize),
    [packets, windowSize]
  );

  const stripSamples = useMemo(
    () => extractTelemetryStripSeries(model, visiblePackets),
    [model, visiblePackets]
  );

  const cobsActive = isHilCobsEnabled(model);
  const laneHeight = visibleChannels.length <= 2 ? 78 : 58;
  const laneGap = 10;
  const marginTop = 12;
  const marginBottom = 24;
  const svgHeight = Math.max(
    110,
    marginTop +
      marginBottom +
      visibleChannels.length * laneHeight +
      Math.max(0, visibleChannels.length - 1) * laneGap
  );

  const toggleChannel = (id: ChannelId) => {
    setEnabledChannels((prev) => {
      const next = { ...prev, [id]: !prev[id] };
      // Keep at least one strip active
      if (!Object.values(next).some(Boolean)) return prev;
      return next;
    });
  };

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

    // Render one synchronized strip lane per enabled telemetry channel
    visibleChannels.forEach((ch, laneIdx) => {
      const yOffset = laneIdx * (laneHeight + laneGap);
      const laneG = root
        .append('g')
        .attr('transform', `translate(0,${yOffset})`);

      const vals = stripSamples.map((s) => s[ch.id]);
      const rawMin = d3.min(vals) ?? 0;
      const rawMax = d3.max(vals) ?? 1;
      const span = rawMax - rawMin;
      const pad = span > 1e-6 ? span * 0.16 : Math.max(0.25, Math.abs(rawMax) * 0.25);
      const yScale = d3
        .scaleLinear()
        .domain([rawMin - pad, rawMax + pad])
        .nice(2)
        .range([laneHeight, 0]);

      // Strip frame background
      laneG
        .append('rect')
        .attr('x', 0)
        .attr('y', 0)
        .attr('width', innerW)
        .attr('height', laneHeight)
        .attr('fill', '#0B0E17')
        .attr('stroke', '#1E293B')
        .attr('stroke-width', 1);

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
          .attr('stroke', '#334155')
          .attr('stroke-dasharray', '3 3')
          .attr('stroke-width', 0.9);
      }

      // Subtle mid-grid rule
      const yTicks = yScale.ticks(3);
      laneG
        .selectAll('line.strip-grid')
        .data(yTicks)
        .join('line')
        .attr('class', 'strip-grid')
        .attr('x1', 0)
        .attr('x2', innerW)
        .attr('y1', (d) => yScale(d))
        .attr('y2', (d) => yScale(d))
        .attr('stroke', '#1E293B')
        .attr('stroke-opacity', 0.65)
        .attr('stroke-width', 0.8);

      // Left Y axis (min/mid/max)
      const yAxis = d3
        .axisLeft(yScale)
        .ticks(3)
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

      // Subtle translucent area fill
      const baselineVal = domMin <= 0 && domMax >= 0 ? 0 : domMin;
      const areaGen = d3
        .area<TelemetryStripSample>()
        .x((d) => xScale(d.seq))
        .y0(yScale(baselineVal))
        .y1((d) => yScale(d[ch.id]))
        .curve(ch.stepped ? d3.curveStepAfter : d3.curveLinear);

      laneG
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

      laneG
        .append('path')
        .datum(stripSamples)
        .attr('fill', 'none')
        .attr('stroke', ch.color)
        .attr('stroke-width', 1.65)
        .attr('d', lineGen);

      // Dropped / SAFE_CLAMP anomaly markers
      laneG
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

      // Active sample dot
      if (activeSample && activeSample.seq >= minSeq && activeSample.seq <= maxSeq) {
        laneG
          .append('circle')
          .attr('cx', xScale(activeSample.seq))
          .attr('cy', yScale(activeSample[ch.id]))
          .attr('r', 3.4)
          .attr('fill', ch.color)
          .attr('stroke', '#07090E')
          .attr('stroke-width', 1.2);
      }

      // Channel label + instantaneous value badge inside strip top-left
      const headVal = activeSample ? activeSample[ch.id] : 0;
      const labelText = `${ch.shortLabel} (${ch.label}) · ${formatMetricCompact(headVal)}${
        ch.unit ? ` ${ch.unit}` : ''
      }${ch.id === 'uCmd' && activeSample?.watchdogState === 'SAFE_CLAMP' ? ' [CLAMPED]' : ''}`;

      laneG
        .append('text')
        .attr('x', 8)
        .attr('y', 12)
        .attr('fill', ch.color)
        .attr('font-size', '9.5px')
        .attr('font-weight', '600')
        .attr('font-family', 'IBM Plex Mono, monospace')
        .text(labelText);
    });

    // Bottom synchronized X-axis across all strip lanes
    const totalTrackHeight =
      visibleChannels.length * laneHeight +
      Math.max(0, visibleChannels.length - 1) * laneGap;
    const xAxis = d3
      .axisBottom(xScale)
      .ticks(8)
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
        .attr('stroke-opacity', 0.45)
        .attr('stroke-dasharray', '3 3')
        .attr('stroke-width', 1);
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
        .attr('stroke-opacity', 0.65)
        .attr('stroke-width', 1);
    }

    // Interactive pointer overlay
    root
      .append('rect')
      .attr('x', 0)
      .attr('y', 0)
      .attr('width', innerW)
      .attr('height', totalTrackHeight)
      .attr('fill', 'transparent')
      .style('cursor', 'crosshair')
      .on('pointermove', (event: PointerEvent) => {
        const [mx] = d3.pointer(event);
        const seqEst = xScale.invert(Math.max(0, Math.min(innerW, mx)));
        const idx = Math.min(
          stripSamples.length - 1,
          Math.max(0, bisectSeq(stripSamples, seqEst))
        );
        setHoverSample(stripSamples[idx]);
      })
      .on('pointerleave', () => setHoverSample(null))
      .on('click', (event: MouseEvent) => {
        const [mx] = d3.pointer(event);
        const seqEst = xScale.invert(Math.max(0, Math.min(innerW, mx)));
        const idx = Math.min(
          stripSamples.length - 1,
          Math.max(0, bisectSeq(stripSamples, seqEst))
        );
        const chosen = stripSamples[idx];
        if (chosen) onSelectSeq(chosen.seq);
      });
  }, [
    stripSamples,
    visibleChannels,
    laneHeight,
    svgHeight,
    selectedSeq,
    hoverSample,
    onSelectSeq,
  ]);

  const readoutSample =
    hoverSample ??
    stripSamples.find((s) => s.seq === selectedSeq) ??
    stripSamples[stripSamples.length - 1];

  const recentConsoleSamples = useMemo(
    () => stripSamples.slice(-4).reverse(),
    [stripSamples]
  );

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

      {/* Synchronized Multi-Channel Strip Chart SVG */}
      <svg
        ref={svgRef}
        viewBox={`0 0 940 ${svgHeight}`}
        style={{ height: `${svgHeight}px` }}
        className="w-full select-none"
      />

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
