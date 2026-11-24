import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  Copy,
  Cpu,
  Download,
  FileCode2,
  FileDown,
  RefreshCw,
  RotateCcw,
  Save,
  SlidersHorizontal,
  Sparkles,
  Upload,
} from 'lucide-react';
import { ControlModel, PresetId, ValidationReport } from '../types/control';
import { PRESET_MODELS } from '../data/presets';
import { getPlantTemplateById } from '../data/plantTemplates';
import { parseTomlToModel, serializeModelToToml } from '../engine/ir';
import {
  analyzeSystemStability,
  computePidCompensatorZeros,
  computePoleZeroStabilitySummary,
  computeRootLocus,
  generateLatexStabilityReport,
  stateSpaceToTransferFunction,
} from '../engine/stability';
import {
  applyTransferFunctionToModel,
  formatPolynomial,
  parseCoefficientList,
  transferFunctionToStateSpace,
} from '../engine/transferFunction';
import {
  autoTunePidGains,
  getRecommendedAutoTuneDefaults,
  PidAutoTuneResult,
} from '../engine/pidAutoTune';
import { ESP32_BOARD_SPECS, Esp32BoardEnv } from '../engine/esp32Codegen';
import { BodePlot } from './BodePlot';
import { NyquistPlot } from './NyquistPlot';
import { PoleZeroPlot } from './PoleZeroPlot';
import { SDomainSensitivityPlot } from './SDomainSensitivityPlot';
import { StepResponseThumbnail } from './StepResponseThumbnail';
import { MarkdownGuideView } from './MarkdownGuideView';
import { TEMPLATING_ENGINE_DOCS_MD } from '../data/templatingDocs';
import { exportSystemAnalysisPdf } from '../utils/exportPdfReport';

interface SchemaViewProps {
  model: ControlModel;
  validation: ValidationReport;
  onChangeModel: (next: ControlModel) => void;
  onSaveModel: () => void;
  onImportModel: (
    filename: string,
    rawText: string
  ) => { error: string | null; format: 'json' | 'toml' };
}

function formatCoeffCsv(coeffs: number[]): string {
  return coeffs
    .map((v) => {
      if (Math.abs(v) < 1e-11) return '0';
      return Number.isInteger(v) ? String(v) : Number(v.toPrecision(5)).toString();
    })
    .join(', ');
}

function computeGainSliderBounds(
  baseline: number,
  current: number,
  zeroFallbackMax: number
): { min: number; max: number; step: number } {
  const mag = Math.max(Math.abs(baseline), Math.abs(current));
  const rawMax = mag > 1e-9 ? mag * 3 : zeroFallbackMax;
  const pow10 = Math.pow(10, Math.floor(Math.log10(rawMax)));
  const normalized = rawMax / pow10;
  const niceMult =
    normalized <= 1.5
      ? 1.5
      : normalized <= 2.5
      ? 2.5
      : normalized <= 5
      ? 5
      : 10;
  const bound = niceMult * pow10;
  const isNegativeRegime = baseline < -1e-9 || current < -1e-9;
  const min = isNegativeRegime ? -bound : 0;
  const max = bound;
  const span = max - min;
  const step = Number((span / 250).toPrecision(2));
  return { min, max, step };
}

