import React, { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  Archive,
  Check,
  CheckCircle2,
  Copy,
  Cpu,
  FileDown,
  RotateCcw,
  Terminal,
  XCircle,
  Zap,
} from 'lucide-react';
import { ControlModel, DiscretizationMethod, DiscretizedMatrices } from '../types/control';
import { generateEmbeddedCode } from '../engine/codegen';
import {
  DEFAULT_ESP32_PIN_PROFILE,
  ESP32_BOARD_SPECS,
  Esp32BoardEnv,
  Esp32PinProfile,
  Esp32SensorSelection,
  generateEsp32PlatformIoBundle,
  getDefaultEsp32PinProfile,
  resolveEsp32Sensors,
} from '../engine/esp32Codegen';
import { generateEsp32HilDeserializationCpp, isHilCobsEnabled } from '../engine/hil';
import { exportEsp32PlatformIoZip, exportTextFile } from '../utils/exportBundle';
import { Esp32FlashPanel } from './Esp32FlashPanel';
import { Esp32HardwareMap } from './Esp32HardwareMap';

interface CompilerCheckOutcome {
  target: 'c99' | 'rust';
  status: 'passed' | 'failed' | 'unavailable';
  binary: string | null;
  command: string;
  durationMs: number;
  objectBytes: number | null;
  output: string;
}

interface FirmwareVerifyResponse {
  ok: boolean;
  verifiedAt: string;
  c99: CompilerCheckOutcome;
  rust: CompilerCheckOutcome;
}

interface CodegenViewProps {
  model: ControlModel;
  discrete: DiscretizedMatrices;
  onChangeModel: (next: ControlModel) => void;
  onDownloadPresetZip: () => void;
}

type CFileTab = 'ctrl_model.h' | 'ctrl_model.c' | 'hil_frame.h';
type TargetStudioMode = 'core' | 'esp32_pio';
type PioTab = 'hardware_map' | 'build_flash' | 'main.cpp' | 'platformio.ini';

