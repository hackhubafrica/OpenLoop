import React, {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
import { ESPLoader, Transport, type IEspLoaderTerminal } from 'esptool-js';
import {
  Activity,
  Hammer,
  Play,
  Radio,
  Send,
  Square,
  Terminal,
  Upload,
  Usb,
  Zap,
} from 'lucide-react';
import {
  ControlModel,
  HilFramePacket,
  SimulationTrace,
} from '../types/control';
import { generateEmbeddedCode } from '../engine/codegen';
import {
  ESP32_BOARD_SPECS,
  Esp32BoardEnv,
  generateEsp32PlatformIoBundle,
  getDefaultEsp32PinProfile,
  resolveEsp32Sensors,
} from '../engine/esp32Codegen';
import {
  computeHilFrameCrc16,
  encodeHilWireFrameBytes,
  evaluateHilLoopbackDiagnostic,
  generateEsp32HilDeserializationCpp,
  HilLoopbackDiagnostic,
  HilSerialStreamAccumulator,
  isHilCobsEnabled,
} from '../engine/hil';

interface WebSerialPortInfo {
  usbVendorId?: number;
  usbProductId?: number;
}

interface WebSerialPortLike {
  readable: ReadableStream<Uint8Array> | null;
  writable: WritableStream<Uint8Array> | null;
  open: (options: { baudRate: number }) => Promise<void>;
  close: () => Promise<void>;
  getInfo?: () => WebSerialPortInfo;
}

interface WebSerialApiLike {
  getPorts: () => Promise<WebSerialPortLike[]>;
  requestPort: () => Promise<WebSerialPortLike>;
}

interface StagedBinSegment {
  name: string;
  address: number;
  data: Uint8Array;
}

interface Esp32BridgeBuildImage {
  name: string;
  address: number;
  sizeBytes: number;
  base64: string;
}

interface Esp32BridgeBuildResponse {
  ok: boolean;
  message: string;
  logs: string;
  images: Esp32BridgeBuildImage[];
}

export interface HilWebSerialHandle {
  runLoopbackDiagnostic: (diagId?: number) => Promise<HilLoopbackDiagnostic>;
}

interface HilWebSerialPanelProps {
  model: ControlModel;
  trace: SimulationTrace;
  onReceivePackets: (packets: HilFramePacket[]) => void;
  onClearPackets: () => void;
  onLoopbackResult?: (diag: HilLoopbackDiagnostic) => void;
}

function getWebSerialApi(): WebSerialApiLike | null {
  if (typeof navigator === 'undefined' || !('serial' in navigator)) {
    return null;
  }
  return (navigator as Navigator & { serial: WebSerialApiLike }).serial;
}

function describeUsbBridgeVendor(vid?: number): string {
  switch (vid) {
    case 0x10c4:
      return 'Silicon Labs CP210x';
    case 0x1a86:
      return 'WCH CH340/CH9102';
    case 0x0403:
      return 'FTDI USB-UART';
    case 0x303a:
      return 'Espressif Native USB';
    default:
      return 'ESP32 Serial Device';
  }
}

function formatPortLabel(port: WebSerialPortLike, index: number): string {
  const info = port.getInfo?.();
  if (info?.usbVendorId !== undefined) {
    const vid = info.usbVendorId.toString(16).toUpperCase().padStart(4, '0');
    const pid = (info.usbProductId ?? 0).toString(16).toUpperCase().padStart(4, '0');
    return `COM #${index + 1} · ${describeUsbBridgeVendor(info.usbVendorId)} (VID:${vid} PID:${pid})`;
  }
  return `COM #${index + 1} · Authorized Web Serial Port`;
}

function base64ToUint8Array(base64: string): Uint8Array {
  const binary = atob(base64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

export const HilWebSerialPanel = forwardRef<HilWebSerialHandle, HilWebSerialPanelProps>(
  ({ model, trace, onReceivePackets, onClearPackets, onLoopbackResult }, ref) => {
  const serialApi = getWebSerialApi();
  const webSerialSupported = Boolean(serialApi);
  const cobsActive = isHilCobsEnabled(model);

  const [ports, setPorts] = useState<WebSerialPortLike[]>([]);
  const [selectedPortIdx, setSelectedPortIdx] = useState<number>(0);
  const [baudRate, setBaudRate] = useState<921600 | 460800 | 115200>(921600);

  const [streamState, setStreamState] = useState<
    'disconnected' | 'connecting' | 'streaming' | 'error'
  >('disconnected');
  const [rxFrames, setRxFrames] = useState(0);
  const [crcErrors, setCrcErrors] = useState(0);
  const [rxBytes, setRxBytes] = useState(0);
  const [isLoopbackProbing, setIsLoopbackProbing] = useState(false);

  const [boardEnv, setBoardEnv] = useState<Esp32BoardEnv>('esp32dev');
  const [customOffsetHex, setCustomOffsetHex] = useState<
    '0x10000' | '0x0' | '0x1000' | '0x8000'
  >('0x10000');
  const [stagedBins, setStagedBins] = useState<StagedBinSegment[]>([]);
  const [eraseAll, setEraseAll] = useState(false);
  const [isCompiling, setIsCompiling] = useState(false);

  const [flashState, setFlashState] = useState<
    'idle' | 'syncing' | 'flashing' | 'done' | 'error'
  >('idle');
  const [flashPct, setFlashPct] = useState<number>(0);
  const [detectedChip, setDetectedChip] = useState<string | null>(null);
  const [detectedFlashSize, setDetectedFlashSize] = useState<string | null>(null);
  const [consoleLines, setConsoleLines] = useState<string[]>([
    'Web Serial client ready. Select an ESP32 COM port to stream telemetry or flash .bin firmware.',
  ]);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const activePortRef = useRef<WebSerialPortLike | null>(null);
  const activeReaderRef = useRef<ReadableStreamDefaultReader<Uint8Array> | null>(null);
  const stopRequestedRef = useRef<boolean>(false);
  const txSeqRef = useRef<number>(1);
  const diagCounterRef = useRef<number>(1);
  const pendingLoopbackRef = useRef<{
    txSeq: number;
    expectedCrc16: number;
    sentAtPerfMs: number;
    resolve: (res: { packet: HilFramePacket | null; crcValid: boolean; rxBytes: number; rttMs: number }) => void;
  } | null>(null);
  const accumulatorRef = useRef<HilSerialStreamAccumulator>(
    new HilSerialStreamAccumulator()
  );

  // Keep latest model/callback reachable inside long-lived serial read loop
  const modelRef = useRef(model);
  modelRef.current = model;
  const cobsRef = useRef(cobsActive);
  cobsRef.current = cobsActive;
  const onReceiveRef = useRef(onReceivePackets);
  onReceiveRef.current = onReceivePackets;

  const appendLog = useCallback((line: string) => {
    const clean = line.replace(/\r/g, '').trimEnd();
    if (!clean) return;
    setConsoleLines((prev) => [...prev.slice(-120), clean]);
  }, []);

  const refreshAuthorizedPorts = useCallback(async () => {
    const api = getWebSerialApi();
    if (!api) return;
    try {
      const granted = await api.getPorts();
      setPorts(granted);
      setSelectedPortIdx((prev) =>
        granted.length === 0 ? 0 : Math.min(prev, granted.length - 1)
      );
    } catch {
      // Ignore permission query errors
    }
  }, []);

  useEffect(() => {
    void refreshAuthorizedPorts();
  }, [refreshAuthorizedPorts]);

  const stopSerialStream = useCallback(async () => {
    stopRequestedRef.current = true;
    const reader = activeReaderRef.current;
    activeReaderRef.current = null;
    if (reader) {
      try {
        await reader.cancel();
      } catch {
        // Ignore cancel errors
      }
      try {
        reader.releaseLock();
      } catch {
        // Ignore lock errors
      }
    }
    const openPort = activePortRef.current;
    activePortRef.current = null;
    if (openPort) {
      try {
        await openPort.close();
      } catch {
        // Port may already be closed
      }
    }
    setStreamState('disconnected');
  }, []);

  useEffect(() => {
    return () => {
      void stopSerialStream();
    };
  }, [stopSerialStream]);

  const handleSelectComPort = async (): Promise<WebSerialPortLike | null> => {
    const api = getWebSerialApi();
    if (!api) {
      appendLog('Web Serial API requires Chrome or Edge on localhost or HTTPS.');
      return null;
    }
    try {
      const chosen = await api.requestPort();
      const granted = await api.getPorts();
      setPorts(granted.length > 0 ? granted : [chosen]);
      const idx = granted.indexOf(chosen);
      setSelectedPortIdx(idx >= 0 ? idx : 0);
      appendLog(`Authorized COM port: ${formatPortLabel(chosen, Math.max(0, idx))}`);
      return chosen;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!/No port selected/i.test(msg)) {
        appendLog(`COM port selection cancelled or failed: ${msg}`);
      }
      return null;
    }
  };

  const handleConnectAndStream = async () => {
    if (streamState === 'streaming' || streamState === 'connecting') {
      await stopSerialStream();
      appendLog('Disconnected Web Serial telemetry stream.');
      return;
    }

    const chosenPort = ports[selectedPortIdx] ?? (await handleSelectComPort());
    if (!chosenPort) return;
    const port: WebSerialPortLike = chosenPort;

    setStreamState('connecting');
    accumulatorRef.current.reset();
    stopRequestedRef.current = false;

    try {
      await port.open({ baudRate });
      activePortRef.current = port;
      setStreamState('streaming');
      onClearPackets();
      appendLog(
        `Streaming live ESP32 serial telemetry at ${baudRate} bps (${
          cobsRef.current ? 'COBS + CRC-16' : 'Raw Binary + CRC-16'
        })...`
      );

      while (port.readable && !stopRequestedRef.current) {
        const reader = port.readable.getReader();
        activeReaderRef.current = reader;
        try {
          while (!stopRequestedRef.current) {
            const { value, done } = await reader.read();
            if (done || !value) break;
            setRxBytes((b) => b + value.byteLength);

            const events = accumulatorRef.current.pushChunk(
              value,
              modelRef.current,
              cobsRef.current
            );

            const validPackets: HilFramePacket[] = [];
            let badFrames = 0;
            for (const ev of events) {
              if (ev.ok) {
                validPackets.push(ev.packet);
              } else {
                badFrames += 1;
              }
            }

            const pending = pendingLoopbackRef.current;
            if (pending && events.length > 0) {
              const exactMatch = validPackets.find(
                (p) => p.seq === pending.txSeq && p.crc16 === pending.expectedCrc16
              );
              const replyPacket = exactMatch ?? validPackets[0] ?? null;
              if (replyPacket || badFrames > 0) {
                pendingLoopbackRef.current = null;
                pending.resolve({
                  packet: replyPacket,
                  crcValid: Boolean(replyPacket),
                  rxBytes: replyPacket?.byteLength ?? value.byteLength,
                  rttMs: performance.now() - pending.sentAtPerfMs,
                });
              }
            }

            if (validPackets.length > 0) {
              setRxFrames((c) => c + validPackets.length);
              onReceiveRef.current(validPackets);
            }
            if (badFrames > 0) {
              setCrcErrors((e) => e + badFrames);
            }
          }
        } finally {
          try {
            reader.releaseLock();
          } catch {
            // Ignore release errors
          }
          if (activeReaderRef.current === reader) {
            activeReaderRef.current = null;
          }
        }
      }
    } catch (err) {
      if (!stopRequestedRef.current) {
        setStreamState('error');
        const msg = err instanceof Error ? err.message : String(err);
        appendLog(`Web Serial stream error: ${msg}`);
      }
    } finally {
      if (activePortRef.current === port) {
        activePortRef.current = null;
        try {
          await port.close();
        } catch {
          // Ignore close errors
        }
        setStreamState((prev) => (prev === 'error' ? 'error' : 'disconnected'));
      }
    }
  };

  const handleTransmitProbeFrame = async () => {
    const port = activePortRef.current;
    if (!port || !port.writable) {
      appendLog('Open the Web Serial stream first to transmit control frames.');
      return;
    }
    const sample = trace.samples[trace.samples.length - 1];
    const seq = txSeqRef.current++;
    const wire = encodeHilWireFrameBytes(model, {
      seq,
      tickUs: Math.round((sample?.t ?? 0) * 1_000_000),
      ref: sample?.ref ?? model.reference.finalValue,
      y0: sample?.silOutputs[0] ?? 0,
      y1: sample?.silOutputs[1] ?? 0,
      uCmd: sample?.uSat ?? 0,
    });

    const writer = port.writable.getWriter();
    try {
      await writer.write(wire);
      appendLog(
        `TX Frame #${seq} (${wire.byteLength} B · ${
          cobsActive ? 'COBS + 0x00' : 'Raw'
        }) written to COM port.`
      );
    } catch (err) {
      appendLog(`TX write error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      writer.releaseLock();
    }
  };

  const runLoopbackDiagnostic = useCallback(
    async (diagId?: number): Promise<HilLoopbackDiagnostic> => {
      const id = diagId ?? diagCounterRef.current++;
      const currentModel = modelRef.current;
      const useCobs = cobsRef.current;
      const budgetMs = currentModel.baseDt * 1000;
      const sample = trace.samples[trace.samples.length - 1];
      const seq = txSeqRef.current++;
      const fields = {
        seq,
        tickUs: Math.round((sample?.t ?? 0) * 1_000_000) >>> 0,
        ref: sample?.ref ?? currentModel.reference.finalValue,
        y0: sample?.silOutputs[0] ?? 0,
        y1: sample?.silOutputs[1] ?? 0,
        uCmd: sample?.uSat ?? 0,
      };
      const expectedCrc16 = computeHilFrameCrc16(fields);
      const wire = encodeHilWireFrameBytes(currentModel, fields);

      if (!webSerialSupported) {
        return evaluateHilLoopbackDiagnostic({
          id,
          mode: 'webserial',
          targetLabel: 'Web Serial ESP32',
          cobsEnabled: useCobs,
          txSeq: seq,
          txBytes: wire.byteLength,
          expectedCrc16,
          budgetMs,
          rttMs: 0,
          errorMessage: 'Web Serial API requires Chrome or Edge on localhost/HTTPS.',
        });
      }

      setIsLoopbackProbing(true);
      const timeoutMs = 1200;

      try {
        // Case A: Stream is already active — reuse open port & active read loop
        const openPort = activePortRef.current;
        if (openPort && openPort.writable) {
          const targetLabel = formatPortLabel(openPort, Math.max(0, selectedPortIdx));
          const sentAtPerfMs = performance.now();

          const replyPromise = new Promise<{
            packet: HilFramePacket | null;
            crcValid: boolean;
            rxBytes: number;
            rttMs: number;
          }>((resolve) => {
            const timer = window.setTimeout(() => {
              if (pendingLoopbackRef.current?.txSeq === seq) {
                pendingLoopbackRef.current = null;
              }
              resolve({
                packet: null,
                crcValid: false,
                rxBytes: 0,
                rttMs: performance.now() - sentAtPerfMs,
              });
            }, timeoutMs);

            pendingLoopbackRef.current = {
              txSeq: seq,
              expectedCrc16,
              sentAtPerfMs,
              resolve: (res) => {
                window.clearTimeout(timer);
                resolve(res);
              },
            };
          });

          const writer = openPort.writable.getWriter();
          try {
            await writer.write(wire);
          } finally {
            writer.releaseLock();
          }

          const outcome = await replyPromise;
          const diag = evaluateHilLoopbackDiagnostic({
            id,
            mode: 'webserial',
            targetLabel,
            cobsEnabled: useCobs,
            txSeq: seq,
            txBytes: wire.byteLength,
            expectedCrc16,
            budgetMs,
            rttMs: outcome.rttMs,
            rxPacket: outcome.packet,
            rxBytes: outcome.rxBytes,
            crcValid: outcome.crcValid,
          });
          appendLog(`Loopback [${diag.verdict}]: ${diag.summary}`);
          return diag;
        }

        // Case B: Port not actively streaming — open temporarily, send test packet, read reply, close
        const chosenPort = ports[selectedPortIdx] ?? (await handleSelectComPort());
        if (!chosenPort) {
          return evaluateHilLoopbackDiagnostic({
            id,
            mode: 'webserial',
            targetLabel: 'Web Serial ESP32',
            cobsEnabled: useCobs,
            txSeq: seq,
            txBytes: wire.byteLength,
            expectedCrc16,
            budgetMs,
            rttMs: 0,
            errorMessage: 'No ESP32 COM port selected for loopback verification.',
          });
        }

        const targetLabel = formatPortLabel(chosenPort, Math.max(0, selectedPortIdx));
        let openedHere = false;
        let tempReader: ReadableStreamDefaultReader<Uint8Array> | null = null;
        const tempAcc = new HilSerialStreamAccumulator();

        try {
          await chosenPort.open({ baudRate });
          openedHere = true;
          const sentAtPerfMs = performance.now();

          if (!chosenPort.writable || !chosenPort.readable) {
            throw new Error('Selected COM port does not expose readable/writable streams.');
          }

          const writer = chosenPort.writable.getWriter();
          try {
            await writer.write(wire);
          } finally {
            writer.releaseLock();
          }

          tempReader = chosenPort.readable.getReader();
          const deadline = sentAtPerfMs + timeoutMs;
          let matchedPacket: HilFramePacket | null = null;
          let badFrame = false;
          let totalRx = 0;

          while (performance.now() < deadline && !matchedPacket && !badFrame) {
            const remainingMs = Math.max(25, deadline - performance.now());
            const readResult = await Promise.race([
              tempReader.read(),
              new Promise<{ value?: undefined; done: true }>((resolve) =>
                window.setTimeout(() => resolve({ done: true }), remainingMs)
              ),
            ]);
            if (readResult.done || !readResult.value) break;

            totalRx += readResult.value.byteLength;
            const events = tempAcc.pushChunk(readResult.value, currentModel, useCobs);
            const valids = events.filter(
              (ev): ev is { ok: true; packet: HilFramePacket } => ev.ok
            );
            if (valids.length > 0) {
              onReceiveRef.current(valids.map((v) => v.packet));
              matchedPacket =
                valids.find(
                  (v) => v.packet.seq === seq && v.packet.crc16 === expectedCrc16
                )?.packet ?? valids[0].packet;
            } else if (events.some((ev) => !ev.ok)) {
              badFrame = true;
            }
          }

          const diag = evaluateHilLoopbackDiagnostic({
            id,
            mode: 'webserial',
            targetLabel,
            cobsEnabled: useCobs,
            txSeq: seq,
            txBytes: wire.byteLength,
            expectedCrc16,
            budgetMs,
            rttMs: performance.now() - sentAtPerfMs,
            rxPacket: matchedPacket,
            rxBytes: matchedPacket?.byteLength ?? totalRx,
            crcValid: Boolean(matchedPacket) && !badFrame,
          });
          appendLog(`Loopback [${diag.verdict}]: ${diag.summary}`);
          return diag;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          const diag = evaluateHilLoopbackDiagnostic({
            id,
            mode: 'webserial',
            targetLabel,
            cobsEnabled: useCobs,
            txSeq: seq,
            txBytes: wire.byteLength,
            expectedCrc16,
            budgetMs,
            rttMs: 0,
            errorMessage: `Web Serial loopback failed: ${msg}`,
          });
          appendLog(`Loopback [FAIL]: ${diag.summary}`);
          return diag;
        } finally {
          if (tempReader) {
            try {
              await tempReader.cancel();
            } catch {
              // Ignore cancel errors
            }
            try {
              tempReader.releaseLock();
            } catch {
              // Ignore release errors
            }
          }
          if (openedHere) {
            try {
              await chosenPort.close();
            } catch {
              // Ignore close errors
            }
          }
        }
      } finally {
        setIsLoopbackProbing(false);
      }
    },
    [appendLog, baudRate, ports, selectedPortIdx, trace.samples, webSerialSupported]
  );

  useImperativeHandle(
    ref,
    () => ({
      runLoopbackDiagnostic,
    }),
    [runLoopbackDiagnostic]
  );

  const handleTriggerLocalLoopback = async () => {
    const diag = await runLoopbackDiagnostic();
    onLoopbackResult?.(diag);
  };

  const handleLoadBinFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const bytes = new Uint8Array(await file.arrayBuffer());
    const address = Number.parseInt(customOffsetHex, 16);
    setStagedBins((prev) => {
      const filtered = prev.filter((seg) => seg.address !== address);
      return [...filtered, { name: file.name, address, data: bytes }].sort(
        (a, b) => a.address - b.address
      );
    });
    setFlashState('idle');
    setFlashPct(0);
    appendLog(
      `Staged local binary "${file.name}" (${bytes.byteLength} bytes) @ 0x${address
        .toString(16)
        .toUpperCase()}`
    );
  };

  const handleProbeEsp32Chip = async () => {
    if (!webSerialSupported) {
      setFlashState('error');
      appendLog('Web Serial API requires Chrome or Edge on localhost/HTTPS.');
      return;
    }

    if (streamState === 'streaming' || activePortRef.current) {
      appendLog('Closing active telemetry stream before probing ESP32 bootloader...');
      await stopSerialStream();
    }

    const chosenPort = ports[selectedPortIdx] ?? (await handleSelectComPort());
    if (!chosenPort) return;
    const port: WebSerialPortLike = chosenPort;

    setFlashState('syncing');
    setDetectedChip(null);
    setDetectedFlashSize(null);

    let transport: Transport | null = null;
    try {
      transport = new Transport(port as never, true);
      const terminal: IEspLoaderTerminal = {
        clean: () => setConsoleLines([]),
        writeLine: (line: string) => appendLog(line),
        write: (chunk: string) => {
          if (chunk.includes('\n')) appendLog(chunk);
        },
      };
      const loader = new ESPLoader({
        transport,
        baudrate: baudRate,
        romBaudrate: 115200,
        terminal,
      });

      appendLog(`Connecting esptool-js bootloader probe at ${baudRate} bps...`);
      const chip = await loader.main();
      const flashSize = await loader.detectFlashSize();
      setDetectedChip(chip);
      setDetectedFlashSize(flashSize ?? null);
      setFlashState('idle');
      appendLog(
        `Detected ${chip}${flashSize ? ` (${flashSize} SPI Flash)` : ''} on COM port.`
      );
    } catch (err) {
      setFlashState('error');
      appendLog(
        `Bootloader probe failed: ${err instanceof Error ? err.message : String(err)}`
      );
    } finally {
      if (transport) {
        try {
          await transport.disconnect();
        } catch {
          // Ignore disconnect errors
        }
      }
    }
  };

  const handleCompileViaBridge = async () => {
    setIsCompiling(true);
    appendLog(`Compiling ${model.id} for ${boardEnv} via local bridge (/api/esp32/build)...`);
    try {
      const sensors = resolveEsp32Sensors(model.id);
      const pinProfile = getDefaultEsp32PinProfile(boardEnv, sensors);
      const code = generateEmbeddedCode(model, trace.discrete);
      const pioBundle = generateEsp32PlatformIoBundle(model, trace.discrete, pinProfile);
      const esp32HilRxHeader = generateEsp32HilDeserializationCpp(model, cobsActive);

      const res = await fetch('/api/esp32/build', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          boardEnv,
          platformioIni: pioBundle.platformioIni,
          mainCpp: pioBundle.mainCpp,
          cHeader: code.cHeader,
          cSource: code.cSource,
          hilHeader: code.hilHeader,
          esp32HilRxHeader,
        }),
      });
      const data = (await res.json()) as Esp32BridgeBuildResponse;
      appendLog(data.message);
      if (data.ok && data.images.length > 0) {
        setStagedBins(
          data.images.map((img) => ({
            name: img.name,
            address: img.address,
            data: base64ToUint8Array(img.base64),
          }))
        );
        setFlashState('idle');
        setFlashPct(0);
      } else if (data.logs) {
        data.logs.split('\n').slice(-10).forEach(appendLog);
      }
    } catch (err) {
      appendLog(
        `Bridge compile unavailable (${
          err instanceof Error ? err.message : 'offline'
        }). Load a compiled .bin file from disk instead.`
      );
    } finally {
      setIsCompiling(false);
    }
  };

  const handleFlashFirmware = async () => {
    if (!webSerialSupported) {
      setFlashState('error');
      appendLog('Web Serial API requires Chrome or Edge on localhost/HTTPS.');
      return;
    }
    if (stagedBins.length === 0) {
      setFlashState('error');
      appendLog('Stage a .bin file (or run Bridge Compile) before flashing.');
      return;
    }

    // Safely release any active Web Serial stream reader before handing port to esptool-js
    if (streamState === 'streaming' || activePortRef.current) {
      appendLog('Closing active telemetry stream before entering ESP32 ROM bootloader...');
      await stopSerialStream();
    }

    const chosenPort = ports[selectedPortIdx] ?? (await handleSelectComPort());
    if (!chosenPort) return;
    const port: WebSerialPortLike = chosenPort;

    setFlashState('syncing');
    setFlashPct(0);
    setDetectedChip(null);

    let transport: Transport | null = null;
    try {
      transport = new Transport(port as never, true);
      const terminal: IEspLoaderTerminal = {
        clean: () => setConsoleLines([]),
        writeLine: (line: string) => appendLog(line),
        write: (chunk: string) => {
          if (chunk.includes('\n')) appendLog(chunk);
        },
      };

      const loader = new ESPLoader({
        transport,
        baudrate: baudRate,
        romBaudrate: 115200,
        terminal,
      });

      appendLog(`Syncing ESP32 bootloader at ${baudRate} bps...`);
      const chip = await loader.main();
      setDetectedChip(chip);
      appendLog(`Connected to ${chip}. Flashing ${stagedBins.length} segment(s)...`);

      setFlashState('flashing');
      const totalBytes = stagedBins.reduce((sum, s) => sum + s.data.byteLength, 0);

      await loader.writeFlash({
        fileArray: stagedBins.map((seg) => ({
          data: seg.data,
          address: seg.address,
        })),
        flashSize: 'detect',
        flashMode: 'keep',
        flashFreq: 'keep',
        eraseAll,
        compress: true,
        reportProgress: (fileIdx, written, total) => {
          const prior = stagedBins
            .slice(0, fileIdx)
            .reduce((sum, seg) => sum + seg.data.byteLength, 0);
          const pct =
            totalBytes > 0
              ? Math.min(100, Math.round(((prior + written) / totalBytes) * 100))
              : Math.round((written / Math.max(1, total)) * 100);
          setFlashPct(pct);
        },
      });

      setFlashPct(100);
      appendLog('Flash write + MD5 verification complete. Resetting ESP32...');
      await loader.after('hard_reset');
      setFlashState('done');
      appendLog('Firmware flashed successfully. Click "Connect & Stream" to inspect live telemetry.');
    } catch (err) {
      setFlashState('error');
      appendLog(`esptool-js flash failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      if (transport) {
        try {
          await transport.disconnect();
        } catch {
          // Ignore disconnect errors
        }
      }
    }
  };

  const stagedSummary = useMemo(() => {
    if (stagedBins.length === 0) return 'No .bin staged yet';
    return stagedBins
      .map(
        (b) =>
          `${b.name} @ 0x${b.address.toString(16).toUpperCase()} (${Math.max(
            1,
            Math.round(b.data.byteLength / 1024)
          )} KB)`
      )
      .join(' · ');
  }, [stagedBins]);

  return (
    <section
      aria-label="Web Serial ESP32 COM Port Client and esptool-js Flasher"
      className="px-6 py-4 border-b border-slate-800 bg-[#0B0E17] space-y-4"
    >
      {/* Top COM Port & Live Telemetry Bar */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex flex-wrap items-center gap-3 text-xs font-mono">
          <span className="inline-flex items-center gap-1.5 font-semibold text-slate-100">
            <Usb className="w-3.5 h-3.5 text-cyan-400" />
            Web Serial ESP32 Client
          </span>
          <span className={webSerialSupported ? 'text-cyan-300' : 'text-amber-300'}>
            {webSerialSupported
              ? '● Web Serial API Ready'
              : '▲ Requires Chrome / Edge'}
          </span>
          <span
            className={
              streamState === 'streaming'
                ? 'text-emerald-400'
                : streamState === 'error'
                ? 'text-rose-400'
                : 'text-slate-400'
            }
          >
            {streamState === 'streaming'
              ? `● Streaming (${rxFrames} frames · ${crcErrors} CRC err)`
              : streamState === 'error'
              ? '✖ Stream Error'
              : '▲ Port Idle'}
          </span>
          {rxBytes > 0 && (
            <span className="text-slate-500 tabular-nums">{rxBytes} B RX</span>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <select
            aria-label="Authorized ESP32 COM port"
            value={ports.length > 0 ? String(selectedPortIdx) : ''}
            onChange={(e) => setSelectedPortIdx(Number(e.target.value))}
            disabled={streamState === 'streaming'}
            className="bg-[#07090E] border border-slate-800 rounded px-2.5 py-1.5 text-xs font-mono text-slate-200 focus:outline-none focus:border-cyan-400 cursor-pointer disabled:opacity-50"
          >
            {ports.length === 0 ? (
              <option value="">No COM port authorized yet</option>
            ) : (
              ports.map((p, idx) => (
                <option key={idx} value={idx}>
                  {formatPortLabel(p, idx)}
                </option>
              ))
            )}
          </select>

          <button
            type="button"
            disabled={!webSerialSupported || streamState === 'streaming'}
            onClick={() => void handleSelectComPort()}
            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-mono border border-slate-700 bg-[#07090E] hover:bg-slate-800 text-slate-200 rounded transition-colors cursor-pointer whitespace-nowrap shrink-0 disabled:opacity-45 disabled:cursor-not-allowed"
          >
            <Radio className="w-3.5 h-3.5 text-cyan-400" />
            Select COM Port
          </button>

          <select
            aria-label="Web Serial baud rate"
            value={baudRate}
            disabled={streamState === 'streaming'}
            onChange={(e) =>
              setBaudRate(Number(e.target.value) as 921600 | 460800 | 115200)
            }
            className="bg-[#07090E] border border-slate-800 rounded px-2 py-1.5 text-xs font-mono text-slate-200 focus:outline-none focus:border-cyan-400 cursor-pointer disabled:opacity-50"
          >
            <option value={921600}>921600 bps</option>
            <option value={460800}>460800 bps</option>
            <option value={115200}>115200 bps</option>
          </select>

          <button
            type="button"
            disabled={!webSerialSupported || flashState === 'syncing' || flashState === 'flashing'}
            onClick={() => void handleConnectAndStream()}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-mono font-medium rounded border transition-colors cursor-pointer whitespace-nowrap shrink-0 disabled:opacity-45 disabled:cursor-not-allowed ${
              streamState === 'streaming'
                ? 'border-rose-500/50 bg-rose-500/15 hover:bg-rose-500/25 text-rose-200'
                : 'border-emerald-500/50 bg-emerald-500/15 hover:bg-emerald-500/25 text-emerald-200'
            }`}
          >
            {streamState === 'streaming' ? (
              <>
                <Square className="w-3 h-3" />
                Disconnect
              </>
            ) : (
              <>
                <Play className="w-3 h-3" />
                Connect &amp; Stream
              </>
            )}
          </button>

          <button
            type="button"
            disabled={streamState !== 'streaming'}
            onClick={() => void handleTransmitProbeFrame()}
            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-mono border border-slate-700 bg-[#07090E] hover:bg-slate-800 text-cyan-300 rounded transition-colors cursor-pointer whitespace-nowrap shrink-0 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <Send className="w-3 h-3" />
            Send Frame
          </button>

          <button
            type="button"
            disabled={!webSerialSupported || isLoopbackProbing || flashState === 'syncing' || flashState === 'flashing'}
            onClick={() => void handleTriggerLocalLoopback()}
            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-mono border border-cyan-500/50 bg-cyan-500/15 hover:bg-cyan-500/25 text-cyan-200 rounded transition-colors cursor-pointer whitespace-nowrap shrink-0 disabled:opacity-45 disabled:cursor-not-allowed"
          >
            <Activity className={`w-3.5 h-3.5 ${isLoopbackProbing ? 'animate-pulse' : ''}`} />
            {isLoopbackProbing ? 'Verifying...' : 'Verify Loopback'}
          </button>
        </div>
      </div>

      {/* Direct esptool-js Firmware Uploader + Live Bootloader Console */}
      <div className="grid grid-cols-1 xl:grid-cols-12 gap-4">
        <div className="xl:col-span-7 p-3.5 rounded border border-slate-800 bg-[#07090E] space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="text-xs font-semibold text-slate-100 inline-flex items-center gap-1.5">
              <Zap className="w-3.5 h-3.5 text-cyan-400" />
              Direct Binary Firmware Uploader (esptool-js)
            </div>
            <span className="text-[11px] font-mono text-slate-400">
              {detectedChip
                ? `Chip: ${detectedChip}${detectedFlashSize ? ` · ${detectedFlashSize}` : ''}`
                : 'Auto-releases telemetry stream before flash'}
            </span>
          </div>

          <div className="flex flex-wrap items-center gap-2 text-xs font-mono">
            <input
              ref={fileInputRef}
              type="file"
              accept=".bin"
              onChange={handleLoadBinFile}
              className="hidden"
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded border border-slate-700 bg-[#0B0E17] hover:bg-slate-800 text-slate-200 transition-colors cursor-pointer whitespace-nowrap shrink-0"
            >
              <Upload className="w-3.5 h-3.5 text-cyan-400" />
              Load .bin File
            </button>

            <select
              aria-label="Binary flash memory offset"
              value={customOffsetHex}
              onChange={(e) => {
                const nextHex = e.target.value as '0x10000' | '0x0' | '0x1000' | '0x8000';
                setCustomOffsetHex(nextHex);
                if (stagedBins.length === 1) {
                  setStagedBins([
                    { ...stagedBins[0], address: Number.parseInt(nextHex, 16) },
                  ]);
                }
              }}
              className="bg-[#0B0E17] border border-slate-800 rounded px-2 py-1.5 text-slate-200 focus:outline-none focus:border-cyan-400 cursor-pointer"
            >
              <option value="0x10000">0x10000 (App .bin)</option>
              <option value="0x0">0x0 (Merged .bin)</option>
              <option value="0x1000">0x1000 (Bootloader)</option>
              <option value="0x8000">0x8000 (Partitions)</option>
            </select>

            <select
              aria-label="ESP32 target for optional bridge compile"
              value={boardEnv}
              onChange={(e) => setBoardEnv(e.target.value as Esp32BoardEnv)}
              className="bg-[#0B0E17] border border-slate-800 rounded px-2 py-1.5 text-slate-200 focus:outline-none focus:border-cyan-400 cursor-pointer"
            >
              {Object.values(ESP32_BOARD_SPECS).map((spec) => (
                <option key={spec.id} value={spec.id}>
                  {spec.id}
                </option>
              ))}
            </select>

            <button
              type="button"
              disabled={isCompiling}
              onClick={() => void handleCompileViaBridge()}
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded border border-slate-700 bg-[#0B0E17] hover:bg-slate-800 text-cyan-300 transition-colors cursor-pointer whitespace-nowrap shrink-0 disabled:opacity-50"
            >
              <Hammer className="w-3.5 h-3.5" />
              {isCompiling ? 'Compiling...' : 'Compile .bin (Bridge)'}
            </button>

            <button
              type="button"
              disabled={
                !webSerialSupported ||
                flashState === 'syncing' ||
                flashState === 'flashing'
              }
              onClick={() => void handleProbeEsp32Chip()}
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded border border-slate-700 bg-[#0B0E17] hover:bg-slate-800 text-slate-200 transition-colors cursor-pointer whitespace-nowrap shrink-0 disabled:opacity-45 disabled:cursor-not-allowed"
            >
              <Usb className="w-3.5 h-3.5 text-emerald-400" />
              Probe Chip
            </button>

            <label className="inline-flex items-center gap-1.5 px-1.5 text-[11px] text-slate-300 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={eraseAll}
                onChange={(e) => setEraseAll(e.target.checked)}
                className="accent-rose-500 cursor-pointer"
              />
              Erase Flash
            </label>

            <button
              type="button"
              disabled={
                !webSerialSupported ||
                stagedBins.length === 0 ||
                flashState === 'syncing' ||
                flashState === 'flashing'
              }
              onClick={() => void handleFlashFirmware()}
              className="ml-auto inline-flex items-center gap-1.5 px-3 py-1.5 rounded border border-cyan-500/50 bg-cyan-500/15 hover:bg-cyan-500/25 text-cyan-200 font-semibold transition-colors cursor-pointer whitespace-nowrap shrink-0 disabled:opacity-45 disabled:cursor-not-allowed"
            >
              <Zap className="w-3.5 h-3.5 text-cyan-300" />
              {flashState === 'syncing'
                ? 'Syncing Bootloader...'
                : flashState === 'flashing'
                ? `Flashing ${flashPct}%`
                : 'Flash Firmware'}
            </button>
          </div>

          <div className="space-y-1.5 text-[11px] font-mono tabular-nums">
            <div className="flex items-center justify-between gap-2 text-slate-400">
              <span className="truncate">{stagedSummary}</span>
              <div className="flex items-center gap-2 shrink-0">
                {stagedBins.length > 0 && (
                  <button
                    type="button"
                    onClick={() => {
                      setStagedBins([]);
                      setFlashState('idle');
                      setFlashPct(0);
                    }}
                    className="text-[10px] text-slate-400 hover:text-slate-200 cursor-pointer"
                  >
                    Clear Bins
                  </button>
                )}
                <span
                  className={
                    flashState === 'done'
                      ? 'text-emerald-400'
                      : flashState === 'error'
                      ? 'text-rose-400'
                      : 'text-slate-400'
                  }
                >
                  {flashPct}%
                </span>
              </div>
            </div>
            <div className="w-full h-1.5 rounded bg-slate-800 overflow-hidden">
              <div
                className={`h-full transition-all duration-150 ${
                  flashState === 'error'
                    ? 'bg-rose-500'
                    : flashState === 'done'
                    ? 'bg-emerald-400'
                    : 'bg-cyan-400'
                }`}
                style={{ width: `${flashPct}%` }}
              />
            </div>
          </div>
        </div>

        {/* Bootloader & Web Serial Console */}
        <div className="xl:col-span-5 rounded border border-slate-800 bg-[#07090E] flex flex-col overflow-hidden">
          <div className="px-3 py-1.5 border-b border-slate-800 bg-[#0F141E] flex items-center justify-between text-[11px] font-mono">
            <span className="inline-flex items-center gap-1.5 text-slate-300">
              <Terminal className="w-3 h-3 text-cyan-400" />
              Web Serial &amp; Bootloader Log
            </span>
            <button
              type="button"
              onClick={() => setConsoleLines([])}
              className="text-[10px] text-slate-400 hover:text-slate-200 cursor-pointer"
            >
              Clear
            </button>
          </div>
          <pre className="p-2.5 text-[10.5px] font-mono leading-4 text-slate-300 h-28 overflow-y-auto whitespace-pre-wrap break-words">
            {consoleLines.length > 0 ? consoleLines.join('\n') : 'Log cleared.'}
          </pre>
        </div>
      </div>
    </section>
  );
});

HilWebSerialPanel.displayName = 'HilWebSerialPanel';
