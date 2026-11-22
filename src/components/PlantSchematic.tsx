import React from 'react';
import { ControlModel, TimeSample } from '../types/control';

interface PlantSchematicProps {
  model: ControlModel;
  sample: TimeSample | undefined;
}

export const PlantSchematic: React.FC<PlantSchematicProps> = ({ model, sample }) => {
  const states = sample?.silStates ?? model.plant.x0;
  const uSat = sample?.uSat ?? 0;
  const ref = sample?.ref ?? model.reference.finalValue;

  const isCustomView =
    Boolean(model.isCustomModel) ||
    (model.id !== 'pendulum' && model.id !== 'dcmotor' && model.id !== 'buck');

  if (!isCustomView && model.id === 'pendulum' && model.plant.n === 4 && model.plant.p >= 2) {
    const cartX = Math.max(-1.2, Math.min(1.2, states[0] ?? 0));
    const theta = Math.max(-0.7, Math.min(0.7, states[2] ?? 0));
    const centerX = 160 + cartX * 75;
    const refX = 160 + Math.max(-1.2, Math.min(1.2, ref)) * 75;
    const railY = 148;
    const pivotY = railY - 14;
    const poleLen = 78;
    const bobX = centerX + Math.sin(theta) * poleLen;
    const bobY = pivotY - Math.cos(theta) * poleLen;
    const forceDir = Math.abs(uSat) > 0.2 ? Math.sign(uSat) : 0;
    const forceLen = Math.min(36, Math.abs(uSat) * 2.2);

    return (
      <div className="flex flex-col h-full">
        <div className="flex items-center justify-between px-3 py-2 border-b border-slate-800/80">
          <span className="text-xs font-medium text-slate-300">2D Cart-Pole Plant</span>
          <span className="text-[11px] font-mono tabular-nums text-slate-400">
            θ {(theta * (180 / Math.PI)).toFixed(2)}° · x {cartX.toFixed(3)}m
          </span>
        </div>
        <div className="flex-1 flex items-center justify-center p-2 bg-[#07090E]">
          <svg viewBox="0 0 320 185" className="w-full h-full max-h-[185px]">
            {/* Grid ticks */}
            {[-1, -0.5, 0, 0.5, 1].map((m) => {
              const gx = 160 + m * 75;
              return (
                <g key={m}>
                  <line
                    x1={gx}
                    y1={24}
                    x2={gx}
                    y2={railY + 12}
                    stroke="#1E293B"
                    strokeDasharray="2 3"
                    strokeWidth="1"
                  />
                  <text
                    x={gx}
                    y={railY + 26}
                    textAnchor="middle"
                    fill="#64748B"
                    fontSize="9"
                    fontFamily="IBM Plex Mono, monospace"
                  >
                    {m.toFixed(1)}m
                  </text>
                </g>
              );
            })}

            {/* Target reference marker */}
            <line
              x1={refX}
              y1={36}
              x2={refX}
              y2={railY}
              stroke="#06B6D4"
              strokeOpacity="0.45"
              strokeDasharray="4 3"
              strokeWidth="1.2"
            />
            <polygon
              points={`${refX - 4},34 ${refX + 4},34 ${refX},41`}
              fill="#06B6D4"
            />

            {/* Track rail */}
            <line
              x1="28"
              y1={railY}
              x2="292"
              y2={railY}
              stroke="#475569"
              strokeWidth="2.5"
            />

            {/* Cart body */}
            <rect
              x={centerX - 24}
              y={railY - 22}
              width="48"
              height="18"
              rx="2"
              fill="#1E293B"
              stroke="#38BDF8"
              strokeWidth="1.5"
            />
            <circle cx={centerX - 14} cy={railY - 3} r="3.5" fill="#94A3B8" />
            <circle cx={centerX + 14} cy={railY - 3} r="3.5" fill="#94A3B8" />

            {/* Force arrow */}
            {forceDir !== 0 && (
              <g>
                <line
                  x1={centerX + forceDir * 26}
                  y1={railY - 13}
                  x2={centerX + forceDir * (26 + forceLen)}
                  y2={railY - 13}
                  stroke="#F59E0B"
                  strokeWidth="2.5"
                />
                <polygon
                  points={
                    forceDir > 0
                      ? `${centerX + 26 + forceLen},${railY - 17} ${centerX + 32 + forceLen},${railY - 13} ${centerX + 26 + forceLen},${railY - 9}`
                      : `${centerX - 26 - forceLen},${railY - 17} ${centerX - 32 - forceLen},${railY - 13} ${centerX - 26 - forceLen},${railY - 9}`
                  }
                  fill="#F59E0B"
                />
              </g>
            )}

            {/* Pendulum rod & mass */}
            <line
              x1={centerX}
              y1={pivotY}
              x2={bobX}
              y2={bobY}
              stroke="#E2E8F0"
              strokeWidth="3"
              strokeLinecap="round"
            />
            <circle cx={centerX} cy={pivotY} r="3" fill="#06B6D4" />
            <circle
              cx={bobX}
              cy={bobY}
              r="7.5"
              fill="#06B6D4"
              stroke="#083344"
              strokeWidth="1.5"
            />
          </svg>
        </div>
      </div>
    );
  }

  if (!isCustomView && model.id === 'dcmotor' && model.plant.n === 2 && model.plant.p >= 2) {
    const omega = states[0] ?? 0;
    const current = states[1] ?? 0;
    const angleDeg = ((sample?.t ?? 0) * omega * 45) % 360;
    const currentRatio = Math.min(1, Math.abs(current) / 10);

    return (
      <div className="flex flex-col h-full">
        <div className="flex items-center justify-between px-3 py-2 border-b border-slate-800/80">
          <span className="text-xs font-medium text-slate-300">Armature Rotor Stage</span>
          <span className="text-[11px] font-mono tabular-nums text-slate-400">
            ω {omega.toFixed(1)} rad/s · i {current.toFixed(2)} A
          </span>
        </div>
        <div className="flex-1 flex items-center justify-center p-2 bg-[#07090E]">
          <svg viewBox="0 0 320 185" className="w-full h-full max-h-[185px]">
            {/* Stator ring */}
            <circle
              cx="115"
              cy="92"
              r="52"
              fill="#0F141E"
              stroke="#334155"
              strokeWidth="2"
            />
            <circle
              cx="115"
              cy="92"
              r="38"
              fill="#07090E"
              stroke="#1E293B"
              strokeWidth="1.5"
            />
            {/* Rotating rotor spokes */}
            <g transform={`rotate(${angleDeg} 115 92)`}>
              <line x1="115" y1="56" x2="115" y2="128" stroke="#06B6D4" strokeWidth="3" />
              <line x1="79" y1="92" x2="151" y2="92" stroke="#38BDF8" strokeWidth="2" />
              <circle cx="115" cy="64" r="4" fill="#F59E0B" />
            </g>
            <circle cx="115" cy="92" r="9" fill="#1E293B" stroke="#94A3B8" strokeWidth="1.5" />

            {/* Current & Voltage bar meters */}
            <text x="195" y="54" fill="#94A3B8" fontSize="10" fontFamily="IBM Plex Mono">
              Bus Voltage: {uSat.toFixed(2)} V
            </text>
            <rect x="195" y="62" width="102" height="10" rx="2" fill="#1E293B" />
            <rect
              x="195"
              y="62"
              width={Math.min(102, (Math.abs(uSat) / 24) * 102)}
              height="10"
              rx="2"
              fill="#F59E0B"
            />

            <text x="195" y="98" fill="#94A3B8" fontSize="10" fontFamily="IBM Plex Mono">
              Armature i_a: {current.toFixed(2)} A
            </text>
            <rect x="195" y="106" width="102" height="10" rx="2" fill="#1E293B" />
            <rect
              x="195"
              y="106"
              width={currentRatio * 102}
              height="10"
              rx="2"
              fill="#06B6D4"
            />

            <text x="195" y="140" fill="#64748B" fontSize="10" fontFamily="IBM Plex Mono">
              Target ω: {ref.toFixed(1)} rad/s
            </text>
          </svg>
        </div>
      </div>
    );
  }

  if (!isCustomView && model.id === 'buck' && model.plant.n === 2 && model.plant.p >= 2) {
    // Buck converter schematic
  const iL = states[0] ?? 0;
  const vC = states[1] ?? 0;

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-3 py-2 border-b border-slate-800/80">
        <span className="text-xs font-medium text-slate-300">Synchronous LC Buck Stage</span>
        <span className="text-[11px] font-mono tabular-nums text-slate-400">
          v_C {vC.toFixed(2)} V · d {uSat.toFixed(3)}
        </span>
      </div>
      <div className="flex-1 flex items-center justify-center p-2 bg-[#07090E]">
        <svg viewBox="0 0 320 185" className="w-full h-full max-h-[185px]">
          <text x="20" y="34" fill="#94A3B8" fontSize="10" fontFamily="IBM Plex Mono">
            Vin = 12.0 V
          </text>
          {/* Power bus line */}
          <line x1="25" y1="68" x2="90" y2="68" stroke="#F59E0B" strokeWidth="2" />
          {/* Switching node */}
          <rect
            x="90"
            y="55"
            width="42"
            height="26"
            rx="2"
            fill="#1E293B"
            stroke="#F59E0B"
            strokeWidth="1.5"
          />
          <text x="111" y="72" textAnchor="middle" fill="#FDE68A" fontSize="9" fontFamily="IBM Plex Mono">
            d={uSat.toFixed(2)}
          </text>
          {/* Inductor */}
          <line x1="132" y1="68" x2="152" y2="68" stroke="#94A3B8" strokeWidth="2" />
          <path
            d="M 152 68 Q 160 52 168 68 Q 176 52 184 68 Q 192 52 200 68"
            fill="none"
            stroke="#06B6D4"
            strokeWidth="2.2"
          />
          <line x1="200" y1="68" x2="285" y2="68" stroke="#06B6D4" strokeWidth="2" />
          {/* Capacitor */}
          <line x1="225" y1="68" x2="225" y2="96" stroke="#94A3B8" strokeWidth="1.5" />
          <line x1="213" y1="96" x2="237" y2="96" stroke="#38BDF8" strokeWidth="2.5" />
          <line x1="213" y1="104" x2="237" y2="104" stroke="#38BDF8" strokeWidth="2.5" />
          <line x1="225" y1="104" x2="225" y2="132" stroke="#94A3B8" strokeWidth="1.5" />
          {/* Load resistor */}
          <line x1="272" y1="68" x2="272" y2="82" stroke="#94A3B8" strokeWidth="1.5" />
          <rect
            x="264"
            y="82"
            width="16"
            height="34"
            fill="#131A26"
            stroke="#64748B"
            strokeWidth="1.5"
          />
          <line x1="272" y1="116" x2="272" y2="132" stroke="#94A3B8" strokeWidth="1.5" />
          {/* Ground rail */}
          <line x1="25" y1="132" x2="285" y2="132" stroke="#475569" strokeWidth="1.5" />

          {/* Telemetry */}
          <text x="152" y="48" fill="#06B6D4" fontSize="10" fontFamily="IBM Plex Mono">
            i_L: {iL.toFixed(2)} A
          </text>
          <text x="200" y="156" fill="#E2E8F0" fontSize="11" fontFamily="IBM Plex Mono">
            v_C: {vC.toFixed(3)} V (Ref {ref.toFixed(1)} V)
          </text>
          </svg>
        </div>
      </div>
    );
  }

  if (
    model.id === 'esp32_ultrasonic_hold' &&
    model.plant.n === 2 &&
    model.plant.p >= 2
  ) {
    const distM = Math.max(0.02, Math.min(1.0, states[0] ?? 0.35));
    const velMs = states[1] ?? 0;
    const refClamped = Math.max(0.02, Math.min(1.0, ref));
    const sensorX = 52;
    const maxPx = 220;
    const targetX = sensorX + 24 + (distM / 1.0) * maxPx;
    const refX = sensorX + 24 + (refClamped / 1.0) * maxPx;
    const pwmIntensity = Math.min(1, Math.abs(uSat) / 100);
    const relayOn = Math.abs(uSat) >= 25;

    return (
      <div className="flex flex-col h-full">
        <div className="flex items-center justify-between px-3 py-2 border-b border-slate-800/80">
          <span className="text-xs font-medium text-slate-300">
            ESP32 HC-SR04 Ultrasonic Bench
          </span>
          <span className="text-[11px] font-mono tabular-nums text-slate-400">
            d {distM.toFixed(3)} m · v {velMs.toFixed(2)} m/s
          </span>
        </div>
        <div className="flex-1 flex items-center justify-center p-2 bg-[#07090E]">
          <svg viewBox="0 0 320 185" className="w-full h-full max-h-[185px]">
            {/* Distance scale */}
            {[0.2, 0.4, 0.6, 0.8].map((tick) => {
              const tx = sensorX + 24 + tick * maxPx;
              return (
                <g key={tick}>
                  <line
                    x1={tx}
                    y1={36}
                    x2={tx}
                    y2={132}
                    stroke="#1E293B"
                    strokeDasharray="2 3"
                    strokeWidth="1"
                  />
                  <text
                    x={tx}
                    y={145}
                    textAnchor="middle"
                    fill="#64748B"
                    fontSize="8.5"
                    fontFamily="IBM Plex Mono, monospace"
                  >
                    {tick.toFixed(1)}m
                  </text>
                </g>
              );
            })}

            {/* HC-SR04 Dual Transducer Module */}
            <rect
              x="20"
              y="56"
              width="34"
              height="62"
              rx="3"
              fill="#0F172A"
              stroke="#38BDF8"
              strokeWidth="1.5"
            />
            <circle cx="37" cy="73" r="9" fill="#1E293B" stroke="#94A3B8" strokeWidth="1.5" />
            <circle cx="37" cy="101" r="9" fill="#1E293B" stroke="#94A3B8" strokeWidth="1.5" />
            <text
              x="37"
              y="130"
              textAnchor="middle"
              fill="#94A3B8"
              fontSize="8"
              fontFamily="IBM Plex Mono"
            >
              HC-SR04
            </text>

            {/* Acoustic pulse cone */}
            <path
              d={`M 54 73 L ${targetX - 4} 58 L ${targetX - 4} 114 L 54 101 Z`}
              fill="rgba(6, 182, 212, 0.10)"
              stroke="#06B6D4"
              strokeOpacity="0.35"
              strokeDasharray="3 3"
              strokeWidth="1"
            />

            {/* Target setpoint line */}
            <line
              x1={refX}
              y1={32}
              x2={refX}
              y2={132}
              stroke="#10B981"
              strokeDasharray="4 3"
              strokeWidth="1.4"
            />
            <polygon
              points={`${refX - 4},30 ${refX + 4},30 ${refX},37`}
              fill="#10B981"
            />

            {/* Target Obstacle Plate */}
            <rect
              x={targetX - 4}
              y="48"
              width="8"
              height="74"
              rx="1.5"
              fill="#38BDF8"
              stroke="#E2E8F0"
              strokeWidth="1"
            />

            {/* Hardware Output Indicator Strip: LED PWM & Relay */}
            <rect x="20" y="156" width="136" height="18" rx="2" fill="#0F141E" stroke="#1E293B" />
            <circle
              cx="32"
              cy="165"
              r="4.5"
              fill="#06B6D4"
              fillOpacity={0.2 + 0.8 * pwmIntensity}
            />
            <text x="43" y="168" fill="#CBD5E1" fontSize="8.5" fontFamily="IBM Plex Mono">
              LED PWM: {(pwmIntensity * 100).toFixed(0)}%
            </text>

            <rect x="164" y="156" width="136" height="18" rx="2" fill="#0F141E" stroke="#1E293B" />
            <circle
              cx="176"
              cy="165"
              r="4.5"
              fill={relayOn ? '#F59E0B' : '#334155'}
            />
            <text x="187" y="168" fill={relayOn ? '#FDE68A' : '#94A3B8'} fontSize="8.5" fontFamily="IBM Plex Mono">
              RELAY: {relayOn ? 'ACTIVE' : 'IDLE'}
            </text>
          </svg>
        </div>
      </div>
    );
  }

  if (
    model.id === 'esp32_gas_humidity_relay' &&
    model.plant.n === 2 &&
    model.plant.p >= 2
  ) {
    const gasPpm = Math.max(0, states[0] ?? 50);
    const rhPct = Math.max(0, Math.min(100, states[1] ?? 45));
    const pwmPct = Math.min(100, Math.max(0, Math.abs(uSat)));
    const relayOn = pwmPct >= 25;
    const gasRatio = Math.min(1, gasPpm / 400);

    return (
      <div className="flex flex-col h-full">
        <div className="flex items-center justify-between px-3 py-2 border-b border-slate-800/80">
          <span className="text-xs font-medium text-slate-300">
            ESP32 Gas &amp; Humidity Enclosure
          </span>
          <span className="text-[11px] font-mono tabular-nums text-slate-400">
            {gasPpm.toFixed(0)} ppm · {rhPct.toFixed(1)} %RH
          </span>
        </div>
        <div className="flex-1 flex items-center justify-center p-3 bg-[#07090E]">
          <svg viewBox="0 0 320 185" className="w-full h-full max-h-[185px]">
            <text x="18" y="34" fill="#94A3B8" fontSize="9.5" fontFamily="IBM Plex Mono">
              MQ Gas ADC1: {gasPpm.toFixed(1)} ppm (Ref {ref.toFixed(0)})
            </text>
            <rect x="18" y="42" width="284" height="14" rx="2" fill="#131A26" />
            <rect
              x="18"
              y="42"
              width={Math.max(4, gasRatio * 284)}
              height="14"
              rx="2"
              fill={gasPpm > 250 ? '#F43F5E' : '#06B6D4'}
            />

            <text x="18" y="82" fill="#94A3B8" fontSize="9.5" fontFamily="IBM Plex Mono">
              DHT22 Humidity: {rhPct.toFixed(1)} %RH
            </text>
            <rect x="18" y="90" width="284" height="14" rx="2" fill="#131A26" />
            <rect
              x="18"
              y="90"
              width={Math.max(4, (rhPct / 100) * 284)}
              height="14"
              rx="2"
              fill="#10B981"
            />

            <text x="18" y="128" fill="#94A3B8" fontSize="9.5" fontFamily="IBM Plex Mono">
              Relay / PWM Duty: {pwmPct.toFixed(0)}%
            </text>
            <rect x="18" y="136" width="180" height="14" rx="2" fill="#131A26" />
            <rect
              x="18"
              y="136"
              width={Math.max(2, (pwmPct / 100) * 180)}
              height="14"
              rx="2"
              fill="#F59E0B"
            />

            <rect
              x="212"
              y="134"
              width="90"
              height="18"
              rx="2"
              fill="#0F141E"
              stroke={relayOn ? '#F59E0B' : '#334155'}
            />
            <text
              x="257"
              y="146"
              textAnchor="middle"
              fill={relayOn ? '#FDE68A' : '#94A3B8'}
              fontSize="8.5"
              fontFamily="IBM Plex Mono"
            >
              {relayOn ? 'RELAY: ON' : 'RELAY: OFF'}
            </text>
          </svg>
        </div>
      </div>
    );
  }

  // Custom / resized state-space multi-state telemetry schematic
  const outputs = sample?.silOutputs ?? model.plant.C.map(() => 0);
  const maxStateMag = Math.max(
    1,
    ...states.map((v) => Math.abs(v)),
    ...outputs.map((v) => Math.abs(v))
  );
  const satSpan = Math.max(1e-3, Math.abs(model.limits.satMax - model.limits.satMin));
  const effortRatio = Math.min(1, Math.abs(uSat) / satSpan);

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-3 py-2 border-b border-slate-800/80">
        <span className="text-xs font-medium text-slate-300">
          Custom State-Space Vector Stage ({model.plant.n}×{model.plant.m}→{model.plant.p})
        </span>
        <span className="text-[11px] font-mono tabular-nums text-cyan-300">
          u {uSat.toFixed(3)} {model.plant.inputUnit}
        </span>
      </div>
      <div className="flex-1 flex items-center justify-center p-3 bg-[#07090E]">
        <svg viewBox="0 0 320 185" className="w-full h-full max-h-[185px]">
          <text x="10" y="16" fill="#94A3B8" fontSize="9.5" fontFamily="IBM Plex Mono">
            States x[0..{model.plant.n - 1}]
          </text>
          {states.slice(0, 8).map((val, idx) => {
            const y = 26 + idx * 18;
            const norm = Math.min(1, Math.abs(val) / maxStateMag);
            const rawStateName = model.plant.stateNames[idx] ?? `x_${idx}`;
            const shortStateName =
              rawStateName.length > 8 ? `${rawStateName.slice(0, 7)}…` : rawStateName;
            return (
              <g key={`x-${idx}`}>
                <title>{rawStateName}</title>
                <text x="10" y={y + 8} fill="#64748B" fontSize="8.5" fontFamily="IBM Plex Mono">
                  {shortStateName}
                </text>
                <rect x="64" y={y} width="78" height="9" rx="1.5" fill="#131A26" />
                <rect
                  x="64"
                  y={y}
                  width={Math.max(2, norm * 78)}
                  height="9"
                  rx="1.5"
                  fill={val >= 0 ? '#06B6D4' : '#F59E0B'}
                />
                <text
                  x="148"
                  y={y + 8}
                  fill="#CBD5E1"
                  fontSize="8.5"
                  fontFamily="IBM Plex Mono"
                >
                  {val.toFixed(2)}
                </text>
              </g>
            );
          })}

          <line x1="186" y1="10" x2="186" y2="176" stroke="#1E293B" strokeWidth="1" />

          <text x="196" y="16" fill="#94A3B8" fontSize="9.5" fontFamily="IBM Plex Mono">
            Outputs y[0..{model.plant.p - 1}]
          </text>
          {outputs.slice(0, 4).map((val, idx) => {
            const y = 26 + idx * 24;
            const norm = Math.min(1, Math.abs(val) / maxStateMag);
            const rawOutName = model.plant.outputNames[idx] ?? `y_${idx}`;
            const shortOutName = `y[${idx}]`;
            return (
              <g key={`y-${idx}`}>
                <title>{rawOutName}</title>
                <text x="196" y={y + 8} fill="#64748B" fontSize="8.5" fontFamily="IBM Plex Mono">
                  {shortOutName}
                </text>
                <rect x="236" y={y} width="46" height="9" rx="1.5" fill="#131A26" />
                <rect
                  x="236"
                  y={y}
                  width={Math.max(2, norm * 46)}
                  height="9"
                  rx="1.5"
                  fill="#10B981"
                />
                <text
                  x="286"
                  y={y + 8}
                  fill="#CBD5E1"
                  fontSize="8.5"
                  fontFamily="IBM Plex Mono"
                >
                  {val.toFixed(2)}
                </text>
              </g>
            );
          })}

          <text x="196" y="140" fill="#94A3B8" fontSize="9" fontFamily="IBM Plex Mono">
            Effort u_sat / Ref {ref.toFixed(2)}
          </text>
          <rect x="196" y="148" width="112" height="10" rx="1.5" fill="#131A26" />
          <rect
            x="196"
            y="148"
            width={Math.max(2, effortRatio * 112)}
            height="10"
            rx="1.5"
            fill="#F59E0B"
          />
        </svg>
      </div>
    </div>
  );
};
