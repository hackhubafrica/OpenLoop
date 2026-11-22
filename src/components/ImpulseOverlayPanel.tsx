import React, { useMemo, useState } from 'react';
import { ControlModel, SimulationTrace } from '../types/control';
import { computeImpulseResponse } from '../engine/stability';

interface ImpulseOverlayPanelProps {
  model: ControlModel;
  trace: SimulationTrace;
  activeIndex: number;
  onScrubIndex: (idx: number) => void;
}

function formatAxisTick(val: number): string {
  if (Math.abs(val) < 1e-10) return '0.00';
  if (Math.abs(val) < 0.01 || Math.abs(val) >= 1000) {
    return val.toExponential(1);
  }
  return val.toFixed(2);
}

export const ImpulseOverlayPanel: React.FC<ImpulseOverlayPanelProps> = ({
  model,
  trace,
  activeIndex,
  onScrubIndex,
}) => {
  const [outputIdx, setOutputIdx] = useState<number>(0);
  const [simSource, setSimSource] = useState<'mil' | 'sil'>('mil');
  const [impulseMode, setImpulseMode] = useState<'closed' | 'open'>('closed');
  const [alignMode, setAlignMode] = useState<'t0' | 'dist'>('t0');
  const [scaleMode, setScaleMode] = useState<'dual' | 'shared'>('dual');
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  const safeOutIdx = Math.min(outputIdx, Math.max(0, model.plant.p - 1));
  const samples = trace.samples;
  const displayIdx = hoverIdx !== null ? hoverIdx : activeIndex;
  const safeDisplayIdx = Math.min(
    Math.max(0, displayIdx),
    Math.max(0, samples.length - 1)
  );
  const currentSample = samples[safeDisplayIdx];

  const impulse = useMemo(() => {
    const startShift =
      alignMode === 'dist'
        ? Math.max(0, Math.min(model.duration, model.reference.disturbanceTime))
        : 0;
    const simHorizon = Math.max(1e-4, model.duration - startShift);
    return computeImpulseResponse(
      model,
      impulseMode,
      safeOutIdx,
      0,
      simHorizon,
      240
    );
  }, [model, impulseMode, safeOutIdx, alignMode]);

  const width = 920;
  const height = 220;
  const padL = 56;
  const padR = 56;
  const padT = 18;
  const padB = 26;
  const plotW = width - padL - padR;
  const plotH = height - padT - padB;

  const {
    simPath,
    impPath,
    impAreaPath,
    yMinSim,
    yMaxSim,
    yMinImp,
    yMaxImp,
    zeroSimY,
    zeroImpY,
    impPeakPx,
    impAtSample,
    unitLabel,
    channelLabel,
  } = useMemo(() => {
    const unit = model.plant.outputUnits[safeOutIdx] ?? '';
    const chName = model.plant.outputNames[safeOutIdx] ?? `y_${safeOutIdx}`;

    if (samples.length === 0) {
      return {
        simPath: '',
        impPath: '',
        impAreaPath: '',
        yMinSim: -1,
        yMaxSim: 1,
        yMinImp: -1,
        yMaxImp: 1,
        zeroSimY: null as number | null,
        zeroImpY: null as number | null,
        impPeakPx: null as { x: number; y: number } | null,
        impAtSample: [] as number[],
        unitLabel: unit,
        channelLabel: chName,
      };
    }

    const startShift =
      alignMode === 'dist'
        ? Math.max(0, Math.min(model.duration, model.reference.disturbanceTime))
        : 0;

    // Sample analytical/RK4 impulse response at each simulation sample timestamp
    const evalImpulseAtTime = (t: number): number => {
      const tau = t - startShift;
      if (tau < -1e-12) return 0;
      const pts = impulse.points;
      if (pts.length === 0) return 0;
      if (tau <= pts[0].t) return pts[0].h;
      const lastPt = pts[pts.length - 1];
      if (tau >= lastPt.t) return lastPt.h;
      const frac = (tau / Math.max(1e-12, impulse.horizonSec)) * (pts.length - 1);
      const idx0 = Math.min(pts.length - 2, Math.max(0, Math.floor(frac)));
      const p0 = pts[idx0];
      const p1 = pts[idx0 + 1];
      const segSpan = p1.t - p0.t;
      const alpha = segSpan > 1e-12 ? (tau - p0.t) / segSpan : 0;
      return p0.h + alpha * (p1.h - p0.h);
    };

    const simValues = samples.map((s) =>
      simSource === 'mil'
        ? s.milOutputs[safeOutIdx] ?? 0
        : s.silOutputs[safeOutIdx] ?? 0
    );
    const impSampleValues = samples.map((s) => evalImpulseAtTime(s.t));

    let minS = Infinity;
    let maxS = -Infinity;
    for (const v of simValues) {
      if (v < minS) minS = v;
      if (v > maxS) maxS = v;
    }

    let minI = 0;
    let maxI = 0;
    for (const pt of impulse.points) {
      if (pt.h < minI) minI = pt.h;
      if (pt.h > maxI) maxI = pt.h;
    }

    if (scaleMode === 'shared') {
      const combMin = Math.min(minS, minI);
      const combMax = Math.max(maxS, maxI);
      minS = combMin;
      minI = combMin;
      maxS = combMax;
      maxI = combMax;
    }

    const spanS = Math.max(1e-4, maxS - minS);
    const loS = minS - spanS * 0.14;
    const hiS = maxS + spanS * 0.14;

    const spanI = Math.max(1e-4, maxI - minI);
    const loI = minI - spanI * 0.14;
    const hiI = maxI + spanI * 0.14;

    const dur = Math.max(1e-6, model.duration);
    const toXTime = (t: number) => padL + Math.min(1, Math.max(0, t / dur)) * plotW;
    const toYSim = (v: number) => padT + (1 - (v - loS) / (hiS - loS)) * plotH;
    const toYImp = (v: number) => padT + (1 - (v - loI) / (hiI - loI)) * plotH;

    let sPath = '';
    for (let i = 0; i < samples.length; i++) {
      const x = toXTime(samples[i].t).toFixed(1);
      const y = toYSim(simValues[i]).toFixed(1);
      sPath += i === 0 ? `M ${x} ${y}` : ` L ${x} ${y}`;
    }

    // Build impulse curve over full [0, duration] (pre-disturbance flat zero + active transient)
    const impCurveCoords: { x: number; y: number }[] = [];
    if (startShift > 1e-9) {
      const yZero = toYImp(0);
      impCurveCoords.push({ x: toXTime(0), y: yZero });
      impCurveCoords.push({ x: toXTime(startShift), y: yZero });
    }
    for (const pt of impulse.points) {
      const tAbs = startShift + pt.t;
      if (tAbs > dur + 1e-9) break;
      impCurveCoords.push({ x: toXTime(tAbs), y: toYImp(pt.h) });
    }

    let iPath = '';
    let iArea = '';
    const clampedBaseY = Math.min(padT + plotH, Math.max(padT, toYImp(0)));
    if (impCurveCoords.length > 0) {
      iPath = impCurveCoords
        .map((c, idx) => `${idx === 0 ? 'M' : 'L'} ${c.x.toFixed(1)} ${c.y.toFixed(1)}`)
        .join(' ');
      const firstX = impCurveCoords[0].x.toFixed(1);
      const lastX = impCurveCoords[impCurveCoords.length - 1].x.toFixed(1);
      iArea = `${iPath} L ${lastX} ${clampedBaseY.toFixed(1)} L ${firstX} ${clampedBaseY.toFixed(1)} Z`;
    }

    const peakT = startShift + impulse.peakTimeSec;
    const peakCoord =
      peakT <= dur + 1e-9
        ? { x: toXTime(peakT), y: toYImp(impulse.peakValue) }
        : null;

    const zSim = loS <= 0 && hiS >= 0 ? toYSim(0) : null;
    const zImp = loI <= 0 && hiI >= 0 ? toYImp(0) : null;

    return {
      simPath: sPath,
      impPath: iPath,
      impAreaPath: iArea,
      yMinSim: loS,
      yMaxSim: hiS,
      yMinImp: loI,
      yMaxImp: hiI,
      zeroSimY: zSim,
      zeroImpY: zImp,
      impPeakPx: peakCoord,
      impAtSample: impSampleValues,
      unitLabel: unit,
      channelLabel: chName,
    };
  }, [
    samples,
    safeOutIdx,
    simSource,
    scaleMode,
    alignMode,
    impulse,
    model,
    plotW,
    plotH,
  ]);

  const handlePointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    if (samples.length === 0) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const relX = ((e.clientX - rect.left) / rect.width) * width;
    const norm = Math.max(0, Math.min(1, (relX - padL) / plotW));
    setHoverIdx(Math.round(norm * (samples.length - 1)));
  };

  const handleClick = (e: React.PointerEvent<SVGSVGElement>) => {
    if (samples.length === 0) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const relX = ((e.clientX - rect.left) / rect.width) * width;
    const norm = Math.max(0, Math.min(1, (relX - padL) / plotW));
    onScrubIndex(Math.round(norm * (samples.length - 1)));
  };

  const cursorX =
    samples.length > 1
      ? padL + (safeDisplayIdx / (samples.length - 1)) * plotW
      : padL;

  const distMarkerX =
    model.reference.disturbanceTime > 0 &&
    model.reference.disturbanceTime < model.duration
      ? padL + (model.reference.disturbanceTime / Math.max(1e-6, model.duration)) * plotW
      : null;

  const currentSimVal = currentSample
    ? simSource === 'mil'
      ? currentSample.milOutputs[safeOutIdx] ?? 0
      : currentSample.silOutputs[safeOutIdx] ?? 0
    : 0;
  const currentImpVal = impAtSample[safeDisplayIdx] ?? 0;

  const simValsAll = samples.map((s) =>
    simSource === 'mil'
      ? s.milOutputs[safeOutIdx] ?? 0
      : s.silOutputs[safeOutIdx] ?? 0
  );
  const simPeakVal = simValsAll.reduce(
    (best, v) => (Math.abs(v) > Math.abs(best) ? v : best),
    simValsAll[0] ?? 0
  );
  const simFinalVal = simValsAll[simValsAll.length - 1] ?? 0;

  const yFracs = [0, 0.25, 0.5, 0.75, 1];
  const xFracs = [0, 0.25, 0.5, 0.75, 1];

  return (
    <section
      aria-label="Impulse Response vs Simulated Output Overlay"
      className="border-t border-slate-800 bg-[#0B0E17] flex flex-col shrink-0"
    >
      {/* Panel Header & Controls */}
      <div className="px-4 py-2.5 border-b border-slate-800/80 bg-[#0F141E] flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <div>
            <h3 className="text-xs font-semibold text-slate-200 whitespace-nowrap">
              Time-Domain Impulse Response Overlay
            </h3>
            <p className="text-[11px] text-slate-400 whitespace-nowrap">
              Calculated unit impulse h(t) vs simulated system output ({channelLabel})
            </p>
          </div>

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
          {/* Impulse Loop Mode */}
          <div className="flex items-center gap-0.5 p-0.5 bg-[#07090E] border border-slate-800 rounded">
            <button
              type="button"
              onClick={() => setImpulseMode('closed')}
              className={`px-2 py-0.5 text-[10px] font-mono rounded transition-colors cursor-pointer whitespace-nowrap ${
                impulseMode === 'closed'
                  ? 'bg-slate-800 text-violet-300'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              Closed h_cl(t)
            </button>
            <button
              type="button"
              onClick={() => setImpulseMode('open')}
              className={`px-2 py-0.5 text-[10px] font-mono rounded transition-colors cursor-pointer whitespace-nowrap ${
                impulseMode === 'open'
                  ? 'bg-slate-800 text-violet-300'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              Open h(t)
            </button>
          </div>

          {/* Time Alignment */}
          <div className="flex items-center gap-0.5 p-0.5 bg-[#07090E] border border-slate-800 rounded">
            <button
              type="button"
              onClick={() => setAlignMode('t0')}
              className={`px-2 py-0.5 text-[10px] font-mono rounded transition-colors cursor-pointer whitespace-nowrap ${
                alignMode === 't0'
                  ? 'bg-slate-800 text-slate-100'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              t = 0
            </button>
            <button
              type="button"
              onClick={() => setAlignMode('dist')}
              className={`px-2 py-0.5 text-[10px] font-mono rounded transition-colors cursor-pointer whitespace-nowrap ${
                alignMode === 'dist'
                  ? 'bg-slate-800 text-amber-300'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              Align t_dist
            </button>
          </div>

          {/* Sim Trace Source */}
          <div className="flex items-center gap-0.5 p-0.5 bg-[#07090E] border border-slate-800 rounded">
            {(['mil', 'sil'] as const).map((src) => (
              <button
                key={src}
                type="button"
                onClick={() => setSimSource(src)}
                className={`px-2 py-0.5 text-[10px] font-mono uppercase rounded transition-colors cursor-pointer whitespace-nowrap ${
                  simSource === src
                    ? 'bg-slate-800 text-cyan-300'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                {src}
              </button>
            ))}
          </div>

          {/* Scale Mode */}
          <div className="flex items-center gap-0.5 p-0.5 bg-[#07090E] border border-slate-800 rounded">
            <button
              type="button"
              onClick={() => setScaleMode('dual')}
              className={`px-2 py-0.5 text-[10px] font-mono rounded transition-colors cursor-pointer whitespace-nowrap ${
                scaleMode === 'dual'
                  ? 'bg-slate-800 text-cyan-300'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              Dual Axis
            </button>
            <button
              type="button"
              onClick={() => setScaleMode('shared')}
              className={`px-2 py-0.5 text-[10px] font-mono rounded transition-colors cursor-pointer whitespace-nowrap ${
                scaleMode === 'shared'
                  ? 'bg-slate-800 text-cyan-300'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              1:1 Shared
            </button>
          </div>
        </div>
      </div>

      {/* Legend + Live Probe Readout */}
      <div className="px-4 py-1.5 border-b border-slate-800/60 bg-[#07090E] flex flex-wrap items-center justify-between gap-3 text-[11px] font-mono tabular-nums">
        <div className="flex flex-wrap items-center gap-4">
          <span className="inline-flex items-center gap-1.5 text-cyan-300">
            <span className="w-3.5 h-0.5 bg-cyan-400 inline-block" />
            <span>
              Simulated Output ({simSource.toUpperCase()}) [{unitLabel || 'u'}]
            </span>
          </span>
          <span className="inline-flex items-center gap-1.5 text-violet-300">
            <span className="w-3.5 h-0.5 bg-violet-400 inline-block" />
            <span>
              Impulse Response ({impulseMode === 'closed' ? 'h_cl' : 'h_ol'})
            </span>
          </span>
          {distMarkerX !== null && (
            <span className="inline-flex items-center gap-1.5 text-amber-300/90">
              <span className="w-3 border-t border-dashed border-amber-400 inline-block" />
              <span>t_dist = {model.reference.disturbanceTime}s</span>
            </span>
          )}
        </div>

        {currentSample && (
          <div className="flex flex-wrap items-center gap-3 text-slate-300">
            <span>t={currentSample.t.toFixed(4)}s</span>
            <span className="text-cyan-400">
              y_sim={currentSimVal.toFixed(3)} {unitLabel}
            </span>
            <span className="text-violet-300">
              h(t)={currentImpVal.toFixed(4)}
            </span>
          </div>
        )}
      </div>

      {/* SVG Dual/Overlay Waveform Plot */}
      <div className="relative px-2 py-1 bg-[#07090E]">
        <svg
          viewBox={`0 0 ${width} ${height}`}
          aria-label="Calculated impulse response overlaid against simulated system output"
          className="w-full h-[220px] cursor-crosshair select-none"
          onPointerMove={handlePointerMove}
          onPointerLeave={() => setHoverIdx(null)}
          onClick={handleClick}
        >
          {/* Horizontal grid lines + Left/Right Y-axis labels */}
          {yFracs.map((frac) => {
            const y = padT + frac * plotH;
            const simVal = yMaxSim - frac * (yMaxSim - yMinSim);
            const impVal = yMaxImp - frac * (yMaxImp - yMinImp);
            return (
              <g key={frac}>
                <line
                  x1={padL}
                  y1={y}
                  x2={width - padR}
                  y2={y}
                  stroke="#1E293B"
                  strokeWidth="1"
                />
                <text
                  x={padL - 8}
                  y={y + 3}
                  textAnchor="end"
                  fill="#22D3EE"
                  fillOpacity="0.85"
                  fontSize="9.5"
                  fontFamily="IBM Plex Mono, monospace"
                >
                  {formatAxisTick(simVal)}
                </text>
                {scaleMode === 'dual' && (
                  <text
                    x={width - padR + 8}
                    y={y + 3}
                    textAnchor="start"
                    fill="#C4B5FD"
                    fillOpacity="0.85"
                    fontSize="9.5"
                    fontFamily="IBM Plex Mono, monospace"
                  >
                    {formatAxisTick(impVal)}
                  </text>
                )}
              </g>
            );
          })}

          {/* Vertical time grid lines */}
          {xFracs.map((frac) => {
            const x = padL + frac * plotW;
            const tVal = frac * model.duration;
            return (
              <g key={frac}>
                <line
                  x1={x}
                  y1={padT}
                  x2={x}
                  y2={padT + plotH}
                  stroke="#151D2B"
                  strokeWidth="1"
                />
                <text
                  x={x}
                  y={height - 7}
                  textAnchor="middle"
                  fill="#64748B"
                  fontSize="9.5"
                  fontFamily="IBM Plex Mono, monospace"
                >
                  {tVal.toFixed(model.duration < 0.1 ? 4 : 2)}s
                </text>
              </g>
            );
          })}

          {/* Zero baseline */}
          {zeroSimY !== null && (
            <line
              x1={padL}
              y1={zeroSimY}
              x2={width - padR}
              y2={zeroSimY}
              stroke="#475569"
              strokeWidth="1"
              strokeDasharray="3 3"
            />
          )}
          {scaleMode === 'dual' && zeroImpY !== null && (
            <line
              x1={padL}
              y1={zeroImpY}
              x2={width - padR}
              y2={zeroImpY}
              stroke="#7C3AED"
              strokeOpacity="0.35"
              strokeWidth="1"
              strokeDasharray="2 4"
            />
          )}

          {/* Disturbance impulse timestamp marker */}
          {distMarkerX !== null && (
            <line
              x1={distMarkerX}
              y1={padT}
              x2={distMarkerX}
              y2={padT + plotH}
              stroke="#F59E0B"
              strokeOpacity="0.55"
              strokeWidth="1.1"
              strokeDasharray="4 3"
            />
          )}

          {/* Calculated Impulse Envelope Area */}
          {impAreaPath && (
            <path d={impAreaPath} fill="#A78BFA" fillOpacity="0.1" />
          )}

          {/* Simulated Output Curve */}
          {simPath && (
            <path
              d={simPath}
              fill="none"
              stroke="#06B6D4"
              strokeWidth="2"
            />
          )}

          {/* Calculated Impulse Response Curve */}
          {impPath && (
            <path
              d={impPath}
              fill="none"
              stroke="#A78BFA"
              strokeWidth="1.8"
            />
          )}

          {/* Impulse Peak Marker */}
          {impPeakPx && (
            <circle
              cx={impPeakPx.x}
              cy={impPeakPx.y}
              r="3.2"
              fill="#A78BFA"
              stroke="#07090E"
              strokeWidth="1"
            />
          )}

          {/* Synchronized Crosshair Vertical Cursor */}
          <line
            x1={cursorX}
            y1={padT}
            x2={cursorX}
            y2={padT + plotH}
            stroke="#94A3B8"
            strokeOpacity="0.65"
            strokeWidth="1"
          />

          {/* Axis Annotations */}
          <text
            x={padL + 6}
            y={padT + 11}
            fill="#22D3EE"
            fontSize="9.5"
            fontFamily="IBM Plex Mono, monospace"
          >
            y_sim ({unitLabel || 'u'})
          </text>
          {scaleMode === 'dual' && (
            <text
              x={width - padR - 6}
              y={padT + 11}
              textAnchor="end"
              fill="#C4B5FD"
              fontSize="9.5"
              fontFamily="IBM Plex Mono, monospace"
            >
              h(t) unit impulse
            </text>
          )}
        </svg>
      </div>

      {/* Impulse & Output Comparison Summary Bar */}
      <div className="px-4 py-2 border-t border-slate-800/80 bg-[#0F141E] grid grid-cols-2 sm:grid-cols-4 gap-4 text-xs font-mono tabular-nums">
        <div>
          <div className="text-[11px] font-sans text-slate-400">
            Impulse Peak h_peak
          </div>
          <div className="text-violet-300 font-semibold mt-0.5">
            {impulse.peakValue.toFixed(4)}{' '}
            <span className="text-[10px] font-normal text-slate-400">
              @ {impulse.peakTimeSec.toFixed(impulse.horizonSec < 0.1 ? 4 : 3)}s
            </span>
          </div>
        </div>
        <div>
          <div className="text-[11px] font-sans text-slate-400">
            Impulse Settling (2%)
          </div>
          <div
            className={`font-semibold mt-0.5 ${
              impulse.divergent ? 'text-rose-400' : 'text-slate-100'
            }`}
          >
            {impulse.divergent
              ? 'Divergent'
              : impulse.settlingTimeSec !== null
              ? `${impulse.settlingTimeSec.toFixed(impulse.horizonSec < 0.1 ? 4 : 3)} s`
              : `> ${impulse.horizonSec.toFixed(2)} s`}
          </div>
        </div>
        <div>
          <div className="text-[11px] font-sans text-slate-400">
            Impulse L₂ Energy
          </div>
          <div className="text-slate-100 font-semibold mt-0.5">
            {impulse.l2Energy < 0.01 && impulse.l2Energy > 0
              ? impulse.l2Energy.toExponential(2)
              : impulse.l2Energy.toFixed(4)}
          </div>
        </div>
        <div>
          <div className="text-[11px] font-sans text-slate-400">
            Simulated Output Peak / Final
          </div>
          <div className="text-cyan-300 font-semibold mt-0.5">
            {simPeakVal.toFixed(3)} / {simFinalVal.toFixed(3)}{' '}
            <span className="text-[10px] font-normal text-slate-400">
              {unitLabel}
            </span>
          </div>
        </div>
      </div>
    </section>
  );
};
