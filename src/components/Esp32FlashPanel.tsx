import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ESPLoader, Transport, type IEspLoaderTerminal } from 'esptool-js';
import {
  Check,
  Copy,
  Download,
  Hammer,
  RefreshCw,
  Terminal,
  Upload,
  Usb,
  Zap,
} from 'lucide-react';
import { ControlModel } from '../types/control';
import { Esp32BoardEnv } from '../engine/esp32Codegen';

interface SerialPortInfo {
  id: string;
  label: string;
  kind: 'loopback' | 'hardware';
}

interface Esp32ToolchainStatus {
  ok: boolean;
  pioAvailable: boolean;
  pioBinary: string | null;
  pioVersion: string | null;
  esptoolAvailable: boolean;
  ports: SerialPortInfo[];
}

interface Esp32FirmwareImage {
  name: string;
  address: number;
  sizeBytes: number;
  base64: string;
}

interface Esp32BuildResponse {
  ok: boolean;
  boardEnv: Esp32BoardEnv;
  compiledAt: string;
  durationMs: number;
  pioCommand: string;
  firmwareBytes: number | null;
  images: Esp32FirmwareImage[];
  logs: string;
  message: string;
}

interface Esp32FlashResponse {
  ok: boolean;
  boardEnv: Esp32BoardEnv;
  portId: string;
  durationMs: number;
  command: string;
  logs: string;
  message: string;
}

interface CustomBinImage {
  name: string;
  address: number;
  bytes: Uint8Array;
}

interface Esp32FlashPanelProps {
  model: ControlModel;
  boardEnv: Esp32BoardEnv;
  platformioIni: string;
  mainCpp: string;
  cHeader: string;
  cSource: string;
  hilHeader: string;
  esp32HilRxHeader: string;
}