export const CodegenView: React.FC<CodegenViewProps> = ({
  model,
  discrete,
  onChangeModel,
  onDownloadPresetZip,
}) => {
  const [targetStudio, setTargetStudio] = useState<TargetStudioMode>(() =>
    model.id.startsWith('esp32_') ? 'esp32_pio' : 'core'
  );
  const [cTab, setCTab] = useState<CFileTab>('ctrl_model.c');
  const [pioTab, setPioTab] = useState<PioTab>('hardware_map');
  const [pinProfile, setPinProfile] = useState<Esp32PinProfile>(() => ({
    ...DEFAULT_ESP32_PIN_PROFILE,
    sensors: resolveEsp32Sensors(model.id),
  }));
  const [copiedTarget, setCopiedTarget] = useState<'c' | 'rust' | 'pio' | null>(null);
  const [isVerifying, setIsVerifying] = useState(false);
  const [verifyError, setVerifyError] = useState<string | null>(null);
  const [verifyResult, setVerifyResult] = useState<FirmwareVerifyResponse | null>(null);

  useEffect(() => {
    if (model.id.startsWith('esp32_')) {
      setTargetStudio('esp32_pio');
    }
    setPinProfile((prev) => ({
      ...prev,
      sensors: resolveEsp32Sensors(model.id),
    }));
  }, [model.id]);

  const activeSensors: Esp32SensorSelection =
    pinProfile.sensors ?? resolveEsp32Sensors(model.id);

  const handleToggleSensor = (sensor: keyof Esp32SensorSelection) => {
    setPinProfile((prev) => {
      const curr = prev.sensors ?? resolveEsp32Sensors(model.id);
      return {
        ...prev,
        sensors: {
          ...curr,
          [sensor]: !curr[sensor],
        },
      };
    });
  };

  const handleChangePin = (field: keyof Esp32PinProfile, value: number) => {
    setPinProfile((prev) => ({
      ...prev,
      [field]: value,
    }));
  };

  const handleAutoMapSafePins = () => {
    setPinProfile((prev) => ({
      ...getDefaultEsp32PinProfile(prev.boardEnv, prev.sensors ?? resolveEsp32Sensors(model.id)),
      relayThreshold: prev.relayThreshold,
      baudRate: prev.baudRate,
    }));
  };

  const bundle = generateEmbeddedCode(model, discrete);
  const pioBundle = useMemo(
    () =>
      generateEsp32PlatformIoBundle(model, discrete, {
        ...pinProfile,
        sensors: activeSensors,
      }),
    [model, discrete, pinProfile, activeSensors]
  );
  const esp32HilRxHeader = useMemo(
    () => generateEsp32HilDeserializationCpp(model, isHilCobsEnabled(model)),
    [model]
  );

  const activeCCode =
    cTab === 'ctrl_model.h'
      ? bundle.cHeader
      : cTab === 'ctrl_model.c'
      ? bundle.cSource
      : bundle.hilHeader;

  const activePioCode =
    pioTab === 'platformio.ini' ? pioBundle.platformioIni : pioBundle.mainCpp;

  const handleCopy = async (which: 'c' | 'rust' | 'pio', content: string) => {
    try {
      await navigator.clipboard.writeText(content);
      setCopiedTarget(which);
      setTimeout(() => setCopiedTarget(null), 1500);
    } catch {
      // Clipboard blocked in restricted sandbox; ignore gracefully
    }
  };

  const handleVerifyFirmware = async () => {
    setIsVerifying(true);
    setVerifyError(null);
    try {
      const res = await fetch('/api/codegen/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          modelId: model.id,
          cHeader: bundle.cHeader,
          cSource: bundle.cSource,
          hilHeader: bundle.hilHeader,
          rustLib: bundle.rustLib,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setVerifyError(data?.error ?? `HTTP ${res.status}`);
      } else {
        setVerifyResult(data as FirmwareVerifyResponse);
      }
    } catch (err) {
      setVerifyError(
        err instanceof Error ? err.message : 'Local bridge server unreachable.'
      );
    } finally {
      setIsVerifying(false);
    }
  };

  return (
    <div className="flex-1 flex flex-col min-h-0 bg-[#07090E] overflow-y-auto">
      {/* Top Discretization Matrix Inspector */}
      <div className="border-b border-slate-800 bg-[#0F141E] px-6 py-4">
        <div className="flex flex-wrap items-center justify-between gap-4 mb-4">
          <div>
            <h2 className="text-sm font-semibold text-slate-100">
              Discretization &amp; Embedded Codegen Studio
            </h2>
            <p className="text-xs text-slate-400">
              Exact {discrete.method.toUpperCase()} state-space lowering at dt = {model.baseDt} s · zero-malloc C99 &amp; #![no_std] Rust
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-1 p-0.5 bg-[#07090E] border border-slate-800 rounded">
              {(
                [
                  { id: 'core', label: 'C99 & Rust Core' },
                  { id: 'esp32_pio', label: 'PlatformIO (ESP32)' },
                ] as const
              ).map((mode) => (
                <button
                  key={mode.id}
                  type="button"
                  onClick={() => setTargetStudio(mode.id)}
                  className={`px-2.5 py-1 text-xs font-mono rounded transition-colors cursor-pointer whitespace-nowrap shrink-0 ${
                    targetStudio === mode.id
                      ? 'bg-slate-800 text-cyan-300'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  {mode.label}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-1 p-0.5 bg-[#07090E] border border-slate-800 rounded">
              {(['zoh', 'tustin'] as DiscretizationMethod[]).map((method) => (
                <button
                  key={method}
                  type="button"
                  onClick={() => onChangeModel({ ...model, discretization: method })}
                  className={`px-3 py-1 text-xs font-mono uppercase rounded transition-colors cursor-pointer ${
                    model.discretization === method
                      ? 'bg-slate-800 text-cyan-300'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  {method === 'zoh' ? 'ZOH (Padé expm)' : 'Tustin (Bilinear)'}
                </button>
              ))}
            </div>
            <span
              className={`text-xs font-mono tabular-nums ${
                discrete.spectralRadius <= 1.0001
                  ? 'text-emerald-400'
                  : 'text-rose-400'
              }`}
            >
              ρ(Ad) = {discrete.spectralRadius.toFixed(6)}
            </span>
            <button
              type="button"
              disabled={isVerifying}
              onClick={handleVerifyFirmware}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-slate-800 hover:bg-slate-700 text-cyan-300 border border-slate-700 rounded transition-colors cursor-pointer whitespace-nowrap disabled:opacity-50"
            >
              <Terminal className="w-3.5 h-3.5" />
              {isVerifying ? 'Compiling...' : 'Verify Firmware Build'}
            </button>
            <button
              type="button"
              onClick={() =>
                exportEsp32PlatformIoZip(model, discrete, {
                  ...pinProfile,
                  sensors: activeSensors,
                })
              }
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-cyan-500/15 hover:bg-cyan-500/25 text-cyan-200 border border-cyan-500/50 rounded transition-colors cursor-pointer whitespace-nowrap shrink-0"
            >
              <Cpu className="w-3.5 h-3.5 text-cyan-300" />
              Generate PlatformIO Project
            </button>
            <button
              type="button"
              onClick={onDownloadPresetZip}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-[#07090E] hover:bg-slate-800 text-emerald-300 border border-slate-700 rounded transition-colors cursor-pointer whitespace-nowrap shrink-0"
            >
              <Archive className="w-3.5 h-3.5" />
              Download Preset as ZIP
            </button>
          </div>
        </div>

        {(verifyResult || verifyError) && (
          <div className="mb-4 p-3 rounded border border-slate-800 bg-[#07090E] space-y-2">
            <div className="flex items-center justify-between text-xs font-mono">
              <span className="text-slate-300 font-semibold">
                Local Bridge Compiler Check
              </span>
              <button
                type="button"
                onClick={() => {
                  setVerifyResult(null);
                  setVerifyError(null);
                }}
                className="text-[11px] text-slate-400 hover:text-slate-200 cursor-pointer"
              >
                Close
              </button>
            </div>
            {verifyError && (
              <div className="text-xs font-mono text-rose-400">{verifyError}</div>
            )}
            {verifyResult && (
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 text-xs font-mono">
                {[verifyResult.c99, verifyResult.rust].map((item) => (
                  <div
                    key={item.target}
                    className="p-2.5 rounded border border-slate-800 bg-[#0B0E17] space-y-1"
                  >
                    <div className="flex items-center justify-between">
                      <span className="uppercase text-slate-200 font-semibold">
                        {item.target} ({item.binary ?? 'unavailable'})
                      </span>
                      <span
                        className={`inline-flex items-center gap-1 ${
                          item.status === 'passed'
                            ? 'text-emerald-400'
                            : item.status === 'failed'
                            ? 'text-rose-400'
                            : 'text-amber-300'
                        }`}
                      >
                        {item.status === 'passed' ? (
                          <CheckCircle2 className="w-3.5 h-3.5" />
                        ) : item.status === 'failed' ? (
                          <XCircle className="w-3.5 h-3.5" />
                        ) : null}
                        {item.status.toUpperCase()}
                        {item.objectBytes !== null ? ` · ${item.objectBytes} B` : ''}
                        {item.durationMs > 0 ? ` · ${item.durationMs} ms` : ''}
                      </span>
                    </div>
                    <div className="text-[10px] text-slate-500 truncate">
                      $ {item.command}
                    </div>
                    <pre className="text-[11px] text-slate-300 whitespace-pre-wrap break-words max-h-24 overflow-y-auto">
                      {item.output}
                    </pre>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Computed Ad and Bd side-by-side */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <div className="p-3 rounded border border-slate-800 bg-[#07090E]">
            <div className="text-[11px] font-mono text-cyan-300 mb-2">
              Discrete State Matrix Ad ({model.plant.n}×{model.plant.n})
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-xs font-mono tabular-nums text-slate-200">
                <tbody>
                  {discrete.Ad.map((row, r) => (
                    <tr key={r} className="border-b border-slate-900 last:border-b-0">
                      {row.map((val, c) => (
                        <td key={c} className="py-1 px-2 text-right">
                          {val.toFixed(6)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="p-3 rounded border border-slate-800 bg-[#07090E]">
            <div className="text-[11px] font-mono text-amber-300 mb-2">
              Discrete Input Matrix Bd ({model.plant.n}×{model.plant.m}) &amp; LQR K
            </div>
            <div className="grid grid-cols-2 gap-4 text-xs font-mono tabular-nums">
              <div>
                <div className="text-[10px] text-slate-500 mb-1">Bd</div>
                {discrete.Bd.map((row, r) => (
                  <div key={r} className="py-0.5 text-slate-200">
                    [{row.map((v) => v.toFixed(6)).join(', ')}]
                  </div>
                ))}
              </div>
              <div>
                <div className="text-[10px] text-slate-500 mb-1">LQR Gain K</div>
                {model.lqrK.map((kVal, r) => (
                  <div key={r} className="py-0.5 text-cyan-300">
                    K[{r}] = {kVal.toFixed(4)}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Target Code Panels */}
      {targetStudio === 'core' ? (
        <div className="flex-1 grid grid-cols-1 xl:grid-cols-2 min-h-[460px]">
          {/* Left: C99 Target */}
          <div className="flex flex-col border-b xl:border-b-0 xl:border-r border-slate-800 min-w-0">
            <div className="px-4 py-2.5 border-b border-slate-800 bg-[#0B0E17] flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <span className="text-xs font-semibold text-slate-200">
                  C99 Target (Zero-Malloc)
                </span>
                <div className="flex items-center gap-1 p-0.5 bg-[#07090E] border border-slate-800 rounded">
                  {(['ctrl_model.h', 'ctrl_model.c', 'hil_frame.h'] as CFileTab[]).map(
                    (tab) => (
                      <button
                        key={tab}
                        type="button"
                        onClick={() => setCTab(tab)}
                        className={`px-2 py-0.5 text-[11px] font-mono rounded transition-colors cursor-pointer ${
                          cTab === tab
                            ? 'bg-slate-800 text-cyan-300'
                            : 'text-slate-400 hover:text-slate-200'
                        }`}
                      >
                        {tab}
                      </button>
                    )
                  )}
                </div>
              </div>

              <button
                type="button"
                onClick={() => handleCopy('c', activeCCode)}
                className="inline-flex items-center gap-1.5 px-2.5 py-1 text-[11px] font-medium border border-slate-700 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded transition-colors cursor-pointer whitespace-nowrap shrink-0"
              >
                {copiedTarget === 'c' ? (
                  <>
                    <Check className="w-3 h-3 text-emerald-400" />
                    Copied
                  </>
                ) : (
                  <>
                    <Copy className="w-3 h-3" />
                    Copy C99
                  </>
                )}
              </button>
            </div>

            <pre className="flex-1 p-4 text-xs font-mono leading-5 text-slate-200 bg-[#07090E] overflow-auto">
              <code>{activeCCode}</code>
            </pre>
          </div>

          {/* Right: #![no_std] Rust Target */}
          <div className="flex flex-col min-w-0">
            <div className="px-4 py-2.5 border-b border-slate-800 bg-[#0B0E17] flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <span className="text-xs font-semibold text-slate-200">
                  Rust Target (#![no_std] · #[repr(C)])
                </span>
                <span className="text-[11px] font-mono text-slate-500">
                  src/lib.rs
                </span>
              </div>

              <button
                type="button"
                onClick={() => handleCopy('rust', bundle.rustLib)}
                className="inline-flex items-center gap-1.5 px-2.5 py-1 text-[11px] font-medium border border-slate-700 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded transition-colors cursor-pointer whitespace-nowrap shrink-0"
              >
                {copiedTarget === 'rust' ? (
                  <>
                    <Check className="w-3 h-3 text-emerald-400" />
                    Copied
                  </>
                ) : (
                  <>
                    <Copy className="w-3 h-3" />
                    Copy Rust
                  </>
                )}
              </button>
            </div>

            <pre className="flex-1 p-4 text-xs font-mono leading-5 text-slate-200 bg-[#07090E] overflow-auto">
              <code>{bundle.rustLib}</code>
            </pre>
          </div>
        </div>
      ) : (
        <div className="flex-1 grid grid-cols-1 xl:grid-cols-[380px_minmax(0,1fr)] min-h-[480px]">
          {/* Left: ESP32 Hardware Pinout, Toolchain Role & Safety Validator */}
          <aside className="border-b xl:border-b-0 xl:border-r border-slate-800 bg-[#0B0E17] p-5 space-y-5 overflow-y-auto">
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-slate-100">
                  <Cpu className="w-3.5 h-3.5 text-cyan-400" />
                  PlatformIO ESP32 Hardware Bridge
                </span>
                <button
                  type="button"
                  onClick={handleAutoMapSafePins}
                  className="inline-flex items-center gap-1 px-2 py-1 text-[11px] font-mono rounded border border-slate-700 bg-[#07090E] hover:bg-slate-800 text-slate-300 cursor-pointer whitespace-nowrap shrink-0"
                >
                  <RotateCcw className="w-3 h-3" />
                  Safe Defaults
                </button>
              </div>
              <p className="text-[11px] text-slate-400 leading-relaxed">
                Toggle hardware sensors to dynamically map GPIOs and update{' '}
                <code className="text-cyan-300 font-mono">platformio.ini</code> &amp;{' '}
                <code className="text-cyan-300 font-mono">src/main.cpp</code>.
              </p>
            </div>

            {/* Quick Sensor Toggles synced with ESP32 Hardware Map */}
            <div className="space-y-1.5">
              <div className="text-[11px] font-mono text-slate-400">
                Active Bench Sensors
              </div>
              <div className="grid grid-cols-3 gap-1.5">
                {(
                  [
                    { key: 'ultrasonic', label: 'Ultrasonic' },
                    { key: 'gas', label: 'Gas (MQ)' },
                    { key: 'humidity', label: 'Humidity' },
                  ] as const
                ).map((item) => {
                  const enabled = activeSensors[item.key];
                  return (
                    <button
                      key={item.key}
                      type="button"
                      onClick={() => handleToggleSensor(item.key)}
                      className={`px-2 py-1.5 text-[11px] font-mono rounded border transition-colors cursor-pointer whitespace-nowrap ${
                        enabled
                          ? 'border-cyan-500/60 bg-cyan-500/15 text-cyan-200'
                          : 'border-slate-800 bg-[#07090E] text-slate-500 hover:text-slate-300'
                      }`}
                    >
                      {item.label}
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2.5 text-xs font-mono">
              <div className="col-span-2">
                <label
                  htmlFor="esp32-board-env"
                  className="block text-[11px] text-slate-400 mb-1"
                >
                  ESP32 Model (PlatformIO Target)
                </label>
                <select
                  id="esp32-board-env"
                  value={pinProfile.boardEnv}
                  onChange={(e) => {
                    const nextBoard = e.target.value as Esp32BoardEnv;
                    const defaults = getDefaultEsp32PinProfile(nextBoard, activeSensors);
                    setPinProfile((prev) => ({
                      ...defaults,
                      relayThreshold: prev.relayThreshold,
                      baudRate: prev.baudRate,
                    }));
                  }}
                  className="w-full bg-[#07090E] border border-slate-800 rounded px-2.5 py-1.5 text-xs text-slate-100 focus:outline-none focus:border-cyan-400 cursor-pointer"
                >
                  {Object.values(ESP32_BOARD_SPECS).map((spec) => (
                    <option key={spec.id} value={spec.id}>
                      {spec.label}
                    </option>
                  ))}
                </select>
                <div className="mt-1.5 text-[10px] text-slate-500 font-mono leading-snug">
                  {pioBundle.boardSpec.mcuSummary}
                </div>
              </div>

              {(
                [
                  { key: 'trigPin', label: 'HC-SR04 TRIG', enabled: activeSensors.ultrasonic },
                  { key: 'echoPin', label: 'HC-SR04 ECHO', enabled: activeSensors.ultrasonic },
                  { key: 'gasAdcPin', label: 'MQ Gas ADC1', enabled: activeSensors.gas },
                  { key: 'humidityPin', label: 'DHT22 Data', enabled: activeSensors.humidity },
                  { key: 'pwmLedPin', label: 'LED PWM Out', enabled: true },
                  { key: 'buzzerPin', label: 'Buzzer Tone', enabled: true },
                  { key: 'relayPin', label: 'Relay Trigger', enabled: true },
                  { key: 'relayThreshold', label: 'Relay Trip |u|', enabled: true },
                ] as const
              ).map((field) => (
                <div key={field.key} className={field.enabled ? '' : 'opacity-40'}>
                  <label
                    htmlFor={`esp32-pin-${field.key}`}
                    className="block text-[10px] text-slate-500 mb-1"
                  >
                    {field.label}
                  </label>
                  <input
                    id={`esp32-pin-${field.key}`}
                    type="number"
                    disabled={!field.enabled}
                    min={0}
                    max={field.key === 'relayThreshold' ? 500 : pioBundle.boardSpec.maxGpio}
                    step={1}
                    value={pinProfile[field.key]}
                    onChange={(e) => handleChangePin(field.key, Number(e.target.value))}
                    className="w-full bg-[#07090E] border border-slate-800 rounded px-2 py-1 text-xs tabular-nums text-cyan-300 focus:outline-none focus:border-cyan-400 disabled:cursor-not-allowed"
                  />
                </div>
              ))}
            </div>

            {pioBundle.issues.length > 0 ? (
              <div className="space-y-1.5">
                {pioBundle.issues.map((issue, idx) => (
                  <div
                    key={idx}
                    className={`p-2.5 rounded border text-[11px] font-mono flex items-start gap-2 ${
                      issue.severity === 'error'
                        ? 'border-rose-500/40 bg-rose-500/10 text-rose-200'
                        : 'border-amber-500/40 bg-amber-500/10 text-amber-200'
                    }`}
                  >
                    <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                    <span>{issue.message}</span>
                  </div>
                ))}
              </div>
            ) : (
              <div className="p-2.5 rounded border border-emerald-500/30 bg-emerald-500/10 text-[11px] font-mono text-emerald-300 flex items-center gap-2">
                <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
                <span>All active GPIOs clear of flash, strap &amp; ADC2 conflicts</span>
              </div>
            )}

            <div className="space-y-2">
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => exportTextFile('platformio.ini', pioBundle.platformioIni)}
                  className="inline-flex items-center justify-center gap-1.5 px-2.5 py-2 text-[11px] font-mono rounded border border-slate-700 bg-[#07090E] hover:bg-slate-800 text-slate-200 transition-colors cursor-pointer whitespace-nowrap shrink-0"
                >
                  <FileDown className="w-3.5 h-3.5 text-cyan-300" />
                  platformio.ini
                </button>
                <button
                  type="button"
                  onClick={() =>
                    exportTextFile('main.cpp', pioBundle.mainCpp, 'text/x-c++src;charset=utf-8')
                  }
                  className="inline-flex items-center justify-center gap-1.5 px-2.5 py-2 text-[11px] font-mono rounded border border-slate-700 bg-[#07090E] hover:bg-slate-800 text-slate-200 transition-colors cursor-pointer whitespace-nowrap shrink-0"
                >
                  <FileDown className="w-3.5 h-3.5 text-cyan-300" />
                  src/main.cpp
                </button>
              </div>
              <button
                type="button"
                onClick={() =>
                  exportEsp32PlatformIoZip(model, discrete, {
                    ...pinProfile,
                    sensors: activeSensors,
                  })
                }
                className="w-full inline-flex items-center justify-center gap-2 px-3 py-2 text-xs font-semibold rounded border border-cyan-500/50 bg-cyan-500/15 hover:bg-cyan-500/25 text-cyan-200 transition-colors cursor-pointer whitespace-nowrap"
              >
                <Archive className="w-3.5 h-3.5" />
                Generate PlatformIO Project (.zip)
              </button>
              <button
                type="button"
                onClick={() => setPioTab('build_flash')}
                className={`w-full inline-flex items-center justify-center gap-2 px-3 py-2 text-xs font-semibold rounded border transition-colors cursor-pointer whitespace-nowrap ${
                  pioTab === 'build_flash'
                    ? 'border-emerald-400/60 bg-emerald-500/20 text-emerald-200'
                    : 'border-emerald-500/40 bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-300'
                }`}
              >
                <Zap className="w-3.5 h-3.5" />
                Build &amp; Flash ESP32
              </button>
            </div>
          </aside>

          {/* Right: ESP32 Hardware Map & PlatformIO File Viewer */}
          <div className="flex flex-col min-w-0">
            <div className="px-4 py-2.5 border-b border-slate-800 bg-[#0B0E17] flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-1 p-0.5 bg-[#07090E] border border-slate-800 rounded">
                {(
                  [
                    { id: 'hardware_map', label: 'ESP32 Hardware Map' },
                    { id: 'build_flash', label: 'Build & Flash' },
                    { id: 'main.cpp', label: 'src/main.cpp' },
                    { id: 'platformio.ini', label: 'platformio.ini' },
                  ] as const
                ).map((tab) => (
                  <button
                    key={tab.id}
                    type="button"
                    onClick={() => setPioTab(tab.id)}
                    className={`px-2.5 py-1 text-[11px] font-mono rounded transition-colors cursor-pointer whitespace-nowrap shrink-0 ${
                      pioTab === tab.id
                        ? 'bg-slate-800 text-cyan-300'
                        : 'text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    {tab.label}
                  </button>
                ))}
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => exportTextFile('platformio.ini', pioBundle.platformioIni)}
                  className="inline-flex items-center gap-1.5 px-2.5 py-1 text-[11px] font-mono border border-slate-700 bg-[#07090E] hover:bg-slate-800 text-cyan-300 rounded transition-colors cursor-pointer whitespace-nowrap shrink-0"
                >
                  <FileDown className="w-3 h-3" />
                  Export platformio.ini
                </button>
                <button
                  type="button"
                  onClick={() =>
                    exportTextFile('main.cpp', pioBundle.mainCpp, 'text/x-c++src;charset=utf-8')
                  }
                  className="inline-flex items-center gap-1.5 px-2.5 py-1 text-[11px] font-mono border border-slate-700 bg-[#07090E] hover:bg-slate-800 text-cyan-300 rounded transition-colors cursor-pointer whitespace-nowrap shrink-0"
                >
                  <FileDown className="w-3 h-3" />
                  Export src/main.cpp
                </button>
                {pioTab !== 'build_flash' && (
                  <button
                    type="button"
                    onClick={() =>
                      handleCopy(
                        'pio',
                        pioTab === 'hardware_map' ? pioBundle.wiringMarkdown : activePioCode
                      )
                    }
                    className="inline-flex items-center gap-1.5 px-2.5 py-1 text-[11px] font-medium border border-slate-700 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded transition-colors cursor-pointer whitespace-nowrap shrink-0"
                  >
                    {copiedTarget === 'pio' ? (
                      <>
                        <Check className="w-3 h-3 text-emerald-400" />
                        Copied
                      </>
                    ) : (
                      <>
                        <Copy className="w-3 h-3" />
                        {pioTab === 'hardware_map' ? 'Copy Wiring MD' : `Copy ${pioTab}`}
                      </>
                    )}
                  </button>
                )}
              </div>
            </div>

            {pioTab === 'hardware_map' ? (
              <Esp32HardwareMap
                model={model}
                pinProfile={pinProfile}
                sensors={activeSensors}
                boardSpec={pioBundle.boardSpec}
                issues={pioBundle.issues}
                wiringRows={pioBundle.wiringRows}
                onToggleSensor={handleToggleSensor}
                onChangePin={handleChangePin}
                onAutoMapPins={handleAutoMapSafePins}
              />
            ) : pioTab === 'build_flash' ? (
              <Esp32FlashPanel
                model={model}
                boardEnv={pinProfile.boardEnv}
                platformioIni={pioBundle.platformioIni}
                mainCpp={pioBundle.mainCpp}
                cHeader={bundle.cHeader}
                cSource={bundle.cSource}
                hilHeader={bundle.hilHeader}
                esp32HilRxHeader={esp32HilRxHeader}
              />
            ) : (
              <pre className="flex-1 p-4 text-xs font-mono leading-5 text-slate-200 bg-[#07090E] overflow-auto">
                <code>{activePioCode}</code>
              </pre>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
