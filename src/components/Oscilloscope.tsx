import React, { useMemo, useState } from 'react';
import { Check, Download, TrendingUp } from 'lucide-react';
import { ControlModel, SimulationTrace } from '../types/control';
import { computeTransferFunctionStepResponse } from '../engine/stability';
import { exportTraceAsSvg, SvgThemeMode } from '../utils/exportTraceSvg';

interface OscilloscopeProps {
  model: ControlModel;
  trace: SimulationTrace;
  activeIndex: number;
  onScrubIndex: (idx: number) => void;
  showStepResponse: boolean;
  onToggleStepResponse: () => void;
}

type ChannelSelection = number | 'effort';

function formatDurationMetric(sec: number | null, horizonSec: number): string {
  if (sec === null) return `> ${horizonSec.toFixed(horizonSec < 0.1 ? 3 : 2)} s`;
  if (sec > 0 && sec < 0.05) return `${(sec * 1000).toFixed(2)} ms`;
  return `${sec.toFixed(3)} s`;
}

function formatAxisTick(val: number): string {
  if (Math.abs(val) < 1e-10) return '0.00';
  if (Math.abs(val) < 0.01 || Math.abs(val) >= 1000) {
    return val.toExponential(1);
  }
  return val.toFixed(2);
}

export const Oscilloscope: React.FC<OscilloscopeProps> = ({
  model,
  trace,
  activeIndex,
  onScrubIndex,
  showStepResponse,
  onToggleStepResponse,
}) => {
  const [channel, setChannel] = useState<ChannelSelection>(0);
  const [showMil, setShowMil] = useState(true);
  const [showSil, setShowSil] = useState(true);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  // Step response overlay controls
  const [stepLoopMode, setStepLoopMode] = useState<'closed' | 'open'>('closed');
  const [stepScaleMode, setStepScaleMode] = useState<'dual' | 'shared'>('dual');
  const [stepHorizonMode, setStepHorizonMode] = useState<'sim' | 'auto'>('sim');

  // Vector SVG export controls
  const [svgTheme, setSvgTheme] = useState<SvgThemeMode>('publication');
  const [svgExported, setSvgExported] = useState(false);

  const handleExportTraceSvg = () => {
    exportTraceAsSvg(model, trace, {
      channel,
      showMil,
      showSil,
      theme: svgTheme,
    });
    setSvgExported(true);
    window.setTimeout(() => setSvgExported(false), 1800);
  };

  const activeOutputIdx =
    channel === 'effort'
      ? 0
      : Math.min(channel, Math.max(0, model.plant.p - 1));
  const isEffort = channel === 'effort';

  const samples = trace.samples;
  const displayIdx = hoverIdx !== null ? hoverIdx : activeIndex;
  const currentSample = samples[Math.min(samples.length - 1, Math.max(0, displayIdx))];

  const stepAnalysis = useMemo(() => {
    if (!showStepResponse) return null;
    return computeTransferFunctionStepResponse(
      model,
      stepLoopMode,
      activeOutputIdx,
      0,
      stepHorizonMode === 'sim' ? model.duration : undefined,
      240
    );
  }, [showStepResponse, model, stepLoopMode, activeOutputIdx, stepHorizonMode]);

  const width = 920;
  const height = 220;
  const padL = 56;
  const padR = showStepResponse && stepScaleMode === 'dual' ? 56 : 16;
  const padT = 18;
  const padB = 26;
  const plotW = width - padL - padR;
  const plotH = height - padT - padB;

  const activeHorizonSec =
    showStepResponse && stepAnalysis ? stepAnalysis.horizonSec : model.duration;

  const {
    yMin,
    yMax,
    yStepMin,
    yStepMax,
    milPath,
    silPath,
    refPath,
    stepInputPath,
    stepOutputPath,
    riseBandRect,
    t10Coord,
    t90Coord,
    settlingBandRect,
    settlingLineX,
    unitLabel,
    titleLabel,
    stepValueAtCursor,
  } = useMemo(() => {
    if (samples.length === 0) {
      return {
        yMin: -1,
        yMax: 1,
        yStepMin: -0.2,
        yStepMax: 1.2,
        milPath: '',
        silPath: '',
        refPath: '',
        stepInputPath: '',
        stepOutputPath: '',
        riseBandRect: null as { x: number; w: number; y10: number; y90: number } | null,
        t10Coord: null as { x: number; y: number } | null,
        t90Coord: null as { x: number; y: number } | null,
        settlingBandRect: null as { yTop: number; h: number } | null,
        settlingLineX: null as number | null,
        unitLabel: '',
        titleLabel: '',
        stepValueAtCursor: null as number | null,
      };
    }

    const extract = (sIdx: number) => {
      const s = samples[sIdx];
      if (!isEffort) {
        return {
          mil: s.milOutputs[activeOutputIdx] ?? 0,
          sil: s.silOutputs[activeOutputIdx] ?? 0,
          ref:
            activeOutputIdx === 0
              ? s.ref
              : activeOutputIdx === 1 && model.id === 'pendulum'
              ? 0
              : null,
        };
      }
      return {
        mil: s.uRaw,
        sil: s.uSat,
        ref: null,
      };
    };

    let minV = Infinity;
    let maxV = -Infinity;
    for (let i = 0; i < samples.length; i++) {
      const { mil, sil, ref } = extract(i);
      minV = Math.min(minV, mil, sil, ref ?? mil);
      maxV = Math.max(maxV, mil, sil, ref ?? mil);
    }

    if (isEffort) {
      minV = Math.min(minV, model.limits.satMin);
      maxV = Math.max(maxV, model.limits.satMax);
    }

    let stepMin = 0;
    let stepMax = 1.0;
    if (showStepResponse && stepAnalysis && stepAnalysis.points.length > 0) {
      for (const pt of stepAnalysis.points) {
        if (Number.isFinite(pt.y)) {
          stepMin = Math.min(stepMin, pt.y);
          stepMax = Math.max(stepMax, pt.y);
        }
      }
      if (stepScaleMode === 'shared') {
        minV = Math.min(minV, stepMin);
        maxV = Math.max(maxV, stepMax);
        stepMin = minV;
        stepMax = maxV;
      }
    }

    const span = Math.max(1e-4, maxV - minV);
    const lo = minV - span * 0.12;
    const hi = maxV + span * 0.12;

    const stepSpan = Math.max(1e-4, stepMax - stepMin);
    const stepLo = stepScaleMode === 'shared' ? lo : stepMin - stepSpan * 0.14;
    const stepHi = stepScaleMode === 'shared' ? hi : stepMax + stepSpan * 0.14;

    const toX = (i: number) =>
      padL + (i / Math.max(1, samples.length - 1)) * plotW;
    const toY = (v: number) =>
      padT + (1 - (v - lo) / (hi - lo)) * plotH;
    const toXStepTime = (t: number) =>
      padL +
      Math.min(1, Math.max(0, t / Math.max(1e-9, activeHorizonSec))) * plotW;
    const toYStep = (v: number) =>
      padT + (1 - (v - stepLo) / (stepHi - stepLo)) * plotH;

    let mPath = '';
    let sPath = '';
    let rPath = '';

    for (let i = 0; i < samples.length; i++) {
      const { mil, sil, ref } = extract(i);
      const x = toX(i).toFixed(1);
      const ym = toY(mil).toFixed(1);
      const ys = toY(sil).toFixed(1);
      mPath += i === 0 ? `M ${x} ${ym}` : ` L ${x} ${ym}`;
      sPath += i === 0 ? `M ${x} ${ys}` : ` L ${x} ${ys}`;
      if (ref !== null) {
        const yr = toY(ref).toFixed(1);
        rPath += i === 0 ? `M ${x} ${yr}` : ` L ${x} ${yr}`;
      }
    }

    let uStepPath = '';
    let yStepPath = '';
    let rBand: { x: number; w: number; y10: number; y90: number } | null = null;
    let pt10: { x: number; y: number } | null = null;
    let pt90: { x: number; y: number } | null = null;
    let sBand: { yTop: number; h: number } | null = null;
    let sLineX: number | null = null;
    let cursorStepVal: number | null = null;

    if (showStepResponse && stepAnalysis && stepAnalysis.points.length > 0) {
      const yStep0 = toYStep(0).toFixed(1);
      const yStep1 = toYStep(1).toFixed(1);
      uStepPath = `M ${padL.toFixed(1)} ${yStep0} L ${padL.toFixed(1)} ${yStep1} L ${(
        width - padR
      ).toFixed(1)} ${yStep1}`;

      yStepPath = stepAnalysis.points
        .map((pt, idx) => {
          const px = toXStepTime(pt.t).toFixed(1);
          const py = toYStep(pt.y).toFixed(1);
          return idx === 0 ? `M ${px} ${py}` : ` L ${px} ${py}`;
        })
        .join('');

      if (!stepAnalysis.divergent) {
        if (
          stepAnalysis.t10Sec !== null &&
          stepAnalysis.t90Sec !== null &&
          stepAnalysis.y10 !== null &&
          stepAnalysis.y90 !== null
        ) {
          const x10 = toXStepTime(stepAnalysis.t10Sec);
          const x90 = toXStepTime(stepAnalysis.t90Sec);
          const y10Px = toYStep(stepAnalysis.y10);
          const y90Px = toYStep(stepAnalysis.y90);
          rBand = {
            x: Math.min(x10, x90),
            w: Math.max(1.5, Math.abs(x90 - x10)),
            y10: y10Px,
            y90: y90Px,
          };
          pt10 = { x: x10, y: y10Px };
          pt90 = { x: x90, y: y90Px };
        }

        if (
          stepAnalysis.settlingBandLow !== null &&
          stepAnalysis.settlingBandHigh !== null
        ) {
          const yHighPx = toYStep(stepAnalysis.settlingBandHigh);
          const yLowPx = toYStep(stepAnalysis.settlingBandLow);
          const clampedTop = Math.max(padT, Math.min(yHighPx, yLowPx));
          const clampedBot = Math.min(padT + plotH, Math.max(yHighPx, yLowPx));
          if (clampedBot > clampedTop) {
            sBand = { yTop: clampedTop, h: clampedBot - clampedTop };
          }
        }

        if (stepAnalysis.settlingTimeSec !== null) {
          sLineX = toXStepTime(stepAnalysis.settlingTimeSec);
        }
      }

      // Evaluate step response value at current cursor fraction
      const frac =
        samples.length > 1 ? displayIdx / (samples.length - 1) : 0;
      const pts = stepAnalysis.points;
      const floatIdx = frac * (pts.length - 1);
      const i0 = Math.min(pts.length - 2, Math.max(0, Math.floor(floatIdx)));
      const a = floatIdx - i0;
      cursorStepVal = pts[i0].y + a * (pts[i0 + 1].y - pts[i0].y);
    }

    const unit = isEffort
      ? model.plant.inputUnit
      : model.plant.outputUnits[activeOutputIdx] ?? '';

    const title = isEffort
      ? `${model.plant.inputName} (Raw vs Clamped)`
      : model.plant.outputNames[activeOutputIdx] ?? `y_${activeOutputIdx}`;

    return {
      yMin: lo,
      yMax: hi,
      yStepMin: stepLo,
      yStepMax: stepHi,
      milPath: mPath,
      silPath: sPath,
      refPath: rPath,
      stepInputPath: uStepPath,
      stepOutputPath: yStepPath,
      riseBandRect: rBand,
      t10Coord: pt10,
      t90Coord: pt90,
      settlingBandRect: sBand,
      settlingLineX: sLineX,
      unitLabel: unit,
      titleLabel: title,
      stepValueAtCursor: cursorStepVal,
    };
  }, [
    samples,
    isEffort,
    activeOutputIdx,
    model,
    plotW,
    plotH,
    padR,
    showStepResponse,
    stepAnalysis,
    stepScaleMode,
    activeHorizonSec,
    displayIdx,
  ]);

  const handlePointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    if (samples.length === 0) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const relX = ((e.clientX - rect.left) / rect.width) * width;
    const norm = Math.max(0, Math.min(1, (relX - padL) / plotW));
    const idx = Math.round(norm * (samples.length - 1));
    setHoverIdx(idx);
  };

  const handleClick = (e: React.PointerEvent<SVGSVGElement>) => {
    if (samples.length === 0) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const relX = ((e.clientX - rect.left) / rect.width) * width;
    const norm = Math.max(0, Math.min(1, (relX - padL) / plotW));
    const idx = Math.round(norm * (samples.length - 1));
    onScrubIndex(idx);
  };

  const cursorX =
    samples.length > 1
      ? padL + (displayIdx / (samples.length - 1)) * plotW
      : padL;

  const yTicks = [0, 0.25, 0.5, 0.75, 1];
  const xTicks = [0, 0.25, 0.5, 0.75, 1];

  const stepOutputName =
    model.plant.outputNames[activeOutputIdx] ?? `y_${activeOutputIdx}`;
  const stepOutputUnit = model.plant.outputUnits[activeOutputIdx] ?? '';
  const steadyVal =
    stepAnalysis && !stepAnalysis.divergent
      ? stepAnalysis.dcSteadyState ?? stepAnalysis.finalValue
      : null;

  return (
    <div className="border-t border-slate-800 bg-[#0B0E17] flex flex-col">
      {/* Scope Toolbar */}
      <div className="px-4 py-2 border-b border-slate-800/80 flex flex-wrap items-center justify-between gap-4">
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-xs font-semibold text-slate-200 whitespace-nowrap">
            Oscilloscope
          </span>
          <div className="flex items-center gap-1 p-0.5 bg-[#07090E] border border-slate-800 rounded-md overflow-x-auto">
            {Array.from({ length: model.plant.p }, (_, idx) => (
              <button
                key={idx}
                type="button"
                onClick={() => setChannel(idx)}
                className={`px-2.5 py-1 text-[11px] font-medium rounded transition-colors whitespace-nowrap cursor-pointer ${
                  !isEffort && activeOutputIdx === idx
                    ? 'bg-slate-800 text-cyan-300'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                {model.plant.outputNames[idx] ?? `y_${idx}`}
              </button>
            ))}
            <button
              type="button"
              onClick={() => setChannel('effort')}
              className={`px-2.5 py-1 text-[11px] font-medium rounded transition-colors whitespace-nowrap cursor-pointer ${
                isEffort
                  ? 'bg-slate-800 text-amber-300'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              Actuator Effort (u)
            </button>
          </div>

          <button
            type="button"
            aria-pressed={showStepResponse}
            onClick={onToggleStepResponse}
            className={`inline-flex items-center gap-1.5 px-2.5 py-1 text-[11px] font-medium rounded border transition-colors cursor-pointer whitespace-nowrap shrink-0 ${
              showStepResponse
                ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/40'
                : 'bg-[#07090E] text-slate-300 border-slate-800 hover:border-slate-700 hover:text-slate-100'
            }`}
          >
            <TrendingUp className="w-3 h-3 text-emerald-400" />
            Step Response
          </button>

          {/* Publication Vector SVG Export */}
          <div className="inline-flex items-center rounded border border-slate-800 bg-[#07090E] p-0.5 shrink-0">
            <button
              type="button"
              onClick={() =>
                setSvgTheme((t) => (t === 'publication' ? 'dark' : 'publication'))
              }
              title="Toggle exported SVG palette between Publication (Light) and Console (Dark)"
              className="px-2 py-0.5 text-[10px] font-mono text-slate-400 hover:text-slate-200 rounded transition-colors cursor-pointer whitespace-nowrap"
            >
              {svgTheme === 'publication' ? 'Paper' : 'Dark'}
            </button>
            <button
              type="button"
              onClick={handleExportTraceSvg}
              title="Export current simulation trace as a clean vector SVG file"
              className={`inline-flex items-center gap-1 px-2.5 py-0.5 text-[11px] font-medium rounded transition-colors cursor-pointer whitespace-nowrap ${
                svgExported
                  ? 'bg-emerald-500/15 text-emerald-300'
                  : 'bg-slate-800 hover:bg-slate-700 text-cyan-200'
              }`}
            >
              {svgExported ? (
                <>
                  <Check className="w-3 h-3 text-emerald-400" />
                  SVG Saved
                </>
              ) : (
                <>
                  <Download className="w-3 h-3 text-cyan-300" />
                  Export SVG
                </>
              )}
            </button>
          </div>
        </div>

        {/* Trace Visibility & Live Crosshair Probe HUD */}
        <div className="flex flex-wrap items-center gap-4 text-xs font-mono tabular-nums">
          <button
            type="button"
            onClick={() => setShowMil((v) => !v)}
            className={`flex items-center gap-1.5 cursor-pointer transition-opacity ${
              showMil ? 'opacity-100 text-cyan-300' : 'opacity-40 text-slate-400'
            }`}
          >
            <span className="w-3 h-0.5 bg-cyan-400 inline-block" />
            <span>{isEffort ? 'u_raw' : 'MIL (RK4)'}</span>
          </button>
          <button
            type="button"
            onClick={() => setShowSil((v) => !v)}
            className={`flex items-center gap-1.5 cursor-pointer transition-opacity ${
              showSil ? 'opacity-100 text-amber-300' : 'opacity-40 text-slate-400'
            }`}
          >
            <span className="w-3 h-0.5 bg-amber-400 inline-block" />
            <span>
              {isEffort
                ? 'u_sat'
                : `SIL (${model.discretization.toUpperCase()} dt)`}
            </span>
          </button>

          {currentSample && (
            <div className="hidden lg:flex items-center gap-3 pl-3 border-l border-slate-800 text-[11px] text-slate-300">
              <span>t={currentSample.t.toFixed(4)}s</span>
              <span className="text-cyan-400">
                MIL:{' '}
                {(isEffort
                  ? currentSample.uRaw
                  : currentSample.milOutputs[activeOutputIdx] ?? 0
                ).toFixed(3)}
                {unitLabel}
              </span>
              <span className="text-amber-400">
                SIL:{' '}
                {(isEffort
                  ? currentSample.uSat
                  : currentSample.silOutputs[activeOutputIdx] ?? 0
                ).toFixed(3)}
                {unitLabel}
              </span>
              {showStepResponse && stepValueAtCursor !== null && (
                <span className="text-violet-300">
                  Step y:{' '}
                  {stepValueAtCursor.toFixed(3)}
                </span>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Step Response Overlay Configuration Strip */}
      {showStepResponse && (
        <div className="px-4 py-1.5 border-b border-slate-800/80 bg-[#0F141E] flex flex-wrap items-center justify-between gap-3 text-[11px]">
          <div className="flex flex-wrap items-center gap-4 font-mono">
            <span className="inline-flex items-center gap-1.5 text-emerald-300">
              <span className="w-3.5 border-t-2 border-dashed border-emerald-400 inline-block" />
              <span>Unit Step Input u(t) = 1</span>
            </span>
            <span className="inline-flex items-center gap-1.5 text-violet-300">
              <span className="w-3.5 h-0.5 bg-violet-400 inline-block" />
              <span>
                Step Output ({stepOutputName})
              </span>
            </span>
            <span className="inline-flex items-center gap-1.5 text-emerald-400/90">
              <span className="w-2.5 h-2.5 bg-emerald-400/20 border border-emerald-400/50 inline-block" />
              <span>Rise Band (10%→90%)</span>
            </span>
            <span className="inline-flex items-center gap-1.5 text-violet-300/90">
              <span className="w-2.5 h-2.5 bg-violet-400/20 border border-violet-400/50 inline-block" />
              <span>Settling Band (±2%)</span>
            </span>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {/* Loop Mode */}
            <div className="flex items-center gap-0.5 p-0.5 bg-[#07090E] border border-slate-800 rounded">
              <button
                type="button"
                onClick={() => setStepLoopMode('closed')}
                className={`px-2 py-0.5 text-[10px] font-mono rounded transition-colors cursor-pointer whitespace-nowrap ${
                  stepLoopMode === 'closed'
                    ? 'bg-slate-800 text-violet-300'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                Closed-Loop
              </button>
              <button
                type="button"
                onClick={() => setStepLoopMode('open')}
                className={`px-2 py-0.5 text-[10px] font-mono rounded transition-colors cursor-pointer whitespace-nowrap ${
                  stepLoopMode === 'open'
                    ? 'bg-slate-800 text-violet-300'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                Open-Loop
              </button>
            </div>

            {/* Horizon Mode */}
            <div className="flex items-center gap-0.5 p-0.5 bg-[#07090E] border border-slate-800 rounded">
              <button
                type="button"
                onClick={() => setStepHorizonMode('sim')}
                className={`px-2 py-0.5 text-[10px] font-mono rounded transition-colors cursor-pointer whitespace-nowrap ${
                  stepHorizonMode === 'sim'
                    ? 'bg-slate-800 text-cyan-300'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                Sim Window ({model.duration}s)
              </button>
              <button
                type="button"
                onClick={() => setStepHorizonMode('auto')}
                className={`px-2 py-0.5 text-[10px] font-mono rounded transition-colors cursor-pointer whitespace-nowrap ${
                  stepHorizonMode === 'auto'
                    ? 'bg-slate-800 text-cyan-300'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                Auto Horizon
              </button>
            </div>

            {/* Scale Mode */}
            <div className="flex items-center gap-0.5 p-0.5 bg-[#07090E] border border-slate-800 rounded">
              <button
                type="button"
                onClick={() => setStepScaleMode('dual')}
                className={`px-2 py-0.5 text-[10px] font-mono rounded transition-colors cursor-pointer whitespace-nowrap ${
                  stepScaleMode === 'dual'
                    ? 'bg-slate-800 text-cyan-300'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                Dual Axis
              </button>
              <button
                type="button"
                onClick={() => setStepScaleMode('shared')}
                className={`px-2 py-0.5 text-[10px] font-mono rounded transition-colors cursor-pointer whitespace-nowrap ${
                  stepScaleMode === 'shared'
                    ? 'bg-slate-800 text-cyan-300'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                1:1 Shared
              </button>
            </div>
          </div>
        </div>
      )}

      {/* SVG Waveform Canvas */}
      <div className="relative px-2 py-1 bg-[#07090E]">
        <svg
          viewBox={`0 0 ${width} ${height}`}
          aria-label="Simulation and step response oscilloscope"
          className="w-full h-[220px] cursor-crosshair select-none"
          onPointerMove={handlePointerMove}
          onPointerLeave={() => setHoverIdx(null)}
          onClick={handleClick}
        >
          {/* Horizontal grid lines */}
          {yTicks.map((frac) => {
            const y = padT + frac * plotH;
            const val = yMax - frac * (yMax - yMin);
            const stepTickVal = yStepMax - frac * (yStepMax - yStepMin);
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
                  fill="#64748B"
                  fontSize="9.5"
                  fontFamily="IBM Plex Mono, monospace"
                >
                  {formatAxisTick(val)}
                </text>
                {showStepResponse && stepScaleMode === 'dual' && (
                  <text
                    x={width - padR + 8}
                    y={y + 3}
                    textAnchor="start"
                    fill="#C4B5FD"
                    fillOpacity="0.85"
                    fontSize="9.5"
                    fontFamily="IBM Plex Mono, monospace"
                  >
                    {formatAxisTick(stepTickVal)}
                  </text>
                )}
              </g>
            );
          })}

          {/* Vertical time grid lines */}
          {xTicks.map((frac) => {
            const x = padL + frac * plotW;
            const tVal =
              frac *
              (showStepResponse && stepHorizonMode === 'auto'
                ? activeHorizonSec
                : model.duration);
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
                  {tVal.toFixed(activeHorizonSec < 0.1 ? 4 : 2)}s
                </text>
              </g>
            );
          })}

          {/* Step Response Settling Band (±2%) */}
          {showStepResponse && settlingBandRect && (
            <rect
              x={padL}
              y={settlingBandRect.yTop}
              width={plotW}
              height={settlingBandRect.h}
              fill="#A78BFA"
              fillOpacity="0.1"
            />
          )}

          {/* Step Response Rise-Time Interval Band (10% -> 90%) */}
          {showStepResponse && riseBandRect && (
            <g>
              <rect
                x={riseBandRect.x}
                y={padT}
                width={riseBandRect.w}
                height={plotH}
                fill="#10B981"
                fillOpacity="0.08"
              />
              <line
                x1={padL}
                y1={riseBandRect.y10}
                x2={width - padR}
                y2={riseBandRect.y10}
                stroke="#34D399"
                strokeOpacity="0.35"
                strokeWidth="1"
                strokeDasharray="2 4"
              />
              <line
                x1={padL}
                y1={riseBandRect.y90}
                x2={width - padR}
                y2={riseBandRect.y90}
                stroke="#34D399"
                strokeOpacity="0.35"
                strokeWidth="1"
                strokeDasharray="2 4"
              />
            </g>
          )}

          {/* Settling Time Vertical Marker */}
          {showStepResponse && settlingLineX !== null && (
            <g>
              <line
                x1={settlingLineX}
                y1={padT}
                x2={settlingLineX}
                y2={padT + plotH}
                stroke="#A78BFA"
                strokeOpacity="0.7"
                strokeWidth="1.2"
                strokeDasharray="4 3"
              />
              <text
                x={Math.min(width - padR - 24, settlingLineX + 4)}
                y={padT + 24}
                fill="#C4B5FD"
                fontSize="9"
                fontFamily="IBM Plex Mono, monospace"
              >
                t_s
              </text>
            </g>
          )}

          {/* Reference trace */}
          {refPath && (
            <path
              d={refPath}
              fill="none"
              stroke="#64748B"
              strokeWidth="1.2"
              strokeDasharray="4 4"
            />
          )}

          {/* MIL Continuous RK4 trace */}
          {showMil && milPath && (
            <path
              d={milPath}
              fill="none"
              stroke="#06B6D4"
              strokeWidth="1.8"
              strokeOpacity={showStepResponse ? 0.55 : 1}
            />
          )}

          {/* SIL Discrete Fixed-Step trace */}
          {showSil && silPath && (
            <path
              d={silPath}
              fill="none"
              stroke="#F59E0B"
              strokeWidth="1.6"
              strokeOpacity={showStepResponse ? 0.55 : 1}
              strokeDasharray={channel === 'effort' ? undefined : '5 2'}
            />
          )}

          {/* Unit Step Input Signal u(t) = 1 */}
          {showStepResponse && stepInputPath && (
            <path
              d={stepInputPath}
              fill="none"
              stroke="#10B981"
              strokeWidth="1.7"
              strokeDasharray="6 3"
            />
          )}

          {/* Corresponding System Step Output Trace y_step(t) */}
          {showStepResponse && stepOutputPath && (
            <path
              d={stepOutputPath}
              fill="none"
              stroke="#A78BFA"
              strokeWidth="2.2"
            />
          )}

          {/* Rise-Time 10% and 90% Marker Dots */}
          {showStepResponse && t10Coord && (
            <circle
              cx={t10Coord.x}
              cy={t10Coord.y}
              r="3.2"
              fill="#34D399"
              stroke="#07090E"
              strokeWidth="1"
            />
          )}
          {showStepResponse && t90Coord && (
            <circle
              cx={t90Coord.x}
              cy={t90Coord.y}
              r="3.2"
              fill="#34D399"
              stroke="#07090E"
              strokeWidth="1"
            />
          )}

          {/* Crosshair vertical cursor */}
          <line
            x1={cursorX}
            y1={padT}
            x2={cursorX}
            y2={padT + plotH}
            stroke="#94A3B8"
            strokeOpacity="0.6"
            strokeWidth="1"
          />

          {/* Top-left channel legend */}
          <text
            x={padL + 6}
            y={padT + 12}
            fill="#94A3B8"
            fontSize="10"
            fontFamily="IBM Plex Mono, monospace"
          >
            {titleLabel} [{unitLabel}]
          </text>
          {showStepResponse && stepScaleMode === 'dual' && (
            <text
              x={width - padR - 6}
              y={padT + 12}
              textAnchor="end"
              fill="#C4B5FD"
              fontSize="9.5"
              fontFamily="IBM Plex Mono, monospace"
            >
              u_step = 1 · y_step ({stepOutputUnit || 'u'})
            </text>
          )}
        </svg>
      </div>

      {/* Rise-Time & Settling-Time Analysis Bar (shown when Step Response is toggled ON) */}
      {showStepResponse && stepAnalysis && (
        <div
          aria-label="Step Response Transient Analysis"
          className="px-4 py-2 border-t border-slate-800/80 bg-[#0F141E] grid grid-cols-2 sm:grid-cols-4 gap-4 text-xs font-mono tabular-nums"
        >
          <div>
            <div className="text-[11px] font-sans text-slate-400">
              Rise Time (10% → 90%)
            </div>
            <div className="text-emerald-300 font-semibold mt-0.5">
              {stepAnalysis.divergent
                ? 'Divergent'
                : stepAnalysis.riseTimeSec !== null
                ? `${formatDurationMetric(stepAnalysis.riseTimeSec, activeHorizonSec)} `
                : 'N/A'}
              {!stepAnalysis.divergent &&
                stepAnalysis.t10Sec !== null &&
                stepAnalysis.t90Sec !== null && (
                  <span className="text-[10px] font-normal text-slate-400">
                    ({stepAnalysis.t10Sec.toFixed(3)}s→{stepAnalysis.t90Sec.toFixed(3)}s)
                  </span>
                )}
            </div>
          </div>

          <div>
            <div className="text-[11px] font-sans text-slate-400">
              Settling Time (±2% Band)
            </div>
            <div
              className={`font-semibold mt-0.5 ${
                stepAnalysis.divergent ? 'text-rose-400' : 'text-violet-300'
              }`}
            >
              {stepAnalysis.divergent
                ? 'Unstable'
                : formatDurationMetric(stepAnalysis.settlingTimeSec, activeHorizonSec)}
            </div>
          </div>

          <div>
            <div className="text-[11px] font-sans text-slate-400">
              Peak Overshoot / Peak
            </div>
            <div className="text-slate-100 font-semibold mt-0.5">
              {stepAnalysis.divergent
                ? 'Divergent'
                : stepAnalysis.overshootPct !== null
                ? `${stepAnalysis.overshootPct.toFixed(2)}%`
                : '0.00%'}{' '}
              {!stepAnalysis.divergent && (
                <span className="text-[10px] font-normal text-slate-400">
                  (y_pk={stepAnalysis.peakValue.toFixed(3)})
                </span>
              )}
            </div>
          </div>

          <div>
            <div className="text-[11px] font-sans text-slate-400">
              Steady-State y_ss ({stepLoopMode === 'closed' ? 'Closed' : 'Open'})
            </div>
            <div className="text-cyan-300 font-semibold mt-0.5">
              {steadyVal !== null
                ? `${steadyVal.toFixed(4)} ${stepOutputUnit}`
                : 'Unbounded'}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
