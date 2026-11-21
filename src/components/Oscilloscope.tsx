import React, { useMemo, useState } from 'react';
import { ControlModel, SimulationTrace } from '../types/control';

interface OscilloscopeProps {
  model: ControlModel;
  trace: SimulationTrace;
  activeIndex: number;
  onScrubIndex: (idx: number) => void;
}

type ChannelSelection = number | 'effort';

export const Oscilloscope: React.FC<OscilloscopeProps> = ({
  model,
  trace,
  activeIndex,
  onScrubIndex,
}) => {
  const [channel, setChannel] = useState<ChannelSelection>(0);
  const [showMil, setShowMil] = useState(true);
  const [showSil, setShowSil] = useState(true);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  const activeOutputIdx =
    channel === 'effort'
      ? 0
      : Math.min(channel, Math.max(0, model.plant.p - 1));
  const isEffort = channel === 'effort';

  const samples = trace.samples;
  const displayIdx = hoverIdx !== null ? hoverIdx : activeIndex;
  const currentSample = samples[Math.min(samples.length - 1, Math.max(0, displayIdx))];

  const width = 920;
  const height = 210;
  const padL = 56;
  const padR = 16;
  const padT = 18;
  const padB = 26;
  const plotW = width - padL - padR;
  const plotH = height - padT - padB;

  const { yMin, yMax, milPath, silPath, refPath, unitLabel, titleLabel } = useMemo(() => {
    if (samples.length === 0) {
      return {
        yMin: -1,
        yMax: 1,
        milPath: '',
        silPath: '',
        refPath: '',
        unitLabel: '',
        titleLabel: '',
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

    const span = Math.max(1e-4, maxV - minV);
    const lo = minV - span * 0.12;
    const hi = maxV + span * 0.12;

    const toX = (i: number) =>
      padL + (i / Math.max(1, samples.length - 1)) * plotW;
    const toY = (v: number) =>
      padT + (1 - (v - lo) / (hi - lo)) * plotH;

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

    const unit = isEffort
      ? model.plant.inputUnit
      : model.plant.outputUnits[activeOutputIdx] ?? '';

    const title = isEffort
      ? `${model.plant.inputName} (Raw vs Clamped)`
      : model.plant.outputNames[activeOutputIdx] ?? `y_${activeOutputIdx}`;

    return {
      yMin: lo,
      yMax: hi,
      milPath: mPath,
      silPath: sPath,
      refPath: rPath,
      unitLabel: unit,
      titleLabel: title,
    };
  }, [samples, isEffort, activeOutputIdx, model, plotW, plotH]);

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

  return (
    <div className="border-t border-slate-800 bg-[#0B0E17] flex flex-col">
      {/* Scope Toolbar */}
      <div className="px-4 py-2 border-b border-slate-800/80 flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3">
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
        </div>

        {/* Trace Visibility & Live Crosshair Probe HUD */}
        <div className="flex items-center gap-5 text-xs font-mono tabular-nums">
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
            </div>
          )}
        </div>
      </div>

      {/* SVG Waveform Canvas */}
      <div className="relative px-2 py-1 bg-[#07090E]">
        <svg
          viewBox={`0 0 ${width} ${height}`}
          className="w-full h-[210px] cursor-crosshair select-none"
          onPointerMove={handlePointerMove}
          onPointerLeave={() => setHoverIdx(null)}
          onClick={handleClick}
        >
          {/* Horizontal grid lines */}
          {yTicks.map((frac) => {
            const y = padT + frac * plotH;
            const val = yMax - frac * (yMax - yMin);
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
                  {Math.abs(val) < 0.01 && Math.abs(val) > 0
                    ? val.toExponential(1)
                    : val.toFixed(2)}
                </text>
              </g>
            );
          })}

          {/* Vertical time grid lines */}
          {xTicks.map((frac) => {
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
            />
          )}

          {/* SIL Discrete Fixed-Step trace */}
          {showSil && silPath && (
            <path
              d={silPath}
              fill="none"
              stroke="#F59E0B"
              strokeWidth="1.6"
              strokeDasharray={channel === 'effort' ? undefined : '5 2'}
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
        </svg>
      </div>
    </div>
  );
};