function base64ToUint8Array(base64: string): Uint8Array {
  const binary = atob(base64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

export const Esp32FlashPanel: React.FC<Esp32FlashPanelProps> = ({
  model,
  boardEnv,
  platformioIni,
  mainCpp,
  cHeader,
  cSource,
  hilHeader,
  esp32HilRxHeader,
}) => {
  const [status, setStatus] = useState<Esp32ToolchainStatus | null>(null);
  const [selectedPort, setSelectedPort] = useState<string>('');
  const [isScanning, setIsScanning] = useState(false);

  const [isBuilding, setIsBuilding] = useState(false);
  const [buildResult, setBuildResult] = useState<Esp32BuildResponse | null>(null);

  const [isPioFlashing, setIsPioFlashing] = useState(false);
  const [pioFlashResult, setPioFlashResult] = useState<Esp32FlashResponse | null>(null);

  const [webSerialBaud, setWebSerialBaud] = useState<115200 | 460800 | 921600>(921600);
  const [eraseAll, setEraseAll] = useState(false);
  const [customOffsetHex, setCustomOffsetHex] = useState<'0x10000' | '0x0'>('0x10000');
  const [customBin, setCustomBin] = useState<CustomBinImage | null>(null);

  const [webFlashState, setWebFlashState] = useState<
    'idle' | 'connecting' | 'flashing' | 'done' | 'error'
  >('idle');
  const [flashPct, setFlashPct] = useState<number>(0);
  const [detectedChip, setDetectedChip] = useState<string | null>(null);
  const [terminalLines, setTerminalLines] = useState<string[]>([
    'Ready: Compile with local PlatformIO CLI (.bin) or load a .bin file to flash over Web Serial.',
  ]);
  const [copiedCmd, setCopiedCmd] = useState(false);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const webSerialSupported =
    typeof navigator !== 'undefined' && 'serial' in navigator;

  const hardwarePorts = useMemo(
    () => (status?.ports ?? []).filter((p) => p.kind === 'hardware'),
    [status]
  );

  const appendLog = useCallback((line: string) => {
    const clean = line.replace(/\r/g, '').trimEnd();
    if (!clean) return;
    setTerminalLines((prev) => [...prev.slice(-140), clean]);
  }, []);

  const refreshToolchain = useCallback(async () => {
    setIsScanning(true);
    try {
      const res = await fetch('/api/esp32/status');
      if (!res.ok) return;
      const data = (await res.json()) as Esp32ToolchainStatus;
      setStatus(data);
      const hw = data.ports.filter((p) => p.kind === 'hardware');
      setSelectedPort((prev) =>
        hw.some((p) => p.id === prev) ? prev : hw[0]?.id ?? ''
      );
    } catch {
      // Bridge offline or static build; Web Serial .bin flashing still remains usable
    } finally {
      setIsScanning(false);
    }
  }, []);

  useEffect(() => {
    void refreshToolchain();
  }, [refreshToolchain]);

  const handleCompilePlatformIo = async () => {
    setIsBuilding(true);
    setBuildResult(null);
    setPioFlashResult(null);
    appendLog(`$ pio run -e ${boardEnv} (staging ${model.id} sources...)`);
    try {
      const res = await fetch('/api/esp32/build', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          boardEnv,
          platformioIni,
          mainCpp,
          cHeader,
          cSource,
          hilHeader,
          esp32HilRxHeader,
        }),
      });
      const data = (await res.json()) as Esp32BuildResponse;
      setBuildResult(data);
      appendLog(data.message);
      if (data.logs) {
        data.logs.split('\n').slice(-18).forEach(appendLog);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'PlatformIO build request failed';
      appendLog(`ERROR: ${msg}`);
    } finally {
      setIsBuilding(false);
    }
  };

  const handleFlashPlatformIoUsb = async () => {
    if (!selectedPort) return;
    setIsPioFlashing(true);
    setPioFlashResult(null);
    appendLog(`$ pio run -e ${boardEnv} -t upload --upload-port ${selectedPort}`);
    try {
      const res = await fetch('/api/esp32/flash', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          portId: selectedPort,
          boardEnv,
          platformioIni,
          mainCpp,
          cHeader,
          cSource,
          hilHeader,
          esp32HilRxHeader,
        }),
      });
      const data = (await res.json()) as Esp32FlashResponse;
      setPioFlashResult(data);
      appendLog(data.message);
      if (data.logs) {
        data.logs.split('\n').slice(-18).forEach(appendLog);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'PlatformIO USB upload failed';
      appendLog(`ERROR: ${msg}`);
    } finally {
      setIsPioFlashing(false);
    }
  };

  const handleSelectBinFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const buf = new Uint8Array(await file.arrayBuffer());
    const addr = customOffsetHex === '0x0' ? 0x0 : 0x10000;
    setCustomBin({ name: file.name, address: addr, bytes: buf });
    appendLog(
      `Loaded local binary "${file.name}" (${buf.byteLength} bytes) mapped @ 0x${addr.toString(16).toUpperCase()}`
    );
    e.target.value = '';
  };

  const handleDownloadCompiledBin = (img: Esp32FirmwareImage) => {
    const bytes = base64ToUint8Array(img.base64);
    const blob = new Blob([bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer], {
      type: 'application/octet-stream',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${model.id}-${boardEnv}-${img.name}`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const activeFlashFiles = useMemo(() => {
    if (buildResult?.ok && buildResult.images.length > 0) {
      return buildResult.images.map((img) => ({
        name: img.name,
        address: img.address,
        data: base64ToUint8Array(img.base64),
      }));
    }
    if (customBin) {
      const addr = customOffsetHex === '0x0' ? 0x0 : 0x10000;
      return [{ name: customBin.name, address: addr, data: customBin.bytes }];
    }
    return [];
  }, [buildResult, customBin, customOffsetHex]);

  const handleFlashWebSerial = async () => {
    if (!webSerialSupported) {
      setWebFlashState('error');
      appendLog('Web Serial API is unavailable in this browser. Use Chrome or Edge on localhost/HTTPS.');
      return;
    }
    if (activeFlashFiles.length === 0) {
      setWebFlashState('error');
      appendLog('No .bin firmware image loaded. Click "Compile .bin" or load a .bin file first.');
      return;
    }

    setWebFlashState('connecting');
    setFlashPct(0);
    setDetectedChip(null);

    let transport: Transport | null = null;
    try {
      const serialApi = (navigator as Navigator & { serial: { requestPort: () => Promise<unknown> } }).serial;
      const port = await serialApi.requestPort();
      transport = new Transport(port as never, true);

      const terminal: IEspLoaderTerminal = {
        clean: () => setTerminalLines([]),
        writeLine: (line: string) => appendLog(line),
        write: (chunk: string) => {
          if (chunk.includes('\n')) appendLog(chunk);
        },
      };

      const loader = new ESPLoader({
        transport,
        baudrate: webSerialBaud,
        romBaudrate: 115200,
        terminal,
      });

      appendLog(`Syncing ESP32 ROM bootloader at ${webSerialBaud} bps...`);
      const chip = await loader.main();
      setDetectedChip(chip);
      appendLog(`Connected to ${chip}. Preparing ${activeFlashFiles.length} flash segment(s)...`);

      setWebFlashState('flashing');
      const totalAllBytes = activeFlashFiles.reduce((acc, f) => acc + f.data.byteLength, 0);
      let completedPrior = 0;

      await loader.writeFlash({
        fileArray: activeFlashFiles.map((f) => ({
          data: f.data,
          address: f.address,
        })),
        flashSize: 'detect',
        flashMode: 'keep',
        flashFreq: 'keep',
        eraseAll,
        compress: true,
        reportProgress: (fileIdx, written, total) => {
          const prior = activeFlashFiles
            .slice(0, fileIdx)
            .reduce((acc, f) => acc + f.data.byteLength, 0);
          completedPrior = prior + written;
          const pct =
            totalAllBytes > 0
              ? Math.min(100, Math.round((completedPrior / totalAllBytes) * 100))
              : Math.round((written / Math.max(1, total)) * 100);
          setFlashPct(pct);
        },
      });

      setFlashPct(100);
      appendLog('Flash write & MD5 verification complete. Issuing hard reset...');
      await loader.after('hard_reset');
      setWebFlashState('done');
      appendLog('ESP32 booted into new firmware. Open HIL Bridge to inspect live COBS serial frames.');
    } catch (err) {
      setWebFlashState('error');
      const msg = err instanceof Error ? err.message : String(err);
      appendLog(`Web Serial Flash Error: ${msg}`);
    } finally {
      if (transport) {
        try {
          await transport.disconnect();
        } catch {
          // Ignore disconnect cleanup error
        }
      }
    }
  };

  const cliFlashCommand = `pio run -e ${boardEnv} -t upload${
    selectedPort ? ` --upload-port ${selectedPort}` : ''
  }`;

  const handleCopyCli = async () => {
    try {
      await navigator.clipboard.writeText(cliFlashCommand);
      setCopiedCmd(true);
      window.setTimeout(() => setCopiedCmd(false), 1500);
    } catch {
      // Clipboard blocked; ignore
    }
  };

  return (
    <div className="flex-1 p-5 space-y-5 bg-[#07090E] overflow-y-auto">
      {/* Toolchain & Port Status Strip */}
      <div className="p-3.5 rounded border border-slate-800 bg-[#0B0E17] flex flex-wrap items-center justify-between gap-4">
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-3 text-xs font-mono">
            <span className="font-semibold text-slate-100 inline-flex items-center gap-1.5">
              <Zap className="w-3.5 h-3.5 text-cyan-400" />
              ESP32 Compile &amp; Flash Studio ({boardEnv})
            </span>
            <span
              className={
                status?.pioAvailable ? 'text-emerald-400' : 'text-amber-300'
              }
            >
              {status?.pioAvailable
                ? `● PlatformIO CLI (${status.pioVersion ?? 'ready'})`
                : '▲ PlatformIO CLI Not Installed Locally'}
            </span>
            <span
              className={
                webSerialSupported ? 'text-cyan-300' : 'text-amber-300'
              }
            >
              {webSerialSupported
                ? '● Browser Web Serial Ready'
                : '▲ Web Serial Needs Chrome/Edge'}
            </span>
          </div>
          <p className="text-[11px] text-slate-400">
            Compile C++/C99 sources into a <code className="font-mono text-cyan-300">.bin</code> image via local PlatformIO CLI, or flash a <code className="font-mono text-cyan-300">.bin</code> directly from your browser using <code className="font-mono text-slate-300">esptool-js</code>.
          </p>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <select
            aria-label="Hardware USB serial port for ESP32"
            value={selectedPort}
            onChange={(e) => setSelectedPort(e.target.value)}
            className="bg-[#07090E] border border-slate-800 rounded px-2.5 py-1.5 text-xs font-mono text-slate-200 focus:outline-none focus:border-cyan-400 cursor-pointer"
          >
            {hardwarePorts.length === 0 ? (
              <option value="">No USB serial ports detected</option>
            ) : (
              hardwarePorts.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))
            )}
          </select>
          <button
            type="button"
            disabled={isScanning}
            onClick={() => void refreshToolchain()}
            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-[11px] font-mono border border-slate-700 bg-[#07090E] hover:bg-slate-800 text-slate-200 rounded transition-colors cursor-pointer whitespace-nowrap shrink-0 disabled:opacity-50"
          >
            <RefreshCw className={`w-3 h-3 text-cyan-400 ${isScanning ? 'animate-spin' : ''}`} />
            Rescan USB
          </button>
        </div>
      </div>

      {/* Two-Column Action Matrix: Local PlatformIO Build vs Browser Web Serial */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Card 1: Local PlatformIO CLI Compile & Upload */}
        <div className="p-4 rounded border border-slate-800 bg-[#0B0E17] space-y-3 flex flex-col justify-between">
          <div className="space-y-2.5">
            <div className="flex items-center justify-between gap-2">
              <div className="text-xs font-semibold text-slate-100 flex items-center gap-1.5">
                <Hammer className="w-3.5 h-3.5 text-cyan-400" />
                1. Local PlatformIO Build &amp; USB Upload
              </div>
              <span className="text-[10px] font-mono text-slate-400">
                Requires local pio CLI
              </span>
            </div>
            <p className="text-[11px] text-slate-400 leading-relaxed">
              Stages <code className="font-mono text-slate-300">platformio.ini</code>,{' '}
              <code className="font-mono text-slate-300">src/main.cpp</code>, and{' '}
              <code className="font-mono text-slate-300">ctrl_model.c</code> into an isolated sandbox and invokes <code className="font-mono text-cyan-300">pio run</code> on your Node bridge.
            </p>

            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                disabled={isBuilding || isPioFlashing}
                onClick={handleCompilePlatformIo}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-mono font-medium rounded border border-cyan-500/50 bg-cyan-500/15 hover:bg-cyan-500/25 text-cyan-200 transition-colors cursor-pointer whitespace-nowrap shrink-0 disabled:opacity-50"
              >
                <Hammer className="w-3.5 h-3.5" />
                {isBuilding ? 'Compiling...' : 'Compile .bin (pio run)'}
              </button>

              <button
                type="button"
                disabled={isPioFlashing || isBuilding || !selectedPort || !status?.pioAvailable}
                onClick={handleFlashPlatformIoUsb}
                title={
                  !status?.pioAvailable
                    ? 'Install PlatformIO CLI locally to flash directly over USB'
                    : !selectedPort
                    ? 'Connect ESP32 over USB and click Rescan USB'
                    : 'Compile and upload via PlatformIO CLI'
                }
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-mono font-medium rounded border border-emerald-500/50 bg-emerald-500/15 hover:bg-emerald-500/25 text-emerald-200 transition-colors cursor-pointer whitespace-nowrap shrink-0 disabled:opacity-45 disabled:cursor-not-allowed"
              >
                <Usb className="w-3.5 h-3.5" />
                {isPioFlashing ? 'Uploading...' : 'Compile & Flash USB'}
              </button>
            </div>

            {buildResult && (
              <div
                className={`p-2.5 rounded border text-[11px] font-mono tabular-nums space-y-1.5 ${
                  buildResult.ok
                    ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-200'
                    : 'border-amber-500/40 bg-amber-500/10 text-amber-200'
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span>{buildResult.message}</span>
                  {buildResult.durationMs > 0 && (
                    <span className="text-slate-400 shrink-0">
                      {buildResult.durationMs} ms
                    </span>
                  )}
                </div>
                {buildResult.images.length > 0 && (
                  <div className="flex flex-wrap items-center gap-1.5 pt-1">
                    {buildResult.images.map((img) => (
                      <button
                        key={img.name}
                        type="button"
                        onClick={() => handleDownloadCompiledBin(img)}
                        className="inline-flex items-center gap-1 px-2 py-0.5 text-[10px] font-mono rounded border border-slate-700 bg-[#07090E] hover:bg-slate-800 text-cyan-300 cursor-pointer whitespace-nowrap"
                      >
                        <Download className="w-3 h-3" />
                        {img.name} @ 0x{img.address.toString(16).toUpperCase()} ({Math.round(img.sizeBytes / 1024)} KB)
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}

            {pioFlashResult && (
              <div
                className={`p-2.5 rounded border text-[11px] font-mono ${
                  pioFlashResult.ok
                    ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-200'
                    : 'border-rose-500/40 bg-rose-500/10 text-rose-200'
                }`}
              >
                {pioFlashResult.message}
              </div>
            )}
          </div>

          {/* Terminal Fallback Command */}
          <div className="pt-2 border-t border-slate-800/80 flex items-center justify-between gap-2 text-[10.5px] font-mono">
            <code className="text-slate-300 truncate">$ {cliFlashCommand}</code>
            <button
              type="button"
              onClick={handleCopyCli}
              className="inline-flex items-center gap-1 px-2 py-0.5 rounded border border-slate-700 bg-[#07090E] hover:bg-slate-800 text-slate-300 cursor-pointer whitespace-nowrap shrink-0"
            >
              {copiedCmd ? (
                <>
                  <Check className="w-3 h-3 text-emerald-400" />
                  Copied
                </>
              ) : (
                <>
                  <Copy className="w-3 h-3" />
                  Copy CLI
                </>
              )}
            </button>
          </div>
        </div>

        {/* Card 2: In-Browser Web Serial Flasher (esptool-js) */}
        <div className="p-4 rounded border border-slate-800 bg-[#0B0E17] space-y-3 flex flex-col justify-between">
          <div className="space-y-2.5">
            <div className="flex items-center justify-between gap-2">
              <div className="text-xs font-semibold text-slate-100 flex items-center gap-1.5">
                <Usb className="w-3.5 h-3.5 text-cyan-400" />
                2. Browser Web Serial Flasher (esptool-js)
              </div>
              <span className="text-[10px] font-mono text-cyan-300">
                No PlatformIO needed to flash .bin
              </span>
            </div>
            <p className="text-[11px] text-slate-400 leading-relaxed">
              Writes compiled firmware directly from Chrome/Edge into ESP32 flash over USB Serial, verify MD5, and hard-reset the board.
            </p>

            <div className="grid grid-cols-3 gap-2 text-[11px] font-mono">
              <div>
                <label
                  htmlFor="esp32-webserial-baud"
                  className="block text-[10px] text-slate-500 mb-1"
                >
                  Flash Baud
                </label>
                <select
                  id="esp32-webserial-baud"
                  value={webSerialBaud}
                  onChange={(e) =>
                    setWebSerialBaud(Number(e.target.value) as 115200 | 460800 | 921600)
                  }
                  className="w-full bg-[#07090E] border border-slate-800 rounded px-2 py-1 text-slate-200 focus:outline-none focus:border-cyan-400 cursor-pointer"
                >
                  <option value={921600}>921600 bps</option>
                  <option value={460800}>460800 bps</option>
                  <option value={115200}>115200 bps</option>
                </select>
              </div>

              <div>
                <label
                  htmlFor="esp32-bin-offset"
                  className="block text-[10px] text-slate-500 mb-1"
                >
                  Manual .bin Offset
                </label>
                <select
                  id="esp32-bin-offset"
                  value={customOffsetHex}
                  onChange={(e) =>
                    setCustomOffsetHex(e.target.value as '0x10000' | '0x0')
                  }
                  className="w-full bg-[#07090E] border border-slate-800 rounded px-2 py-1 text-slate-200 focus:outline-none focus:border-cyan-400 cursor-pointer"
                >
                  <option value="0x10000">0x10000 (App)</option>
                  <option value="0x0">0x0 (Merged)</option>
                </select>
              </div>

              <div className="flex items-end pb-1">
                <label className="inline-flex items-center gap-1.5 text-[11px] text-slate-300 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={eraseAll}
                    onChange={(e) => setEraseAll(e.target.checked)}
                    className="accent-rose-500 cursor-pointer"
                  />
                  Erase Flash
                </label>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <input
                ref={fileInputRef}
                type="file"
                accept=".bin"
                onChange={handleSelectBinFile}
                className="hidden"
              />
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-mono rounded border border-slate-700 bg-[#07090E] hover:bg-slate-800 text-slate-200 transition-colors cursor-pointer whitespace-nowrap shrink-0"
              >
                <Upload className="w-3.5 h-3.5 text-cyan-400" />
                {customBin ? `Replace .bin (${customBin.name})` : 'Load .bin File'}
              </button>

              <button
                type="button"
                disabled={
                  !webSerialSupported ||
                  activeFlashFiles.length === 0 ||
                  webFlashState === 'connecting' ||
                  webFlashState === 'flashing'
                }
                onClick={handleFlashWebSerial}
                className="flex-1 inline-flex items-center justify-center gap-1.5 px-3 py-1.5 text-xs font-mono font-semibold rounded border border-cyan-500/50 bg-cyan-500/15 hover:bg-cyan-500/25 text-cyan-200 transition-colors cursor-pointer whitespace-nowrap shrink-0 disabled:opacity-45 disabled:cursor-not-allowed"
              >
                <Zap className="w-3.5 h-3.5 text-cyan-300" />
                {webFlashState === 'connecting'
                  ? 'Connecting Bootloader...'
                  : webFlashState === 'flashing'
                  ? `Flashing ${flashPct}%...`
                  : 'Connect & Flash (Web Serial)'}
              </button>
            </div>
          </div>

          {/* Active Image Summary + Flash Progress Bar */}
          <div className="space-y-1.5 pt-2 border-t border-slate-800/80 text-[10.5px] font-mono tabular-nums">
            <div className="flex items-center justify-between text-slate-400">
              <span>
                {activeFlashFiles.length > 0
                  ? `Staged: ${activeFlashFiles.map((f) => `${f.name}@0x${f.address.toString(16)}`).join(' · ')}`
                  : 'No .bin staged yet (Compile via PlatformIO or Load .bin)'}
              </span>
              {detectedChip && (
                <span className="text-emerald-400 shrink-0">{detectedChip}</span>
              )}
            </div>

            <div className="w-full h-1.5 rounded bg-slate-800 overflow-hidden">
              <div
                className={`h-full transition-all duration-150 ${
                  webFlashState === 'error'
                    ? 'bg-rose-500'
                    : webFlashState === 'done'
                    ? 'bg-emerald-400'
                    : 'bg-cyan-400'
                }`}
                style={{ width: `${flashPct}%` }}
              />
            </div>
          </div>
        </div>
      </div>

      {/* Live Bootloader & Compiler Terminal Console */}
      <div className="rounded border border-slate-800 bg-[#0B0E17] overflow-hidden">
        <div className="px-3.5 py-2 border-b border-slate-800 flex items-center justify-between text-[11px] font-mono">
          <span className="inline-flex items-center gap-1.5 text-slate-300">
            <Terminal className="w-3.5 h-3.5 text-cyan-400" />
            ESP32 Build &amp; Bootloader Console
          </span>
          <button
            type="button"
            onClick={() => setTerminalLines([])}
            className="text-[10px] text-slate-400 hover:text-slate-200 cursor-pointer"
          >
            Clear Log
          </button>
        </div>
        <pre className="p-3.5 text-[11px] font-mono leading-5 text-slate-300 bg-[#07090E] max-h-48 overflow-y-auto whitespace-pre-wrap break-words">
          {terminalLines.length > 0
            ? terminalLines.join('\n')
            : 'Console cleared.'}
        </pre>
      </div>
    </div>
  );
};
