import React, { useEffect, useRef, useState } from 'react';
import { Cable, Pause, Play, RefreshCw, StepForward } from 'lucide-react';
import { ControlModel, HilConfig, HilFramePacket, SimulationTrace } from '../types/control';
import { buildHilFrameStream, createHilPacket } from '../engine/hil';
import { HilLatencyChart } from './HilLatencyChart';

interface SerialPortInfo {
  id: string;
  label: string;
  kind: 'loopback' | 'hardware';
}

interface HilBridgeViewProps {
  model: ControlModel;
  trace: SimulationTrace;
  onChangeModel: (next: ControlModel) => void;
}

const TRANSPORTS: { id: HilConfig['transport']; label: string; rate: string }[] = [
  { id: 'uart_cobs', label: 'UART + COBS', rate: '921600 bps' },
  { id: 'socketcan', label: 'SocketCAN FD', rate: '1 Mbps CAN-FD' },
  { id: 'udp', label: 'UDP Binary', rate: '100 Mbps UDP' },
];

export const HilBridgeView: React.FC<HilBridgeViewProps> = ({
  model,
  trace,
  onChangeModel,
}) => {
  const [jitterMs, setJitterMs] = useState(1.2);
  const [packetDropPct, setPacketDropPct] = useState(4);
  const [seed, setSeed] = useState(42);
  const [selectedSeq, setSelectedSeq] = useState<number>(1);
  const [isStreaming, setIsStreaming] = useState<boolean>(true);
  const [bridgeMode, setBridgeMode] = useState<'simulated' | 'bridge'>('simulated');
  const [serialPorts, setSerialPorts] = useState<SerialPortInfo[]>([
    {
      id: 'bridge://loopback-pty',
      label: 'Node Bridge Loopback (COBS / CRC-16 Echo)',
      kind: 'loopback',
    },
  ]);
  const [selectedPortId, setSelectedPortId] = useState<string>('bridge://loopback-pty');
  const [bridgeStatusMsg, setBridgeStatusMsg] = useState<string | null>(null);
  const [packets, setPackets] = useState<HilFramePacket[]>(() =>
    buildHilFrameStream(model, trace, { jitterMs: 1.2, packetDropPct: 4, seed: 42 })
  );

  const seqRef = useRef<number>(48);
  const sampleCursorRef = useRef<number>(0);
  const missesRef = useRef<number>(0);

  const refreshBridgePorts = async () => {
    try {
      const res = await fetch('/api/hil/ports');
      if (!res.ok) return;
      const data = (await res.json()) as { ok: boolean; ports?: SerialPortInfo[] };
      if (data.ports && data.ports.length > 0) {
        setSerialPorts(data.ports);
        setSelectedPortId((prev) =>
          data.ports!.some((p) => p.id === prev) ? prev : data.ports![0].id
        );
      }
    } catch {
      // Static mode or bridge offline; keep default loopback fallback
    }
  };

  useEffect(() => {
    refreshBridgePorts();
  }, []);

  // Re-initialize rolling HIL buffer when model, transport, or fault sliders reset
  useEffect(() => {
    const initial = buildHilFrameStream(model, trace, {
      jitterMs,
      packetDropPct,
      seed,
    });
    setPackets(initial);
    seqRef.current = initial.length;
    sampleCursorRef.current = 0;
    missesRef.current = 0;
    if (initial.length > 0) {
      setSelectedSeq(initial[initial.length - 1].seq);
    }
  }, [model, trace, jitterMs, packetDropPct, seed]);

  const pushNextFrame = () => {
    if (trace.samples.length === 0) return;
    const nextSeq = seqRef.current + 1;
    seqRef.current = nextSeq;
    const idx = sampleCursorRef.current % trace.samples.length;
    sampleCursorRef.current = idx + Math.max(1, Math.floor(trace.samples.length / 48));

    const { packet, nextConsecutiveMisses } = createHilPacket(
      model,
      trace.samples[idx],
      nextSeq,
      missesRef.current,
      { jitterMs, packetDropPct, seed }
    );
    missesRef.current = nextConsecutiveMisses;

    setPackets((prev) => {
      const next = [...prev.slice(-47), packet];
      return next;
    });
    setSelectedSeq((prevSel) => {
      // Keep selection locked if user clicked an older packet still in buffer; otherwise follow live head
      return prevSel === nextSeq - 1 ? nextSeq : prevSel;
    });

    if (bridgeMode === 'bridge') {
      void (async () => {
        try {
          const res = await fetch('/api/hil/probe', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              portId: selectedPortId,
              baudRate: 921600,
              transport: model.hil.transport,
              wireHex: packet.wireHex,
            }),
          });
          const data = (await res.json()) as {
            ok: boolean;
            rttMs?: number;
            message?: string;
            error?: string;
          };
          if (res.ok && data.message) {
            setBridgeStatusMsg(
              `${data.message} (Node RTT ${data.rttMs?.toFixed(3) ?? '0.000'} ms)`
            );
          } else {
            setBridgeStatusMsg(data.error ?? data.message ?? 'Bridge probe failed');
          }
        } catch (err) {
          setBridgeStatusMsg(
            err instanceof Error ? err.message : 'Node bridge unreachable'
          );
        }
      })();
    }
  };

  useEffect(() => {
    if (!isStreaming) return;
    const timer = window.setInterval(() => {
      pushNextFrame();
    }, 220);
    return () => window.clearInterval(timer);
  });

  const selectedPacket =
    packets.find((p) => p.seq === selectedSeq) ?? packets[packets.length - 1];

  const budgetMs = model.baseDt * 1000;
  const missCount = packets.filter((p) => p.deadlineMissed).length;
  const clampCount = packets.filter((p) => p.watchdogState === 'SAFE_CLAMP').length;

  return (
    <div className="flex-1 flex flex-col min-h-0 bg-[#07090E] overflow-y-auto">
      {/* HIL Controls Bar */}
      <div className="px-6 py-4 border-b border-slate-800 bg-[#0F141E] flex flex-wrap items-center justify-between gap-6">
        <div>
          <h2 className="text-sm font-semibold text-slate-100">
            HIL-Bridge Transport &amp; Loopback Verifier
          </h2>
          <p className="text-xs text-slate-400">
            Deterministic tick pacing, CRC-16-CCITT framing, jitter fault injection &amp; watchdog safe-clamping
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-4">
          <div className="flex items-center gap-1 p-0.5 bg-[#07090E] border border-slate-800 rounded">
            {TRANSPORTS.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() =>
                  onChangeModel({
                    ...model,
                    hil: { ...model.hil, transport: t.id, baudOrRate: t.rate },
                  })
                }
                className={`px-3 py-1 text-xs font-medium rounded transition-colors cursor-pointer whitespace-nowrap ${
                  model.hil.transport === t.id
                    ? 'bg-slate-800 text-cyan-300'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>

          <button
            type="button"
            onClick={() => setIsStreaming((s) => !s)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 rounded transition-colors cursor-pointer"
          >
            {isStreaming ? (
              <>
                <Pause className="w-3.5 h-3.5 text-amber-300" />
                Pause Stream
              </>
            ) : (
              <>
                <Play className="w-3.5 h-3.5 text-cyan-400" />
                Stream Live
              </>
            )}
          </button>

          <button
            type="button"
            onClick={pushNextFrame}
            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium bg-[#07090E] hover:bg-slate-800 text-slate-200 border border-slate-700 rounded transition-colors cursor-pointer"
          >
            <StepForward className="w-3.5 h-3.5 text-cyan-400" />
            Step Frame
          </button>

          <button
            type="button"
            onClick={() => setSeed((s) => s + 13)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-[#07090E] hover:bg-slate-800 text-slate-200 border border-slate-700 rounded transition-colors cursor-pointer"
          >
            <RefreshCw className="w-3.5 h-3.5 text-cyan-400" />
            Re-seed Burst
          </button>

          <div className="flex items-center gap-1 p-0.5 bg-[#07090E] border border-slate-800 rounded">
            <button
              type="button"
              onClick={() => {
                setBridgeMode('simulated');
                setBridgeStatusMsg(null);
              }}
              className={`px-2.5 py-1 text-xs font-medium rounded transition-colors cursor-pointer ${
                bridgeMode === 'simulated'
                  ? 'bg-slate-800 text-slate-100'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              Simulated
            </button>
            <button
              type="button"
              onClick={() => {
                setBridgeMode('bridge');
                void refreshBridgePorts();
              }}
              className={`inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium rounded transition-colors cursor-pointer ${
                bridgeMode === 'bridge'
                  ? 'bg-slate-800 text-emerald-300'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <Cable className="w-3 h-3" />
              Local Node Bridge
            </button>
          </div>
        </div>
      </div>

      {bridgeMode === 'bridge' && (
        <div className="px-6 py-2.5 border-b border-slate-800 bg-[#0B0E17] flex flex-wrap items-center justify-between gap-4 text-xs">
          <div className="flex items-center gap-3">
            <label htmlFor="hil-port-select" className="text-slate-400">
              Bridge Target Port
            </label>
            <select
              id="hil-port-select"
              value={selectedPortId}
              onChange={(e) => setSelectedPortId(e.target.value)}
              className="bg-[#07090E] border border-slate-700 text-slate-100 text-xs font-mono rounded px-2.5 py-1 focus:outline-none focus:border-cyan-400 cursor-pointer"
            >
              {serialPorts.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => void refreshBridgePorts()}
              className="px-2 py-1 text-[11px] font-mono border border-slate-700 rounded bg-[#07090E] hover:bg-slate-800 text-slate-300 cursor-pointer"
            >
              Rescan Ports
            </button>
          </div>
          <div className="font-mono text-[11px] text-emerald-300">
            {bridgeStatusMsg ?? 'Step or stream frames to verify live COBS/CRC-16 bridge round-trip.'}
          </div>
        </div>
      )}

      {/* Fault Injection & Latency Strip */}
      <div className="px-6 py-4 border-b border-slate-800 bg-[#0B0E17] grid grid-cols-1 md:grid-cols-4 gap-6">
        <div>
          <div className="flex justify-between text-xs mb-1.5">
            <span className="text-slate-400">Injected Jitter</span>
            <span className="font-mono tabular-nums text-amber-300">
              +{jitterMs.toFixed(1)} ms
            </span>
          </div>
          <input
            type="range"
            className="w-full instrument-slider"
            min={0}
            max={8}
            step={0.2}
            value={jitterMs}
            onChange={(e) => setJitterMs(Number(e.target.value))}
          />
        </div>

        <div>
          <div className="flex justify-between text-xs mb-1.5">
            <span className="text-slate-400">Packet Drop Rate</span>
            <span className="font-mono tabular-nums text-rose-300">
              {packetDropPct} %
            </span>
          </div>
          <input
            type="range"
            className="w-full instrument-slider"
            min={0}
            max={25}
            step={1}
            value={packetDropPct}
            onChange={(e) => setPacketDropPct(Number(e.target.value))}
          />
        </div>

        <div>
          <div className="flex justify-between text-xs mb-1.5">
            <span className="text-slate-400">Watchdog Miss Limit</span>
            <span className="font-mono tabular-nums text-slate-100">
              {model.hil.watchdogMissLimit} ticks
            </span>
          </div>
          <input
            type="range"
            className="w-full instrument-slider"
            min={1}
            max={6}
            step={1}
            value={model.hil.watchdogMissLimit}
            onChange={(e) =>
              onChangeModel({
                ...model,
                hil: {
                  ...model.hil,
                  watchdogMissLimit: Number(e.target.value),
                },
              })
            }
          />
        </div>

        <div className="flex items-center justify-between border-l border-slate-800 pl-4 font-mono tabular-nums">
          <div>
            <div className="text-[11px] text-slate-400">Deadline Budget</div>
            <div className="text-sm font-semibold text-cyan-300">
              {budgetMs.toFixed(2)} ms
            </div>
          </div>
          <div className="text-right">
            <div className="text-[11px] text-slate-400">Misses / Clamps</div>
            <div className="text-sm font-semibold text-slate-100">
              <span className={missCount > 0 ? 'text-amber-300' : 'text-emerald-400'}>
                {missCount}
              </span>{' '}
              /{' '}
              <span className={clampCount > 0 ? 'text-rose-400' : 'text-slate-400'}>
                {clampCount}
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* Real-Time D3.js Latency Visualization */}
      <HilLatencyChart
        packets={packets}
        budgetMs={budgetMs}
        selectedSeq={selectedPacket?.seq ?? 1}
        onSelectSeq={(seq) => {
          setIsStreaming(false);
          setSelectedSeq(seq);
        }}
        isStreaming={isStreaming}
      />

      {/* Packet Table & Selected Wire Frame Breakdown */}
      <div className="flex-1 grid grid-cols-1 xl:grid-cols-12 min-h-[280px]">
        <div className="xl:col-span-7 border-b xl:border-b-0 xl:border-r border-slate-800 overflow-auto">
          <table className="w-full text-left text-xs font-mono tabular-nums">
            <thead className="bg-[#0F141E] text-slate-400 border-b border-slate-800 sticky top-0">
              <tr>
                <th className="py-2.5 px-3 font-medium">SEQ</th>
                <th className="py-2.5 px-3 font-medium">TICK (μs)</th>
                <th className="py-2.5 px-3 font-medium text-right">RTT (ms)</th>
                <th className="py-2.5 px-3 font-medium text-right">CRC-16</th>
                <th className="py-2.5 px-3 font-medium text-right">BYTES</th>
                <th className="py-2.5 px-3 font-medium">WATCHDOG</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60">
              {packets.map((pkt) => {
                const isSel = selectedPacket?.seq === pkt.seq;
                return (
                  <tr
                    key={pkt.seq}
                    onClick={() => setSelectedSeq(pkt.seq)}
                    className={`cursor-pointer transition-colors ${
                      isSel ? 'bg-cyan-500/10' : 'hover:bg-slate-900/50'
                    }`}
                  >
                    <td className="py-2 px-3 text-slate-200">#{pkt.seq}</td>
                    <td className="py-2 px-3 text-slate-400">{pkt.tickUs}</td>
                    <td
                      className={`py-2 px-3 text-right ${
                        pkt.deadlineMissed ? 'text-amber-300' : 'text-cyan-300'
                      }`}
                    >
                      {pkt.dropped ? 'TIMEOUT' : pkt.rttMs.toFixed(3)}
                    </td>
                    <td className="py-2 px-3 text-right text-slate-300">
                      0x{pkt.crc16.toString(16).toUpperCase().padStart(4, '0')}
                    </td>
                    <td className="py-2 px-3 text-right text-slate-400">
                      {pkt.byteLength} B
                    </td>
                    <td className="py-2 px-3">
                      <span
                        className={
                          pkt.watchdogState === 'SAFE_CLAMP'
                            ? 'text-rose-400'
                            : pkt.watchdogState === 'WARN'
                            ? 'text-amber-300'
                            : 'text-emerald-400'
                        }
                      >
                        {pkt.watchdogState === 'SAFE_CLAMP'
                          ? '✖ SAFE_CLAMP'
                          : pkt.watchdogState === 'WARN'
                          ? '▲ WARN'
                          : '● NOMINAL'}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* Wire Frame Hex Breakdown */}
        <div className="xl:col-span-5 bg-[#0B0E17] p-5 space-y-4">
          {selectedPacket && (
            <>
              <div className="flex items-center justify-between">
                <h3 className="text-xs font-semibold text-slate-200">
                  Packet #{selectedPacket.seq} Binary Frame Inspector
                </h3>
                <span className="text-[11px] font-mono text-slate-400">
                  {model.hil.transport.toUpperCase()} · {model.hil.baudOrRate}
                </span>
              </div>

              <div className="grid grid-cols-2 gap-3 text-xs font-mono tabular-nums">
                <div className="p-2.5 rounded border border-slate-800 bg-[#07090E]">
                  <div className="text-[10px] text-slate-500">ref</div>
                  <div className="text-slate-100 mt-0.5">
                    {selectedPacket.payloadFloats[0].toFixed(5)}
                  </div>
                </div>
                <div className="p-2.5 rounded border border-slate-800 bg-[#07090E]">
                  <div className="text-[10px] text-slate-500">u_cmd</div>
                  <div className="text-amber-300 mt-0.5">
                    {selectedPacket.watchdogState === 'SAFE_CLAMP'
                      ? `${model.hil.safeClampValue.toFixed(5)} (CLAMPED)`
                      : selectedPacket.payloadFloats[3].toFixed(5)}
                  </div>
                </div>
                <div className="p-2.5 rounded border border-slate-800 bg-[#07090E]">
                  <div className="text-[10px] text-slate-500">y[0]</div>
                  <div className="text-cyan-300 mt-0.5">
                    {selectedPacket.payloadFloats[1].toFixed(5)}
                  </div>
                </div>
                <div className="p-2.5 rounded border border-slate-800 bg-[#07090E]">
                  <div className="text-[10px] text-slate-500">y[1]</div>
                  <div className="text-cyan-300 mt-0.5">
                    {selectedPacket.payloadFloats[2].toFixed(5)}
                  </div>
                </div>
              </div>

              <div>
                <div className="text-[11px] font-mono text-slate-400 mb-1.5">
                  Raw Payload (SOF 0xAA55 + SEQ + TICK_US + 4×f32 + CRC16)
                </div>
                <div className="p-3 rounded border border-slate-800 bg-[#07090E] text-[11px] font-mono text-slate-300 leading-5 break-all">
                  {selectedPacket.rawHex}
                </div>
              </div>

              <div>
                <div className="text-[11px] font-mono text-slate-400 mb-1.5">
                  Wire Frame ({model.hil.transport === 'uart_cobs' ? 'COBS + 0x00 Delimiter' : 'Native Frame'})
                </div>
                <div className="p-3 rounded border border-slate-800 bg-[#07090E] text-[11px] font-mono text-cyan-300 leading-5 break-all">
                  {selectedPacket.wireHex}
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
};