export const SchemaView: React.FC<SchemaViewProps> = ({
  model,
  validation,
  onChangeModel,
  onSaveModel,
  onImportModel,
}) => {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const isInternalTfUpdateRef = useRef(false);
  const [text, setText] = useState(() => serializeModelToToml(model));
  const [parseError, setParseError] = useState<string | null>(null);
  const [paneMode, setPaneMode] = useState<'split' | 'ir' | 'analysis' | 'docs'>('split');
  const [analysisTab, setAnalysisTab] = useState<
    'bode' | 'nyquist' | 'pz' | 'sensitivity' | 'combined'
  >('combined');

  const initialTf = useMemo(
    () => stateSpaceToTransferFunction(model.plant, model.pid.targetOutputIndex, 0),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );
  const [tfNumText, setTfNumText] = useState(() => formatCoeffCsv(initialTf.numerator));
  const [tfDenText, setTfDenText] = useState(() => formatCoeffCsv(initialTf.denominator));
  const [tfError, setTfError] = useState<string | null>(null);
  const [stabilityScope, setStabilityScope] = useState<'closed' | 'open'>('closed');
  const [showRootLocus, setShowRootLocus] = useState(false);
  const [showLatexExport, setShowLatexExport] = useState(false);
  const [latexCopied, setLatexCopied] = useState(false);
  const [pdfExported, setPdfExported] = useState(false);
  const [controllerFocusTick, setControllerFocusTick] = useState(0);
  const [pzLoopMode, setPzLoopMode] = useState<'open' | 'closed'>('open');
  const [baselinePid, setBaselinePid] = useState(() => ({ ...model.pid }));
  const initialTuneDefaults = useMemo(
    () => getRecommendedAutoTuneDefaults(model),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );
  const [autoTuneBoard, setAutoTuneBoard] = useState<Esp32BoardEnv>('esp32dev');
  const [targetRiseTimeSec, setTargetRiseTimeSec] = useState<number>(
    initialTuneDefaults.targetRiseTimeSec
  );
  const [maxOvershootPct, setMaxOvershootPct] = useState<number>(
    initialTuneDefaults.maxOvershootPct
  );
  const [maxSettlingTimeSec, setMaxSettlingTimeSec] = useState<number>(0.85);
  const [autoTuneResult, setAutoTuneResult] = useState<PidAutoTuneResult | null>(
    null
  );

  useEffect(() => {
    setBaselinePid({ ...model.pid });
    const nextDefaults = getRecommendedAutoTuneDefaults(model);
    setTargetRiseTimeSec(nextDefaults.targetRiseTimeSec);
    setMaxOvershootPct(nextDefaults.maxOvershootPct);
    setMaxSettlingTimeSec(
      model.id === 'esp32_ultrasonic_hold'
        ? 0.85
        : Number(Math.max(model.baseDt * 8, nextDefaults.targetRiseTimeSec * 2.5).toPrecision(2))
    );
    setAutoTuneResult(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model.id]);

  const stabilitySummary = useMemo(
    () => analyzeSystemStability(model, model.pid.targetOutputIndex, 0),
    [model]
  );

  const pidZeros = useMemo(() => computePidCompensatorZeros(model.pid), [model.pid]);

  const closedSummaryForDesigner = useMemo(
    () =>
      computePoleZeroStabilitySummary(
        model,
        'closed',
        model.pid.targetOutputIndex,
        0
      ),
    [model]
  );

  const pzSummary = useMemo(
    () =>
      computePoleZeroStabilitySummary(
        model,
        stabilityScope,
        model.pid.targetOutputIndex,
        0
      ),
    [model, stabilityScope]
  );

  const rootLocus = useMemo(
    () =>
      showRootLocus
        ? computeRootLocus(model, model.pid.targetOutputIndex, 0)
        : null,
    [showRootLocus, model]
  );

  const latexSnippet = useMemo(
    () =>
      showLatexExport
        ? generateLatexStabilityReport(model, model.pid.targetOutputIndex, 0)
        : '',
    [showLatexExport, model]
  );

  const revealPoleZeroClosedLoop = () => {
    setControllerFocusTick((t) => t + 1);
    setStabilityScope('closed');
    if (paneMode === 'ir' || paneMode === 'docs') setPaneMode('split');
    if (analysisTab === 'bode') setAnalysisTab('combined');
  };

  const handlePidUpdate = (patch: Partial<ControlModel['pid']>) => {
    onChangeModel({
      ...model,
      pid: {
        ...model.pid,
        ...patch,
      },
    });
    revealPoleZeroClosedLoop();
  };

  const handleResetPid = () => {
    const template = getPlantTemplateById(model.id);
    const preset =
      model.id === 'pendulum' || model.id === 'dcmotor' || model.id === 'buck'
        ? PRESET_MODELS[model.id as PresetId]
        : null;
    const restoredPid = template
      ? { ...template.model.pid }
      : preset
      ? { ...preset.pid }
      : { ...baselinePid };
    onChangeModel({
      ...model,
      pid: restoredPid,
    });
    setAutoTuneResult(null);
    revealPoleZeroClosedLoop();
  };

  const handleRunPidAutoTune = () => {
    const result = autoTunePidGains(model, {
      targetRiseTimeSec,
      maxOvershootPct,
      maxSettlingTimeSec,
      objective: 'balanced',
      esp32Board: autoTuneBoard,
    });
    setAutoTuneResult(result);
  };

  const handleAutoTuneUltrasonicSettlingTime = () => {
    const ultrasonicTemplate = getPlantTemplateById('esp32_ultrasonic_hold')?.model;
    const targetModel =
      model.id === 'esp32_ultrasonic_hold'
        ? model
        : ultrasonicTemplate ?? model;

    const result = autoTunePidGains(targetModel, {
      targetRiseTimeSec:
        targetModel.id === 'esp32_ultrasonic_hold'
          ? Math.min(targetRiseTimeSec, 0.35)
          : targetRiseTimeSec,
      maxOvershootPct,
      maxSettlingTimeSec,
      objective: 'min_settling_time',
      esp32Board: autoTuneBoard,
    });
    setAutoTuneResult(result);
  };

  const handleApplySuggestedPid = () => {
    if (!autoTuneResult) return;
    if (autoTuneResult.targetModelId !== model.id) {
      const targetTemplate = getPlantTemplateById(autoTuneResult.targetModelId)?.model;
      if (targetTemplate) {
        onChangeModel({
          ...targetTemplate,
          pid: {
            ...targetTemplate.pid,
            enabled: true,
            ...autoTuneResult.recommendedPid,
          },
        });
        revealPoleZeroClosedLoop();
        return;
      }
    }
    handlePidUpdate({
      enabled: true,
      ...autoTuneResult.recommendedPid,
    });
  };

  const handleComputeRootLocus = () => {
    setShowRootLocus(true);
    if (paneMode === 'ir' || paneMode === 'docs') setPaneMode('split');
    if (analysisTab === 'bode') setAnalysisTab('combined');
  };

  const handleExportPdf = () => {
    exportSystemAnalysisPdf({
      model,
      scope: pzLoopMode,
      outputIndex: model.pid.targetOutputIndex,
      inputIndex: 0,
      rootLocus,
    });
    setPdfExported(true);
    window.setTimeout(() => setPdfExported(false), 1800);
  };

  const handleCopyLatex = async () => {
    const snippet =
      latexSnippet ||
      generateLatexStabilityReport(model, model.pid.targetOutputIndex, 0);
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(snippet);
      } catch {
        // Clipboard permission unavailable; snippet remains selectable in preview
      }
    }
    setLatexCopied(true);
    window.setTimeout(() => setLatexCopied(false), 1800);
  };

  const handleDownloadLatex = () => {
    const snippet =
      latexSnippet ||
      generateLatexStabilityReport(model, model.pid.targetOutputIndex, 0);
    const blob = new Blob([snippet], { type: 'application/x-tex;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const safeId = (model.id || 'openloop_model').replace(/[^a-z0-9_-]+/gi, '_');
    a.href = url;
    a.download = `${safeId}_analysis.tex`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  useEffect(() => {
    setText(serializeModelToToml(model));
    setParseError(null);
    if (isInternalTfUpdateRef.current) {
      isInternalTfUpdateRef.current = false;
      return;
    }
    const extracted = stateSpaceToTransferFunction(
      model.plant,
      model.pid.targetOutputIndex,
      0
    );
    setTfNumText(formatCoeffCsv(extracted.numerator));
    setTfDenText(formatCoeffCsv(extracted.denominator));
    setTfError(null);
  }, [model]);

  const handleTransferFunctionChange = (nextNumRaw: string, nextDenRaw: string) => {
    setTfNumText(nextNumRaw);
    setTfDenText(nextDenRaw);

    const numParsed = parseCoefficientList(nextNumRaw);
    if (numParsed.error) {
      setTfError(numParsed.error);
      return;
    }

    const denParsed = parseCoefficientList(nextDenRaw);
    if (denParsed.error) {
      setTfError(denParsed.error);
      return;
    }

    const { model: convertedModel, error } = applyTransferFunctionToModel(
      model,
      numParsed.coeffs,
      denParsed.coeffs
    );
    if (error) {
      setTfError(error);
      return;
    }

    setTfError(null);
    isInternalTfUpdateRef.current = true;
    onChangeModel(convertedModel);
  };

  const handleSyncTfFromPlant = () => {
    const extracted = stateSpaceToTransferFunction(
      model.plant,
      model.pid.targetOutputIndex,
      0
    );
    setTfNumText(formatCoeffCsv(extracted.numerator));
    setTfDenText(formatCoeffCsv(extracted.denominator));
    setTfError(null);
  };

  const tfPreview = useMemo(() => {
    const numParsed = parseCoefficientList(tfNumText);
    if (numParsed.error) return { result: null, error: numParsed.error };
    const denParsed = parseCoefficientList(tfDenText);
    if (denParsed.error) return { result: null, error: denParsed.error };
    return transferFunctionToStateSpace(numParsed.coeffs, denParsed.coeffs);
  }, [tfNumText, tfDenText]);

  const handleApplyText = (nextText: string) => {
    setText(nextText);
    const { model: parsed, parseError: err } = parseTomlToModel(nextText, model);
    setParseError(err);
    if (!err) {
      onChangeModel(parsed);
    }
  };

  const handleToggleAlgebraicLoop = () => {
    onChangeModel({
      ...model,
      injectAlgebraicLoopTest: !model.injectAlgebraicLoopTest,
    });
  };

  const handleResetSync = () => {
    setText(serializeModelToToml(model));
    setParseError(null);
  };

  return (
    <div className="flex-1 flex flex-col lg:flex-row min-h-0 bg-[#07090E]">
      {/* Left: Editable Git-Friendly TOML IR */}
      <div className="flex-1 flex flex-col min-w-0 border-b lg:border-b-0 lg:border-r border-slate-800">
        <div className="px-5 py-3 border-b border-slate-800 bg-[#0F141E] flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-slate-100">
              Declarative Model IR (model.ctrl.toml)
            </h2>
            <p className="text-xs text-slate-400">
              Git-diffable single source of truth · edits sync directly to solver and codegen
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div
              className="flex items-center gap-0.5 p-0.5 bg-[#07090E] border border-slate-800 rounded"
              role="tablist"
              aria-label="Schema workspace mode"
            >
              {(
                [
                  { id: 'split', label: 'split' },
                  { id: 'ir', label: 'ir' },
                  { id: 'analysis', label: 'bode / pz' },
                  { id: 'docs', label: 'Documentation' },
                ] as const
              ).map((m) => (
                <button
                  key={m.id}
                  type="button"
                  role="tab"
                  aria-selected={paneMode === m.id}
                  onClick={() => setPaneMode(m.id)}
                  className={`px-2.5 py-1 text-[11px] font-mono uppercase rounded transition-colors cursor-pointer whitespace-nowrap ${
                    paneMode === m.id
                      ? 'bg-slate-800 text-cyan-300'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  {m.label}
                </button>
              ))}
            </div>
            <button
              type="button"
              onClick={handleToggleAlgebraicLoop}
              className={`px-3 py-1.5 text-xs font-medium rounded border transition-colors cursor-pointer whitespace-nowrap ${
                model.injectAlgebraicLoopTest
                  ? 'border-rose-500/50 bg-rose-500/15 text-rose-300'
                  : 'border-slate-700 bg-slate-800 hover:bg-slate-700 text-slate-200'
              }`}
            >
              {model.injectAlgebraicLoopTest
                ? 'Remove Algebraic Loop'
                : 'Inject Algebraic Loop Test'}
            </button>
            <button
              type="button"
              onClick={handleResetSync}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium border border-slate-700 bg-[#07090E] hover:bg-slate-800 text-slate-300 rounded transition-colors cursor-pointer"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              Re-format
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept=".json,.toml,.ctrl.json,.ctrl.toml"
              onChange={async (e) => {
                const file = e.target.files?.[0];
                e.target.value = '';
                if (!file) return;
                const raw = await file.text();
                const res = onImportModel(file.name, raw);
                setParseError(res.error);
              }}
              className="hidden"
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium border border-slate-700 bg-[#07090E] hover:bg-slate-800 text-slate-200 rounded transition-colors cursor-pointer whitespace-nowrap"
            >
              <Upload className="w-3.5 h-3.5 text-cyan-400" />
              Import Model
            </button>
            <button
              type="button"
              onClick={onSaveModel}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium border border-slate-700 bg-[#07090E] hover:bg-slate-800 text-cyan-300 rounded transition-colors cursor-pointer whitespace-nowrap"
            >
              <Save className="w-3.5 h-3.5" />
              Save Model
            </button>
            <button
              type="button"
              onClick={() => setShowLatexExport((prev) => !prev)}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium border rounded transition-colors cursor-pointer whitespace-nowrap ${
                showLatexExport
                  ? 'border-cyan-500/50 bg-cyan-500/15 text-cyan-200'
                  : 'border-slate-700 bg-[#07090E] hover:bg-slate-800 text-slate-200'
              }`}
            >
              <FileCode2 className="w-3.5 h-3.5 text-cyan-400" />
              Export LaTeX
            </button>
            <button
              type="button"
              onClick={handleExportPdf}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium border rounded transition-colors cursor-pointer whitespace-nowrap ${
                pdfExported
                  ? 'border-emerald-500/50 bg-emerald-500/15 text-emerald-200'
                  : 'border-cyan-500/40 bg-cyan-500/10 hover:bg-cyan-500/20 text-cyan-200'
              }`}
            >
              {pdfExported ? (
                <>
                  <Check className="w-3.5 h-3.5 text-emerald-400" />
                  PDF Saved
                </>
              ) : (
                <>
                  <FileDown className="w-3.5 h-3.5 text-cyan-300" />
                  Export to PDF
                </>
              )}
            </button>
          </div>
        </div>

        <div className="flex-1 flex flex-col min-h-0 overflow-y-auto">
          {paneMode === 'docs' && (
            <MarkdownGuideView
              markdown={TEMPLATING_ENGINE_DOCS_MD}
              onLoadTomlExample={(toml) => {
                handleApplyText(toml);
                setPaneMode('split');
              }}
            />
          )}

          {(paneMode === 'split' || paneMode === 'ir') && (
            <div
              className={`relative bg-[#07090E] ${
                paneMode === 'split' ? 'min-h-[210px] shrink-0' : 'flex-1 min-h-[380px]'
              }`}
            >
              <textarea
                value={text}
                onChange={(e) => handleApplyText(e.target.value)}
                spellCheck={false}
                aria-label="Declarative control model TOML editor"
                className="w-full h-full min-h-[210px] p-5 bg-[#07090E] text-slate-200 font-mono text-xs leading-6 resize-none focus:outline-none"
              />
            </div>
          )}

          {(paneMode === 'split' || paneMode === 'analysis') && (
            <div className="shrink-0 flex flex-col">
              <div className="px-5 py-2 border-t border-slate-800 bg-[#0B0E17] flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-1 p-0.5 bg-[#07090E] border border-slate-800 rounded">
                  {(
                    [
                      { id: 'combined', label: 'Combined (Bode + Pole-Zero)' },
                      { id: 'bode', label: 'Bode Plot' },
                      { id: 'nyquist', label: 'Nyquist Plot' },
                      { id: 'pz', label: 'Pole-Zero Map' },
                      { id: 'sensitivity', label: 'S-Domain Sensitivity' },
                    ] as const
                  ).map((tab) => (
                    <button
                      key={tab.id}
                      type="button"
                      onClick={() => setAnalysisTab(tab.id)}
                      className={`px-2.5 py-1 text-[11px] font-mono rounded transition-colors cursor-pointer whitespace-nowrap ${
                        analysisTab === tab.id
                          ? 'bg-slate-800 text-cyan-300'
                          : 'text-slate-400 hover:text-slate-200'
                      }`}
                    >
                      {tab.label}
                    </button>
                  ))}
                </div>
                <div className="flex items-center gap-4 text-[11px] font-mono tabular-nums text-slate-400">
                  <span>
                    Open λ(A):{' '}
                    <span
                      className={
                        stabilitySummary.openLoopVerdict === 'STABLE'
                          ? 'text-emerald-400'
                          : stabilitySummary.openLoopVerdict === 'MARGINAL'
                          ? 'text-amber-300'
                          : 'text-rose-400'
                      }
                    >
                      {stabilitySummary.openLoopVerdict}
                    </span>
                  </span>
                  <span>
                    Closed λ(Acl):{' '}
                    <span
                      className={
                        stabilitySummary.closedLoopVerdict === 'STABLE'
                          ? 'text-emerald-400'
                          : stabilitySummary.closedLoopVerdict === 'MARGINAL'
                          ? 'text-amber-300'
                          : 'text-rose-400'
                      }
                    >
                      {stabilitySummary.closedLoopVerdict}
                    </span>
                  </span>
                </div>
              </div>

              {(analysisTab === 'bode' || analysisTab === 'combined') && (
                <BodePlot model={model} />
              )}
              {analysisTab === 'nyquist' && <NyquistPlot model={model} />}
              {analysisTab === 'sensitivity' && (
                <SDomainSensitivityPlot model={model} />
              )}
              {(analysisTab === 'pz' || analysisTab === 'combined') && (
                <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_288px]">
                  <div className="min-w-0">
                    <PoleZeroPlot
                      model={model}
                      rootLocus={rootLocus}
                      onClearRootLocus={() => setShowRootLocus(false)}
                      controllerFocusTick={controllerFocusTick}
                      onLoopModeChange={setPzLoopMode}
                    />
                  </div>
                  <div className="border-t border-slate-800 xl:border-l">
                    <StepResponseThumbnail model={model} />
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Right: Static Graph Validator & Rate Scheduler */}
      <aside className="w-full lg:w-[400px] bg-[#0B0E17] flex flex-col shrink-0 overflow-y-auto">
        <div className="px-5 py-3 border-b border-slate-800 bg-[#0F141E]">
          <h3 className="text-sm font-semibold text-slate-100">
            Graph Validator &amp; Rate Scheduler
          </h3>
          <p className="text-xs text-slate-400">
            Topological sort, algebraic loop &amp; multi-rate checks
          </p>
        </div>

        <div className="p-5 space-y-5">
          {/* Overall Status */}
          <div
            className={`p-3.5 rounded border ${
              parseError || !validation.valid
                ? 'border-rose-500/40 bg-rose-500/10'
                : 'border-emerald-500/30 bg-emerald-500/10'
            }`}
          >
            <div className="flex items-center gap-2 text-xs font-semibold">
              {parseError || !validation.valid ? (
                <>
                  <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0" />
                  <span className="text-rose-300">
                    {parseError ? 'IR Syntax Error' : 'Validation Failed'}
                  </span>
                </>
              ) : (
                <>
                  <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
                  <span className="text-emerald-300">
                    Graph Validated · Deterministic Schedule Ready
                  </span>
                </>
              )}
            </div>
            {parseError && (
              <p className="mt-2 text-xs font-mono text-rose-200">{parseError}</p>
            )}
          </div>

          {/* Validation Issues */}
          {validation.issues.length > 0 && (
            <div className="space-y-2.5">
              <div className="text-xs font-semibold text-slate-300">
                Diagnostics ({validation.issues.length})
              </div>
              {validation.issues.map((issue, idx) => (
                <div
                  key={idx}
                  className="p-3 rounded border border-rose-500/30 bg-[#0F141E] space-y-1"
                >
                  <div className="text-xs font-mono font-semibold text-rose-300">
                    [{issue.code}] {issue.message}
                  </div>
                  <div className="text-xs text-slate-400">{issue.detail}</div>
                  <div className="text-[11px] font-mono text-slate-500">
                    Blocks: {issue.involvedBlocks.join(', ')}
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Controller Design Sub-Panel (Interactive PID Gain Tuning) */}
          <section
            aria-labelledby="schema-controller-design-heading"
            className="border-t border-slate-800 pt-4 space-y-3"
          >
            <div className="flex items-start justify-between gap-2">
              <div>
                <h4
                  id="schema-controller-design-heading"
                  className="text-xs font-semibold text-slate-200 flex items-center gap-1.5"
                >
                  <SlidersHorizontal className="w-3.5 h-3.5 text-cyan-400" />
                  Controller Design
                </h4>
                <p className="text-[11px] text-slate-400">
                  Tune PID gains to observe real-time pole-zero shifts
                </p>
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                <button
                  type="button"
                  onClick={() =>
                    handlePidUpdate({ enabled: !model.pid.enabled })
                  }
                  className={`px-2 py-1 text-[10px] font-mono rounded border transition-colors cursor-pointer ${
                    model.pid.enabled
                      ? 'border-cyan-500/50 bg-cyan-500/15 text-cyan-200'
                      : 'border-slate-700 bg-[#07090E] text-slate-400 hover:text-slate-200'
                  }`}
                >
                  {model.pid.enabled ? 'PID Active' : 'Bypassed'}
                </button>
                <button
                  type="button"
                  onClick={handleResetPid}
                  title="Reset PID gains"
                  className="inline-flex items-center gap-1 px-2 py-1 text-[10px] font-mono border border-slate-700 bg-[#07090E] hover:bg-slate-800 text-slate-300 rounded transition-colors cursor-pointer"
                >
                  <RotateCcw className="w-3 h-3" />
                  Reset
                </button>
              </div>
            </div>

            {model.plant.p > 1 && (
              <div className="flex items-center justify-between gap-2">
                <label
                  htmlFor="schema-pid-output-select"
                  className="text-[11px] font-mono text-slate-400 shrink-0"
                >
                  Regulated Output
                </label>
                <select
                  id="schema-pid-output-select"
                  value={model.pid.targetOutputIndex}
                  onChange={(e) =>
                    handlePidUpdate({ targetOutputIndex: Number(e.target.value) })
                  }
                  className="flex-1 min-w-0 bg-[#07090E] border border-slate-800 rounded px-2 py-1 text-[11px] font-mono text-slate-100 focus:outline-none focus:border-cyan-400 cursor-pointer"
                >
                  {model.plant.outputNames.map((name, idx) => (
                    <option key={idx} value={idx}>
                      y[{idx}]: {name}
                    </option>
                  ))}
                </select>
              </div>
            )}

            <div className="space-y-2.5">
              {(
                [
                  {
                    key: 'kp',
                    label: 'Proportional Kp',
                    value: model.pid.kp,
                    baseline: baselinePid.kp,
                    fallbackMax: 20,
                    accentClass: 'accent-cyan-400',
                    textClass: 'text-cyan-300',
                  },
                  {
                    key: 'ki',
                    label: 'Integral Ki',
                    value: model.pid.ki,
                    baseline: baselinePid.ki,
                    fallbackMax: 40,
                    accentClass: 'accent-emerald-400',
                    textClass: 'text-emerald-300',
                  },
                  {
                    key: 'kd',
                    label: 'Derivative Kd',
                    value: model.pid.kd,
                    baseline: baselinePid.kd,
                    fallbackMax: 5,
                    accentClass: 'accent-violet-400',
                    textClass: 'text-violet-300',
                  },
                ] as const
              ).map((param) => {
                const bounds = computeGainSliderBounds(
                  param.baseline,
                  param.value,
                  param.fallbackMax
                );
                return (
                  <div
                    key={param.key}
                    className="p-2.5 rounded border border-slate-800 bg-[#07090E] space-y-1.5"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <label
                        htmlFor={`schema-pid-${param.key}-num`}
                        className="text-[11px] font-mono text-slate-300"
                      >
                        {param.label}
                      </label>
                      <input
                        id={`schema-pid-${param.key}-num`}
                        type="number"
                        step={bounds.step}
                        value={param.value}
                        disabled={!model.pid.enabled}
                        onChange={(e) => {
                          const parsed = Number(e.target.value);
                          if (Number.isFinite(parsed)) {
                            handlePidUpdate({ [param.key]: parsed });
                          }
                        }}
                        className={`w-24 bg-[#0B0E17] border border-slate-800 rounded px-2 py-0.5 text-[11px] font-mono tabular-nums text-right focus:outline-none focus:border-cyan-400 disabled:opacity-45 ${param.textClass}`}
                      />
                    </div>
                    <input
                      aria-label={`${param.label} slider`}
                      type="range"
                      min={bounds.min}
                      max={bounds.max}
                      step={bounds.step}
                      value={param.value}
                      disabled={!model.pid.enabled}
                      onChange={(e) =>
                        handlePidUpdate({ [param.key]: Number(e.target.value) })
                      }
                      className={`w-full h-1.5 bg-slate-800 rounded cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed ${param.accentClass}`}
                    />
                    <div className="flex items-center justify-between text-[9.5px] font-mono tabular-nums text-slate-500">
                      <span>{bounds.min}</span>
                      <span>step {bounds.step}</span>
                      <span>{bounds.max}</span>
                    </div>
                  </div>
                );
              })}

              <div className="flex items-center justify-between gap-3 px-2.5 py-2 rounded border border-slate-800 bg-[#07090E]">
                <label
                  htmlFor="schema-pid-nfilter"
                  className="text-[11px] font-mono text-slate-400 shrink-0"
                >
                  Deriv Filter N (rad/s)
                </label>
                <div className="flex items-center gap-2 flex-1 min-w-0">
                  <input
                    aria-label="Derivative filter coefficient N slider"
                    type="range"
                    min={1}
                    max={Math.max(200, Math.ceil(baselinePid.nFilter * 2))}
                    step={1}
                    value={Math.max(1, model.pid.nFilter)}
                    disabled={!model.pid.enabled}
                    onChange={(e) =>
                      handlePidUpdate({ nFilter: Number(e.target.value) })
                    }
                    className="flex-1 min-w-0 h-1.5 bg-slate-800 rounded accent-slate-400 cursor-pointer disabled:opacity-40"
                  />
                  <input
                    id="schema-pid-nfilter"
                    type="number"
                    min={1}
                    step={5}
                    value={model.pid.nFilter}
                    disabled={!model.pid.enabled}
                    onChange={(e) => {
                      const parsed = Number(e.target.value);
                      if (Number.isFinite(parsed) && parsed >= 0.1) {
                        handlePidUpdate({ nFilter: parsed });
                      }
                    }}
                    className="w-16 bg-[#0B0E17] border border-slate-800 rounded px-1.5 py-0.5 text-[11px] font-mono tabular-nums text-slate-200 text-right focus:outline-none focus:border-cyan-400 disabled:opacity-45"
                  />
                </div>
              </div>
            </div>

            {/* ESP32 PID Auto-Tuner (Rise Time & Overshoot Constraints) */}
            <div className="p-2.5 rounded border border-slate-800 bg-[#07090E] space-y-2.5">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <div className="text-[11px] font-semibold text-slate-200 flex items-center gap-1.5">
                    <Sparkles className="w-3.5 h-3.5 text-cyan-400" />
                    ESP32 PID Auto-Tuner
                  </div>
                  <div className="text-[10px] font-mono text-slate-400 tabular-nums">
                    {model.id.startsWith('esp32')
                      ? `${model.name.split('(')[0].trim()} · ${Math.round(1 / Math.max(1e-5, model.baseDt))} Hz`
                      : `Target @ ${Math.round(1 / Math.max(1e-5, model.baseDt))} Hz`}
                  </div>
                </div>
                <div className="flex items-center gap-1 text-[10px] font-mono text-cyan-300 shrink-0">
                  <Cpu className="w-3 h-3" />
                  <select
                    aria-label="ESP32 target model for PID auto-tuner"
                    value={autoTuneBoard}
                    onChange={(e) => {
                      setAutoTuneBoard(e.target.value as Esp32BoardEnv);
                      setAutoTuneResult(null);
                    }}
                    className="bg-[#0B0E17] border border-slate-800 rounded px-1.5 py-0.5 text-[10px] font-mono text-slate-200 focus:outline-none focus:border-cyan-400 cursor-pointer"
                  >
                    {(Object.keys(ESP32_BOARD_SPECS) as Esp32BoardEnv[]).map((envKey) => (
                      <option key={envKey} value={envKey}>
                        {envKey}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div className="p-2 rounded border border-slate-800/80 bg-[#0B0E17] space-y-1">
                  <div className="flex items-center justify-between gap-1">
                    <label
                      htmlFor="schema-autotune-tr"
                      className="text-[10px] font-mono text-slate-400"
                    >
                      Rise Time t_r (s)
                    </label>
                    <input
                      id="schema-autotune-tr"
                      type="number"
                      min={Number((model.baseDt * 2.5).toPrecision(2))}
                      max={Math.max(10, model.duration)}
                      step={model.baseDt < 0.005 ? 0.001 : 0.05}
                      value={targetRiseTimeSec}
                      onChange={(e) => {
                        const val = Number(e.target.value);
                        if (Number.isFinite(val) && val > 0) {
                          setTargetRiseTimeSec(val);
                        }
                      }}
                      className="w-16 bg-[#07090E] border border-slate-800 rounded px-1.5 py-0.5 text-[10.5px] font-mono tabular-nums text-right text-cyan-300 focus:outline-none focus:border-cyan-400"
                    />
                  </div>
                  <input
                    aria-label="Target rise time slider"
                    type="range"
                    min={Number((model.baseDt * 2.5).toPrecision(2))}
                    max={Math.max(0.1, Number((model.duration * 0.5).toFixed(3)))}
                    step={model.baseDt < 0.005 ? 0.0005 : 0.02}
                    value={Math.min(
                      Math.max(0.1, Number((model.duration * 0.5).toFixed(3))),
                      targetRiseTimeSec
                    )}
                    onChange={(e) => setTargetRiseTimeSec(Number(e.target.value))}
                    className="w-full h-1 bg-slate-800 rounded accent-cyan-400 cursor-pointer"
                  />
                </div>

                <div className="p-2 rounded border border-slate-800/80 bg-[#0B0E17] space-y-1">
                  <div className="flex items-center justify-between gap-1">
                    <label
                      htmlFor="schema-autotune-os"
                      className="text-[10px] font-mono text-slate-400"
                    >
                      Max Overshoot (%)
                    </label>
                    <input
                      id="schema-autotune-os"
                      type="number"
                      min={0}
                      max={45}
                      step={1}
                      value={maxOvershootPct}
                      onChange={(e) => {
                        const val = Number(e.target.value);
                        if (Number.isFinite(val) && val >= 0 && val <= 50) {
                          setMaxOvershootPct(val);
                        }
                      }}
                      className="w-14 bg-[#07090E] border border-slate-800 rounded px-1.5 py-0.5 text-[10.5px] font-mono tabular-nums text-right text-amber-300 focus:outline-none focus:border-cyan-400"
                    />
                  </div>
                  <input
                    aria-label="Maximum overshoot percentage slider"
                    type="range"
                    min={0}
                    max={35}
                    step={1}
                    value={Math.min(35, maxOvershootPct)}
                    onChange={(e) => setMaxOvershootPct(Number(e.target.value))}
                    className="w-full h-1 bg-slate-800 rounded accent-amber-400 cursor-pointer"
                  />
                </div>
              </div>

              <div className="p-2 rounded border border-slate-800/80 bg-[#0B0E17] flex items-center justify-between gap-2">
                <label
                  htmlFor="schema-autotune-ts"
                  className="text-[10px] font-mono text-slate-400"
                >
                  Settling Target t_s (s) · ESP32+Ultrasonic Step
                </label>
                <input
                  id="schema-autotune-ts"
                  type="number"
                  min={Number((model.baseDt * 4).toPrecision(2))}
                  max={Math.max(12, model.duration)}
                  step={0.05}
                  value={maxSettlingTimeSec}
                  onChange={(e) => {
                    const val = Number(e.target.value);
                    if (Number.isFinite(val) && val > 0) {
                      setMaxSettlingTimeSec(val);
                    }
                  }}
                  className="w-18 bg-[#07090E] border border-slate-800 rounded px-1.5 py-0.5 text-[10.5px] font-mono tabular-nums text-right text-emerald-300 focus:outline-none focus:border-cyan-400"
                />
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={handleAutoTuneUltrasonicSettlingTime}
                  title="Simulate closed-loop unit step response on ESP32 + Ultrasonic model and minimize 2% settling time t_s"
                  className="flex-1 inline-flex items-center justify-center gap-1.5 py-1.5 px-2.5 text-[11px] font-mono font-semibold rounded border border-emerald-500/50 bg-emerald-500/15 hover:bg-emerald-500/25 text-emerald-200 transition-colors cursor-pointer whitespace-nowrap shrink-0"
                >
                  <Sparkles className="w-3.5 h-3.5 text-emerald-300" />
                  Auto-Tune
                </button>
                <button
                  type="button"
                  onClick={handleRunPidAutoTune}
                  title="Suggest PID gains for currently active model using rise-time and overshoot targets"
                  className="flex-1 inline-flex items-center justify-center gap-1.5 py-1.5 px-2.5 text-[11px] font-mono font-medium rounded border border-cyan-500/50 bg-cyan-500/15 hover:bg-cyan-500/25 text-cyan-200 transition-colors cursor-pointer whitespace-nowrap shrink-0"
                >
                  <SlidersHorizontal className="w-3.5 h-3.5 text-cyan-300" />
                  Suggest Optimal PID
                </button>
                {autoTuneResult && (
                  <button
                    type="button"
                    onClick={handleApplySuggestedPid}
                    className="w-full inline-flex items-center justify-center gap-1 py-1.5 px-2.5 text-[11px] font-mono font-medium rounded border border-cyan-500/50 bg-[#0B0E17] hover:bg-slate-800 text-cyan-200 transition-colors cursor-pointer whitespace-nowrap shrink-0"
                  >
                    <Check className="w-3.5 h-3.5 text-emerald-400" />
                    {autoTuneResult.targetModelId !== model.id
                      ? 'Load ESP32+Ultrasonic & Apply Gains'
                      : 'Apply Gains'}
                  </button>
                )}
              </div>

              {autoTuneResult && (
                <div className="p-2 rounded border border-cyan-500/30 bg-[#0B0E17] space-y-1.5 text-[10.5px] font-mono tabular-nums">
                  <div className="flex items-center justify-between gap-2">
                    <span
                      className={
                        autoTuneResult.meetsConstraints
                          ? 'text-emerald-400'
                          : 'text-amber-300'
                      }
                    >
                      {autoTuneResult.meetsConstraints
                        ? '● Constraints Met'
                        : '▲ Closest Stable Trade-off'}
                    </span>
                    <span className="text-slate-400">
                      {autoTuneResult.objective === 'min_settling_time'
                        ? 'Min t_s · '
                        : ''}
                      {autoTuneResult.iterationsEvaluated} evals
                    </span>
                  </div>

                  {autoTuneResult.targetModelId !== model.id && (
                    <div className="text-[9.5px] text-cyan-300 truncate">
                      Target: {autoTuneResult.targetModelName}
                    </div>
                  )}

                  <div className="grid grid-cols-4 gap-1.5 text-center">
                    <div className="p-1 rounded bg-[#07090E] border border-slate-800/80">
                      <div className="text-[9.5px] text-slate-500">Kp</div>
                      <div className="text-cyan-300 font-semibold">
                        {autoTuneResult.recommendedPid.kp}
                      </div>
                    </div>
                    <div className="p-1 rounded bg-[#07090E] border border-slate-800/80">
                      <div className="text-[9.5px] text-slate-500">Ki</div>
                      <div className="text-emerald-300 font-semibold">
                        {autoTuneResult.recommendedPid.ki}
                      </div>
                    </div>
                    <div className="p-1 rounded bg-[#07090E] border border-slate-800/80">
                      <div className="text-[9.5px] text-slate-500">Kd</div>
                      <div className="text-violet-300 font-semibold">
                        {autoTuneResult.recommendedPid.kd}
                      </div>
                    </div>
                    <div className="p-1 rounded bg-[#07090E] border border-slate-800/80">
                      <div className="text-[9.5px] text-slate-500">Filter N</div>
                      <div className="text-slate-200 font-semibold">
                        {autoTuneResult.recommendedPid.nFilter}
                      </div>
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-1.5 text-[10px] text-slate-400 pt-0.5">
                    <span>
                      Settling t_s:{' '}
                      <span className="text-emerald-300 font-semibold">
                        {autoTuneResult.achievedSettlingTimeSec !== null
                          ? `${autoTuneResult.achievedSettlingTimeSec.toFixed(3)}s`
                          : '—'}
                      </span>
                      {autoTuneResult.baselineSettlingTimeSec !== null && (
                        <span className="text-slate-500">
                          {' '}
                          (was {autoTuneResult.baselineSettlingTimeSec.toFixed(2)}s)
                        </span>
                      )}
                    </span>
                    <span className="text-right">
                      t_r:{' '}
                      <span className="text-slate-200">
                        {autoTuneResult.achievedRiseTimeSec !== null
                          ? `${autoTuneResult.achievedRiseTimeSec.toFixed(3)}s`
                          : '—'}
                      </span>{' '}
                      · OS:{' '}
                      <span className="text-slate-200">
                        {autoTuneResult.achievedOvershootPct !== null
                          ? `${autoTuneResult.achievedOvershootPct.toFixed(1)}%`
                          : '—'}
                      </span>
                    </span>
                  </div>
                </div>
              )}
            </div>

            {/* Live Pole-Zero Shift Feedback Bar */}
            <div className="p-2.5 rounded border border-slate-800 bg-[#07090E] space-y-1.5 text-[11px] font-mono tabular-nums">
              <div className="flex items-center justify-between gap-2">
                <span
                  className={
                    stabilitySummary.closedLoopVerdict === 'STABLE'
                      ? 'text-emerald-400'
                      : stabilitySummary.closedLoopVerdict === 'MARGINAL'
                      ? 'text-amber-300'
                      : 'text-rose-400'
                  }
                >
                  {stabilitySummary.closedLoopVerdict === 'STABLE'
                    ? '● Closed-Loop Stable'
                    : stabilitySummary.closedLoopVerdict === 'MARGINAL'
                    ? '▲ Closed-Loop Marginal'
                    : '✖ Closed-Loop Unstable'}
                </span>
                <span className="text-slate-400">
                  max Re(λ)={stabilitySummary.maxRealPartClosed.toFixed(3)}
                </span>
              </div>

              <div className="flex flex-wrap items-center justify-between gap-2 text-[10px] text-slate-400">
                <span>
                  {closedSummaryForDesigner.dominantPole
                    ? `Dom λ: ${closedSummaryForDesigner.dominantPole.re.toFixed(2)}${
                        Math.abs(closedSummaryForDesigner.dominantPole.im) > 1e-4
                          ? ` ± j${Math.abs(closedSummaryForDesigner.dominantPole.im).toFixed(2)}`
                          : ''
                      }`
                    : 'No poles'}
                </span>
                <span>
                  {closedSummaryForDesigner.dampingRatio !== null
                    ? `ζ=${closedSummaryForDesigner.dampingRatio.toFixed(3)}`
                    : 'ζ=—'}{' '}
                  ·{' '}
                  {closedSummaryForDesigner.naturalFreqRad !== null
                    ? `ωₙ=${closedSummaryForDesigner.naturalFreqRad.toFixed(2)}`
                    : 'ωₙ=—'}
                </span>
              </div>

              <div className="pt-1 border-t border-slate-800/80 flex items-center justify-between gap-2 text-[10px]">
                <span className="text-violet-300 truncate">
                  PID Zeros:{' '}
                  {pidZeros.length === 0
                    ? 'None'
                    : pidZeros
                        .map((z) =>
                          Math.abs(z.im) < 1e-5
                            ? z.re.toFixed(2)
                            : `${z.re.toFixed(2)}${z.im >= 0 ? '+' : '-'}j${Math.abs(z.im).toFixed(2)}`
                        )
                        .join(', ')}
                </span>
                {(pzLoopMode !== 'closed' || paneMode === 'ir' || analysisTab === 'bode') && (
                  <button
                    type="button"
                    onClick={revealPoleZeroClosedLoop}
                    className="px-2 py-0.5 text-[10px] font-mono border border-cyan-500/40 bg-cyan-500/10 hover:bg-cyan-500/20 text-cyan-200 rounded transition-colors cursor-pointer shrink-0"
                  >
                    Show Closed P-Z
                  </button>
                )}
              </div>
            </div>
          </section>

          {/* Stability Summary Panel (Pole-Zero Derived Metrics) */}
          <section
            aria-labelledby="schema-stability-summary-heading"
            className="border-t border-slate-800 pt-4 space-y-3"
          >
            <div className="flex items-center justify-between gap-2">
              <div>
                <h4
                  id="schema-stability-summary-heading"
                  className="text-xs font-semibold text-slate-200"
                >
                  Stability Summary (Pole-Zero)
                </h4>
                <p className="text-[11px] text-slate-400">
                  Damping ζ, ωₙ &amp; crossover margins ({pzSummary.poleCount}p /{' '}
                  {pzSummary.zeroCount}z)
                </p>
              </div>
              <div className="flex items-center gap-0.5 p-0.5 bg-[#07090E] border border-slate-800 rounded shrink-0">
                {(
                  [
                    { id: 'closed', label: 'Closed' },
                    { id: 'open', label: 'Open' },
                  ] as const
                ).map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => setStabilityScope(item.id)}
                    className={`px-2 py-0.5 text-[10px] font-mono rounded transition-colors cursor-pointer ${
                      stabilityScope === item.id
                        ? 'bg-slate-800 text-cyan-300'
                        : 'text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="flex items-center justify-between px-2.5 py-1.5 rounded border border-slate-800 bg-[#07090E] text-[11px] font-mono tabular-nums">
              <span className="text-slate-400 truncate pr-2">
                {pzSummary.dominantPole
                  ? `Dom: ${pzSummary.dominantPole.re.toFixed(3)}${
                      Math.abs(pzSummary.dominantPole.im) > 1e-6
                        ? ` ± j${Math.abs(pzSummary.dominantPole.im).toFixed(3)}`
                        : ''
                    }`
                  : 'No poles'}
              </span>
              <span
                className={
                  pzSummary.verdict === 'STABLE'
                    ? 'text-emerald-400 shrink-0'
                    : pzSummary.verdict === 'MARGINAL'
                    ? 'text-amber-300 shrink-0'
                    : 'text-rose-400 shrink-0'
                }
              >
                {pzSummary.dampingRegime}
              </span>
            </div>

            <div className="grid grid-cols-2 gap-2 text-xs font-mono tabular-nums">
              <div className="p-2.5 rounded border border-slate-800 bg-[#07090E]">
                <div className="text-[11px] text-slate-500">Damping Ratio ζ</div>
                <div className="text-slate-100 font-semibold mt-0.5">
                  {pzSummary.dampingRatio !== null
                    ? pzSummary.dampingRatio.toFixed(4)
                    : '—'}
                </div>
                <div className="text-[10px] text-slate-500 mt-0.5">
                  {pzSummary.minDampingRatio !== null &&
                  pzSummary.dampingRatio !== null &&
                  Math.abs(pzSummary.minDampingRatio - pzSummary.dampingRatio) > 1e-3
                    ? `Min mode: ${pzSummary.minDampingRatio.toFixed(3)}`
                    : pzSummary.verdict}
                </div>
              </div>

              <div className="p-2.5 rounded border border-slate-800 bg-[#07090E]">
                <div className="text-[11px] text-slate-500">Natural Freq ωₙ</div>
                <div className="text-cyan-300 font-semibold mt-0.5">
                  {pzSummary.naturalFreqRad !== null
                    ? `${pzSummary.naturalFreqRad.toFixed(2)} rad/s`
                    : '—'}
                </div>
                <div className="text-[10px] text-slate-500 mt-0.5">
                  {pzSummary.naturalFreqHz !== null
                    ? `${pzSummary.naturalFreqHz.toFixed(2)} Hz`
                    : 'Origin pole'}
                </div>
              </div>

              <div className="p-2.5 rounded border border-slate-800 bg-[#07090E]">
                <div className="text-[11px] text-slate-500">Gain Margin</div>
                <div
                  className={`font-semibold mt-0.5 ${
                    pzSummary.gainMarginDb === null
                      ? 'text-slate-200'
                      : pzSummary.gainMarginDb > 0
                      ? 'text-emerald-400'
                      : 'text-rose-400'
                  }`}
                >
                  {pzSummary.gainMarginDb !== null
                    ? `${pzSummary.gainMarginDb.toFixed(2)} dB`
                    : '∞ dB'}
                </div>
                <div className="text-[10px] text-slate-500 mt-0.5">
                  {pzSummary.phaseCrossoverOmega !== null
                    ? `ω_pc = ${pzSummary.phaseCrossoverOmega.toFixed(2)} rad/s`
                    : 'No -180° cross'}
                </div>
              </div>

              <div className="p-2.5 rounded border border-slate-800 bg-[#07090E]">
                <div className="text-[11px] text-slate-500">Phase Margin</div>
                <div
                  className={`font-semibold mt-0.5 ${
                    pzSummary.phaseMarginDeg === null
                      ? 'text-slate-200'
                      : pzSummary.phaseMarginDeg > 0
                      ? 'text-emerald-400'
                      : 'text-rose-400'
                  }`}
                >
                  {pzSummary.phaseMarginDeg !== null
                    ? `${pzSummary.phaseMarginDeg.toFixed(1)}°`
                    : 'No 0 dB'}
                </div>
                <div className="text-[10px] text-slate-500 mt-0.5">
                  {pzSummary.gainCrossoverOmega !== null
                    ? `ω_gc = ${pzSummary.gainCrossoverOmega.toFixed(2)} rad/s`
                    : 'Gain < 0 dB'}
                </div>
              </div>
            </div>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setShowLatexExport((prev) => !prev)}
                className={`flex-1 inline-flex items-center justify-center gap-1.5 py-1.5 px-2.5 text-[11px] font-mono rounded border transition-colors cursor-pointer whitespace-nowrap ${
                  showLatexExport
                    ? 'border-cyan-500/50 bg-cyan-500/15 text-cyan-200'
                    : 'border-slate-700 bg-[#07090E] hover:bg-slate-800 text-slate-200'
                }`}
              >
                <FileCode2 className="w-3.5 h-3.5 text-cyan-400" />
                {showLatexExport ? 'Hide LaTeX' : 'LaTeX Report'}
              </button>
              <button
                type="button"
                onClick={handleDownloadLatex}
                title="Download .tex analysis report"
                className="inline-flex items-center gap-1 py-1.5 px-2.5 text-[11px] font-mono rounded border border-slate-700 bg-[#07090E] hover:bg-slate-800 text-slate-300 transition-colors cursor-pointer whitespace-nowrap"
              >
                <Download className="w-3.5 h-3.5" />
                .tex
              </button>
              <button
                type="button"
                onClick={handleExportPdf}
                title="Compile LaTeX report, s-plane pole-zero plot, and stability metrics into PDF"
                className={`inline-flex items-center gap-1.5 py-1.5 px-2.5 text-[11px] font-mono rounded border transition-colors cursor-pointer whitespace-nowrap ${
                  pdfExported
                    ? 'border-emerald-500/50 bg-emerald-500/15 text-emerald-200'
                    : 'border-cyan-500/50 bg-cyan-500/15 hover:bg-cyan-500/25 text-cyan-200'
                }`}
              >
                {pdfExported ? (
                  <>
                    <Check className="w-3.5 h-3.5 text-emerald-400" />
                    Saved
                  </>
                ) : (
                  <>
                    <FileDown className="w-3.5 h-3.5" />
                    Export to PDF
                  </>
                )}
              </button>
            </div>

            {showLatexExport && (
              <div className="rounded border border-cyan-500/30 bg-[#07090E] overflow-hidden">
                <div className="px-2.5 py-1.5 border-b border-slate-800 bg-[#0F141E] flex items-center justify-between gap-2">
                  <span className="text-[10px] font-mono text-cyan-300">
                    LaTeX Analysis Snippet
                  </span>
                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={handleCopyLatex}
                      className="inline-flex items-center gap-1 px-2 py-0.5 text-[10px] font-mono border border-slate-700 bg-[#07090E] hover:bg-slate-800 text-slate-200 rounded transition-colors cursor-pointer"
                    >
                      {latexCopied ? (
                        <>
                          <Check className="w-3 h-3 text-emerald-400" />
                          <span className="text-emerald-300">Copied</span>
                        </>
                      ) : (
                        <>
                          <Copy className="w-3 h-3" />
                          <span>Copy</span>
                        </>
                      )}
                    </button>
                    <button
                      type="button"
                      onClick={handleDownloadLatex}
                      className="inline-flex items-center gap-1 px-2 py-0.5 text-[10px] font-mono border border-slate-700 bg-[#07090E] hover:bg-slate-800 text-cyan-300 rounded transition-colors cursor-pointer"
                    >
                      <Download className="w-3 h-3" />
                      <span>Save .tex</span>
                    </button>
                  </div>
                </div>
                <textarea
                  readOnly
                  value={latexSnippet}
                  aria-label="Exported LaTeX system analysis report"
                  spellCheck={false}
                  rows={10}
                  className="w-full p-2.5 bg-[#07090E] text-[10px] font-mono leading-4 text-slate-300 resize-y focus:outline-none"
                />
              </div>
            )}
          </section>

          {/* Classical Transfer Function -> State-Space Auto-Converter */}
          <section
            aria-labelledby="schema-tf-heading"
            className="border-t border-slate-800 pt-4 space-y-3"
          >
            <div className="flex items-center justify-between gap-2">
              <div>
                <h4
                  id="schema-tf-heading"
                  className="text-xs font-semibold text-slate-200"
                >
                  Transfer Function G(s) → State-Space
                </h4>
                <p className="text-[11px] text-slate-400">
                  Auto-converts descending N(s)/D(s) coefficients into (A, B, C, D)
                </p>
              </div>
              <button
                type="button"
                onClick={handleSyncTfFromPlant}
                className="px-2 py-1 text-[10px] font-mono border border-slate-700 bg-[#07090E] hover:bg-slate-800 text-slate-300 rounded transition-colors cursor-pointer shrink-0"
              >
                Sync Plant
              </button>
            </div>

            <div className="space-y-2">
              <div>
                <label
                  htmlFor="schema-tf-num"
                  className="block text-[11px] font-mono text-slate-400 mb-1"
                >
                  Numerator N(s)
                </label>
                <input
                  id="schema-tf-num"
                  type="text"
                  value={tfNumText}
                  onChange={(e) =>
                    handleTransferFunctionChange(e.target.value, tfDenText)
                  }
                  placeholder="e.g. 1, 3"
                  className="w-full bg-[#07090E] border border-slate-800 rounded px-2.5 py-1.5 text-xs font-mono text-slate-100 focus:outline-none focus:border-cyan-400"
                />
              </div>

              <div>
                <label
                  htmlFor="schema-tf-den"
                  className="block text-[11px] font-mono text-slate-400 mb-1"
                >
                  Denominator D(s)
                </label>
                <input
                  id="schema-tf-den"
                  type="text"
                  value={tfDenText}
                  onChange={(e) =>
                    handleTransferFunctionChange(tfNumText, e.target.value)
                  }
                  placeholder="e.g. 1, 4, 16"
                  className="w-full bg-[#07090E] border border-slate-800 rounded px-2.5 py-1.5 text-xs font-mono text-slate-100 focus:outline-none focus:border-cyan-400"
                />
              </div>
            </div>

            {tfError || tfPreview.error || !tfPreview.result ? (
              <div
                role="alert"
                className="p-2.5 rounded border border-rose-500/40 bg-rose-500/10 text-[11px] font-mono text-rose-300"
              >
                {tfError || tfPreview.error}
              </div>
            ) : (
              <div className="p-2.5 rounded border border-slate-800 bg-[#07090E] space-y-2 text-[11px] font-mono tabular-nums">
                <div className="text-cyan-300 break-words">
                  G(s) = ({formatPolynomial(tfPreview.result.normalizedNum)}) / (
                  {formatPolynomial(tfPreview.result.normalizedDen)})
                </div>
                <div className="flex flex-wrap items-center justify-between gap-2 text-[10px] text-slate-400">
                  <span>Canonical n={tfPreview.result.order}</span>
                  <span>
                    DC Gain:{' '}
                    <span className="text-slate-200">
                      {tfPreview.result.dcGain !== null
                        ? tfPreview.result.dcGain.toFixed(4)
                        : '∞ (Integrator)'}
                    </span>
                  </span>
                  <span>D = [[{tfPreview.result.D[0][0].toFixed(3)}]]</span>
                </div>
                <div className="pt-1.5 border-t border-slate-800/80 space-y-1 text-[10px] text-slate-400">
                  <div className="truncate">
                    A = [
                    {tfPreview.result.A.map(
                      (row) => `[${row.map((v) => Number(v.toPrecision(4))).join(', ')}]`
                    ).join(', ')}
                    ]
                  </div>
                  <div className="truncate">
                    B = [{tfPreview.result.B.map((row) => row[0]).join(', ')}]ᵀ · C = [
                    {tfPreview.result.C[0]
                      .map((v) => Number(v.toPrecision(4)))
                      .join(', ')}
                    ]
                  </div>
                </div>
              </div>
            )}

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={handleComputeRootLocus}
                className="flex-1 py-1.5 px-3 text-[11px] font-mono font-medium rounded border border-sky-500/50 bg-sky-500/15 hover:bg-sky-500/25 text-sky-200 transition-colors cursor-pointer"
              >
                Compute Root Locus
              </button>
              {showRootLocus && (
                <button
                  type="button"
                  onClick={() => setShowRootLocus(false)}
                  className="py-1.5 px-2.5 text-[11px] font-mono rounded border border-slate-700 bg-[#07090E] hover:bg-slate-800 text-slate-300 transition-colors cursor-pointer"
                >
                  Hide
                </button>
              )}
            </div>

            {rootLocus && rootLocus.branches.length > 0 && (
              <div className="p-2.5 rounded border border-sky-500/30 bg-[#07090E] space-y-1 text-[10px] font-mono tabular-nums text-slate-300">
                <div className="flex items-center justify-between text-sky-300">
                  <span>
                    Root Locus Active ({rootLocus.branches.length} branches)
                  </span>
                  <span>
                    K ∈ [0, {rootLocus.kMax.toFixed(0)}]
                  </span>
                </div>
                {rootLocus.asymptoteCentroid !== null && (
                  <div className="text-slate-400">
                    Asymptotes: σ_a = {rootLocus.asymptoteCentroid.toFixed(2)} · θ ={' '}
                    {rootLocus.asymptoteAnglesDeg.map((a) => `${a.toFixed(0)}°`).join(', ')}
                  </div>
                )}
                {rootLocus.jwCrossings.length > 0 && (
                  <div className="text-amber-300">
                    jω-Crossing:{' '}
                    {rootLocus.jwCrossings
                      .map((c) => `K=${c.gainK.toFixed(2)} (ω=${c.omega.toFixed(2)})`)
                      .join(' · ')}
                  </div>
                )}
              </div>
            )}
          </section>

          {/* Multi-rate Clock Tree */}
          <div className="border-t border-slate-800 pt-4 space-y-2.5">
            <div className="text-xs font-semibold text-slate-300">
              Multi-Rate Fixed-Step Schedule
            </div>
            <div className="grid grid-cols-3 gap-2 text-xs font-mono tabular-nums">
              <div className="p-2.5 rounded border border-slate-800 bg-[#07090E]">
                <div className="text-[11px] text-slate-500">Base Rate</div>
                <div className="text-slate-100 font-semibold mt-0.5">
                  {validation.multiRateSummary.baseHz} Hz
                </div>
              </div>
              <div className="p-2.5 rounded border border-slate-800 bg-[#07090E]">
                <div className="text-[11px] text-slate-500">Fast Sub-Loop</div>
                <div className="text-cyan-300 font-semibold mt-0.5">
                  {validation.multiRateSummary.fastHz} Hz
                </div>
              </div>
              <div className="p-2.5 rounded border border-slate-800 bg-[#07090E]">
                <div className="text-[11px] text-slate-500">Ratio</div>
                <div className="text-slate-100 font-semibold mt-0.5">
                  {validation.multiRateSummary.lcmRatio}×
                </div>
              </div>
            </div>
          </div>

          {/* Topological Execution Order */}
          <div className="border-t border-slate-800 pt-4 space-y-2.5">
            <div className="text-xs font-semibold text-slate-300">
              Lowered Execution Order (Kahn Sort)
            </div>
            <div className="space-y-1">
              {validation.executionOrder.map((blockId, idx) => {
                const block = model.blocks.find((b) => b.id === blockId);
                return (
                  <div
                    key={blockId}
                    className="flex items-center justify-between px-3 py-1.5 rounded border border-slate-800/80 bg-[#07090E] text-xs font-mono tabular-nums"
                  >
                    <span className="text-slate-300">
                      <span className="text-slate-500 mr-2">
                        {String(idx + 1).padStart(2, '0')}.
                      </span>
                      {blockId}
                    </span>
                    <span className="text-[11px] text-slate-500">
                      {block?.dt === 0
                        ? 'CONT'
                        : `${Math.round(1 / (block?.dt ?? model.baseDt))} Hz`}
                    </span>
                  </div>
                );
              })}
              {validation.executionOrder.length === 0 && (
                <div className="text-xs text-slate-500 font-mono">
                  Execution schedule blocked by algebraic cycle.
                </div>
              )}
            </div>
          </div>
        </div>
      </aside>
    </div>
  );
};
