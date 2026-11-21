import React, { useState } from 'react';
import { Archive, Check, CheckCircle2, Copy, Terminal, XCircle } from 'lucide-react';
import { ControlModel, DiscretizationMethod, DiscretizedMatrices } from '../types/control';
import { generateEmbeddedCode } from '../engine/codegen';

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

export const CodegenView: React.FC<CodegenViewProps> = ({
  model,
  discrete,
  onChangeModel,
  onDownloadPresetZip,
}) => {
  const [cTab, setCTab] = useState<CFileTab>('ctrl_model.c');
  const [copiedTarget, setCopiedTarget] = useState<'c' | 'rust' | null>(null);
  const [isVerifying, setIsVerifying] = useState(false);
  const [verifyError, setVerifyError] = useState<string | null>(null);
  const [verifyResult, setVerifyResult] = useState<FirmwareVerifyResponse | null>(null);

  const bundle = generateEmbeddedCode(model, discrete);
  const activeCCode =
    cTab === 'ctrl_model.h'
      ? bundle.cHeader
      : cTab === 'ctrl_model.c'
      ? bundle.cSource
      : bundle.hilHeader;

  const handleCopy = async (which: 'c' | 'rust', content: string) => {
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

          <div className="flex items-center gap-3">
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
              onClick={onDownloadPresetZip}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-[#07090E] hover:bg-slate-800 text-emerald-300 border border-slate-700 rounded transition-colors cursor-pointer whitespace-nowrap"
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

      {/* Side-by-Side C99 & no_std Rust Code Panels */}
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
              className="inline-flex items-center gap-1.5 px-2.5 py-1 text-[11px] font-medium border border-slate-700 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded transition-colors cursor-pointer"
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
              className="inline-flex items-center gap-1.5 px-2.5 py-1 text-[11px] font-medium border border-slate-700 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded transition-colors cursor-pointer"
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
    </div>
  );
};
