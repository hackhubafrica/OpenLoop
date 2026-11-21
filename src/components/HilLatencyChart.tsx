import React, { useEffect, useMemo, useRef, useState } from 'react';
import * as d3 from 'd3';
import { HilFramePacket } from '../types/control';

interface HilLatencyChartProps {
  packets: HilFramePacket[];
  budgetMs: number;
  selectedSeq: number;
  onSelectSeq: (seq: number) => void;
  isStreaming: boolean;
}

export const HilLatencyChart: React.FC<HilLatencyChartProps> = ({
  packets,
  budgetMs,
  selectedSeq,
  onSelectSeq,
  isStreaming,
}) => {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [hoverPkt, setHoverPkt] = useState<HilFramePacket | null>(null);

  const stats = useMemo(() => {
    if (packets.length === 0) {
      return { min: 0, avg: 0, p95: 0, max: 0 };
    }
    const rtts = packets.map((p) => p.rttMs).sort((a, b) => a - b);
    const sum = rtts.reduce((acc, v) => acc + v, 0);
    const p95Idx = Math.min(rtts.length - 1, Math.floor(rtts.length * 0.95));
    return {
      min: rtts[0],
      avg: sum / rtts.length,
      p95: rtts[p95Idx],
      max: rtts[rtts.length - 1],
    };
  }, [packets]);

  useEffect(() => {
    if (!svgRef.current || packets.length === 0) return;

    const width = 940;
    const height = 165;
    const margin = { top: 14, right: 20, bottom: 26, left: 48 };
    const innerW = width - margin.left - margin.right;
    const innerH = height - margin.top - margin.bottom;

    const minSeq = packets[0].seq;
    const maxSeq = packets[packets.length - 1].seq;
    const xDomain: [number, number] =
      minSeq === maxSeq ? [minSeq - 1, maxSeq + 1] : [minSeq, maxSeq];

    const xScale = d3.scaleLinear().domain(xDomain).range([0, innerW]);

    const yMax = Math.max(
      budgetMs * 1.45,
      d3.max(packets, (d) => d.rttMs) ?? 1,
      0.5
    );
    const yScale = d3.scaleLinear().domain([0, yMax]).nice(4).range([innerH, 0]);

    const svg = d3.select(svgRef.current);
    svg.selectAll('*').remove();

    const defs = svg.append('defs');
    const grad = defs
      .append('linearGradient')
      .attr('id', 'hil-rtt-area')
      .attr('x1', '0%')
      .attr('y1', '0%')
      .attr('x2', '0%')
      .attr('y2', '100%');
    grad.append('stop').attr('offset', '0%').attr('stop-color', '#06B6D4').attr('stop-opacity', 0.25);
    grad.append('stop').attr('offset', '100%').attr('stop-color', '#06B6D4').attr('stop-opacity', 0.02);

    const g = svg
      .append('g')
      .attr('transform', `translate(${margin.left},${margin.top})`);

    // Horizontal grid lines
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

    // Area fill under RTT trace
    const areaGen = d3
      .area<HilFramePacket>()
      .x((d) => xScale(d.seq))
      .y0(innerH)
      .y1((d) => yScale(d.rttMs))
      .curve(d3.curveMonotoneX);

    g.append('path')
      .datum(packets)
      .attr('fill', 'url(#hil-rtt-area)')
      .attr('d', areaGen);

    // RTT line trace
    const lineGen = d3
      .line<HilFramePacket>()
      .x((d) => xScale(d.seq))
      .y((d) => yScale(d.rttMs))
      .curve(d3.curveMonotoneX);

    g.append('path')
      .datum(packets)
      .attr('fill', 'none')
      .attr('stroke', '#06B6D4')
      .attr('stroke-width', 1.8)
      .attr('d', lineGen);

    // Moving average (window = 5)
    const maData = packets.map((p, idx) => {
      const start = Math.max(0, idx - 4);
      const slice = packets.slice(start, idx + 1);
      const avg = slice.reduce((acc, s) => acc + s.rttMs, 0) / slice.length;
      return { seq: p.seq, avg };
    });
    const maLine = d3
      .line<{ seq: number; avg: number }>()
      .x((d) => xScale(d.seq))
      .y((d) => yScale(d.avg))
      .curve(d3.curveMonotoneX);

    g.append('path')
      .datum(maData)
      .attr('fill', 'none')
      .attr('stroke', '#94A3B8')
      .attr('stroke-opacity', 0.6)
      .attr('stroke-dasharray', '3 3')
      .attr('stroke-width', 1.2)
      .attr('d', maLine);

    // Fixed-step deadline budget threshold line
    const budgetY = yScale(budgetMs);
    g.append('line')
      .attr('x1', 0)
      .attr('x2', innerW)
      .attr('y1', budgetY)
      .attr('y2', budgetY)
      .attr('stroke', '#F43F5E')
      .attr('stroke-dasharray', '5 3')
      .attr('stroke-width', 1.3);

    g.append('text')
      .attr('x', 6)
      .attr('y', Math.max(10, budgetY - 4))
      .attr('fill', '#FDA4AF')
      .attr('font-size', '9.5px')
      .attr('font-family', 'IBM Plex Mono, monospace')
      .text(`Fixed-Step Budget (dt = ${budgetMs.toFixed(2)} ms)`);

    // Per-packet status dots
    g.selectAll('circle.pkt-dot')
      .data(packets)
      .join('circle')
      .attr('class', 'pkt-dot')
      .attr('cx', (d) => xScale(d.seq))
      .attr('cy', (d) => yScale(d.rttMs))
      .attr('r', (d) => (d.seq === selectedSeq ? 4.5 : d.deadlineMissed ? 3.5 : 2.5))
      .attr('fill', (d) =>
        d.watchdogState === 'SAFE_CLAMP'
          ? '#F43F5E'
          : d.deadlineMissed
          ? '#F59E0B'
          : '#06B6D4'
      )
      .attr('stroke', (d) => (d.seq === selectedSeq ? '#F8FAFC' : '#07090E'))
      .attr('stroke-width', (d) => (d.seq === selectedSeq ? 1.5 : 0.8));

    // Axes
    const xAxis = d3
      .axisBottom(xScale)
      .ticks(8)
      .tickFormat((d) => `#${Math.round(Number(d))}`)
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

    // Hover crosshair + click to select frame
    if (hoverPkt && hoverPkt.seq >= minSeq && hoverPkt.seq <= maxSeq) {
      const hx = xScale(hoverPkt.seq);
      g.append('line')
        .attr('x1', hx)
        .attr('x2', hx)
        .attr('y1', 0)
        .attr('y2', innerH)
        .attr('stroke', '#94A3B8')
        .attr('stroke-opacity', 0.6)
        .attr('stroke-width', 1);
    }

    const bisectSeq = d3.bisector<HilFramePacket, number>((d) => d.seq).left;

    g.append('rect')
      .attr('width', innerW)
      .attr('height', innerH)
      .attr('fill', 'transparent')
      .style('cursor', 'crosshair')
      .on('pointermove', (event: PointerEvent) => {
        const [mx] = d3.pointer(event);
        const seqEst = xScale.invert(Math.max(0, Math.min(innerW, mx)));
        const idx = Math.min(packets.length - 1, Math.max(0, bisectSeq(packets, seqEst)));
        setHoverPkt(packets[idx]);
      })
      .on('pointerleave', () => setHoverPkt(null))
      .on('click', (event: MouseEvent) => {
        const [mx] = d3.pointer(event);
        const seqEst = xScale.invert(Math.max(0, Math.min(innerW, mx)));
        const idx = Math.min(packets.length - 1, Math.max(0, bisectSeq(packets, seqEst)));
        const chosen = packets[idx];
        if (chosen) onSelectSeq(chosen.seq);
      });
  }, [packets, budgetMs, selectedSeq, hoverPkt, onSelectSeq]);

  const activeReadout = hoverPkt ?? packets.find((p) => p.seq === selectedSeq) ?? packets[packets.length - 1];

  return (
    <div className="px-6 py-4 border-b border-slate-800 bg-[#07090E]">
      <div className="flex flex-wrap items-center justify-between gap-4 mb-2">
        <div className="flex items-center gap-3">
          <span className="text-xs font-medium text-slate-200">
            Real-Time Loopback Latency (D3.js · HIL Buffer)
          </span>
          <span
            className={`text-[11px] font-mono ${
              isStreaming ? 'text-emerald-400' : 'text-slate-400'
            }`}
          >
            {isStreaming ? '● Streaming Buffer' : '❚❚ Paused'}
          </span>
        </div>

        {/* Live RTT Distribution & Hover HUD */}
        <div className="flex flex-wrap items-center gap-4 text-[11px] font-mono tabular-nums text-slate-400">
          <span>
            Min <span className="text-slate-200">{stats.min.toFixed(2)}</span>
          </span>
          <span>
            Avg <span className="text-cyan-300">{stats.avg.toFixed(2)}</span>
          </span>
          <span>
            P95 <span className="text-amber-300">{stats.p95.toFixed(2)}</span>
          </span>
          <span>
            Max <span className="text-rose-300">{stats.max.toFixed(2)} ms</span>
          </span>

          {activeReadout && (
            <span className="pl-3 border-l border-slate-800 text-slate-300">
              #{activeReadout.seq} ·{' '}
              <span className="text-cyan-300">
                {activeReadout.dropped ? 'TIMEOUT' : `${activeReadout.rttMs.toFixed(3)} ms`}
              </span>{' '}
              · {activeReadout.watchdogState}
            </span>
          )}
        </div>
      </div>

      <svg
        ref={svgRef}
        viewBox="0 0 940 165"
        className="w-full h-[165px] select-none"
      />
    </div>
  );
};
