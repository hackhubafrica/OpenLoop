import React, { useEffect, useRef, useState } from 'react';
import {
  Play,
  Pause,
  RotateCcw,
  Zap,
  Save,
  Upload,
  Archive,
  ChevronDown,
  ChevronRight,
  Plus,
  Minus,
  TrendingUp,
} from 'lucide-react';
import {
  ControlModel,
  DiscretizationMethod,
  PresetId,
  SimulationTrace,
  ValidationReport,
} from '../types/control';
import {
  MAX_INPUT_DIM,
  MAX_OUTPUT_DIM,
  MAX_STATE_DIM,
  MIN_INPUT_DIM,
  MIN_OUTPUT_DIM,
  MIN_STATE_DIM,
  addInputChannel,
  addOutputChannel,
  removeInputChannel,
  removeOutputChannel,
  resizePlantDimensions,
} from '../utils/modelHelpers';
import { PLANT_TEMPLATES } from '../data/plantTemplates';
import { BlockDiagram } from './BlockDiagram';
import { PlantSchematic } from './PlantSchematic';
import { StateSpaceTopologyViewer } from './StateSpaceTopologyViewer';
import { Oscilloscope } from './Oscilloscope';
import { ImpulseOverlayPanel } from './ImpulseOverlayPanel';
import { FrequencyResponsePanel } from './FrequencyResponsePanel';
import { UnitConverterPanel } from './UnitConverterPanel';
import {
  applyTransferFunctionToModel,
  formatPolynomial,
  parseCoefficientList,
  transferFunctionToStateSpace,
} from '../engine/transferFunction';
import { stateSpaceToTransferFunction } from '../engine/stability';

interface WorkbenchViewProps {
  model: ControlModel;
  trace: SimulationTrace;
  validation: ValidationReport;
  activeIndex: number;
  isPlaying: boolean;
  onTogglePlay: () => void;
  onResetPlayback: () => void;
  onScrubIndex: (idx: number) => void;
  onSelectPreset: (id: PresetId) => void;
  onSelectTemplate: (templateId: string) => void;
  onChangeModel: (next: ControlModel) => void;
  onInjectImpulse: () => void;
  onSaveModel: () => void;
  onImportModel: (
    filename: string,
    rawText: string
  ) => { error: string | null; format: 'json' | 'toml' };
  onDownloadPresetZip: () => void;
}

export const WorkbenchView: React.FC<WorkbenchViewProps> = ({
  model,
  trace,
  validation,
  activeIndex,
  isPlaying,
  onTogglePlay,
  onResetPlayback,
  onScrubIndex,
  onSelectPreset,
  onSelectTemplate,
  onChangeModel,
  onInjectImpulse,
  onSaveModel,
  onImportModel,
  onDownloadPresetZip,
}) => {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [importFeedback, setImportFeedback] = useState<{
    kind: 'error' | 'ok';
    message: string;
  } | null>(null);
  const [selectedBlockId, setSelectedBlockId] = useState<string | null>('plant_ss');
  const [openGroup, setOpenGroup] = useState<
    'timing' | 'matrices' | 'controller' | 'limits' | 'converter'
  >('controller');
  const [channelTab, setChannelTab] = useState<'inputs' | 'outputs' | 'states'>(
    'inputs'
  );
  const [showTfDrawer, setShowTfDrawer] = useState(false);
  const [tfNumText, setTfNumText] = useState('1, 3');
  const [tfDenText, setTfDenText] = useState('1, 4, 16');
  const [tfLabel, setTfLabel] = useState('');
  const [tfError, setTfError] = useState<string | null>(null);
  const [diagramTabOverride, setDiagramTabOverride] = useState<
    'pipeline' | 'topology' | null
  >(null);

  const isImportedOrCustom =
    Boolean(model.isCustomModel) ||
    (model.id !== 'pendulum' && model.id !== 'dcmotor' && model.id !== 'buck');

  useEffect(() => {
    setDiagramTabOverride(null);
  }, [model.id, isImportedOrCustom]);

  const activeDiagramTab: 'pipeline' | 'topology' =
    diagramTabOverride ?? (isImportedOrCustom ? 'topology' : 'pipeline');
  const [showStepResponse, setShowStepResponse] = useState(false);

  const handleSelectBlock = (blockId: string) => {
    setSelectedBlockId(blockId);
    if (blockId === 'plant_ss') setOpenGroup('matrices');
    else if (blockId === 'lqr_ctrl' || blockId === 'pid_ctrl') setOpenGroup('controller');
    else if (blockId === 'sat_clamp' || blockId === 'rate_lim') setOpenGroup('limits');
    else setOpenGroup('timing');
  };

  const updateMatrixA = (r: number, c: number, val: number) => {
    const next = structuredClone(model);
    next.plant.A[r][c] = Number.isFinite(val) ? val : 0;
    onChangeModel(next);
  };

  const updateMatrixB = (r: number, c: number, val: number) => {
    const next = structuredClone(model);
    next.plant.B[r][c] = Number.isFinite(val) ? val : 0;
    onChangeModel(next);
  };

  const updateLqrK = (idx: number, val: number) => {
    const next = structuredClone(model);
    next.lqrK[idx] = Number.isFinite(val) ? val : 0;
    onChangeModel(next);
  };

  const updateX0 = (idx: number, val: number) => {
    const next = structuredClone(model);
    next.plant.x0[idx] = Number.isFinite(val) ? val : 0;
    onChangeModel(next);
  };

  const updateMatrixC = (r: number, c: number, val: number) => {
    const next = structuredClone(model);
    next.plant.C[r][c] = Number.isFinite(val) ? val : 0;
    onChangeModel(next);
  };

  const updateMatrixD = (r: number, c: number, val: number) => {
    const next = structuredClone(model);
    next.plant.D[r][c] = Number.isFinite(val) ? val : 0;
    onChangeModel(next);
  };

  const updateInputChannelMeta = (
    idx: number,
    field: 'name' | 'unit',
    value: string
  ) => {
    const next = structuredClone(model);
    const names =
      next.plant.inputNames && next.plant.inputNames.length === next.plant.m
        ? [...next.plant.inputNames]
        : Array.from({ length: next.plant.m }, (_, i) =>
            i === 0 ? next.plant.inputName : `u_${i}`
          );
    const units =
      next.plant.inputUnits && next.plant.inputUnits.length === next.plant.m
        ? [...next.plant.inputUnits]
        : Array.from({ length: next.plant.m }, () => next.plant.inputUnit);
    if (field === 'name') names[idx] = value;
    else units[idx] = value;
    next.plant.inputNames = names;
    next.plant.inputUnits = units;
    next.plant.inputName = names[0] || 'u_0';
    next.plant.inputUnit = units[0] || 'u';
    onChangeModel(next);
  };

  const updateOutputChannelMeta = (
    idx: number,
    field: 'name' | 'unit',
    value: string
  ) => {
    const next = structuredClone(model);
    if (field === 'name') {
      next.plant.outputNames[idx] = value;
    } else {
      next.plant.outputUnits[idx] = value;
    }
    onChangeModel(next);
  };

  const updateStateMeta = (
    idx: number,
    field: 'name' | 'unit',
    value: string
  ) => {
    const next = structuredClone(model);
    if (field === 'name') {
      next.plant.stateNames[idx] = value;
    } else {
      next.plant.stateUnits[idx] = value;
    }
    onChangeModel(next);
  };

  const updateAuxInput = (idx: number, value: number) => {
    const next = structuredClone(model);
    const prevAux = next.plant.auxInputs ?? Array(next.plant.m).fill(0);
    const updated = Array.from({ length: next.plant.m }, (_, i) =>
      i < prevAux.length ? prevAux[i] : 0
    );
    updated[idx] = Number.isFinite(value) ? value : 0;
    next.plant.auxInputs = updated;
    onChangeModel(next);
  };

  const resolvedBasePreset: PresetId =
    model.basePreset ??
    (model.id === 'pendulum' || model.id === 'dcmotor' || model.id === 'buck'
      ? model.id
      : 'pendulum');

  const inputChannelNames =
    model.plant.inputNames && model.plant.inputNames.length === model.plant.m
      ? model.plant.inputNames
      : Array.from({ length: model.plant.m }, (_, i) =>
          i === 0 ? model.plant.inputName : `u_${i}`
        );

  const inputChannelUnits =
    model.plant.inputUnits && model.plant.inputUnits.length === model.plant.m
      ? model.plant.inputUnits
      : Array.from({ length: model.plant.m }, () => model.plant.inputUnit);

  const handleFileImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const text = await file.text();
    const res = onImportModel(file.name, text);
    if (res.error) {
      setImportFeedback({ kind: 'error', message: res.error });
    } else {
      setImportFeedback({
        kind: 'ok',
        message: `Imported ${file.name} (${res.format.toUpperCase()})`,
      });
    }
  };

  const currentSample = trace.samples[activeIndex] ?? trace.samples[0];
  const baseHz = Math.round(1 / model.baseDt);
  const isBuiltinId =
    model.id === 'pendulum' || model.id === 'dcmotor' || model.id === 'buck';

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* Workspace Telemetry & Preset Ribbon */}
      <div className="min-h-11 px-4 py-2 border-b border-slate-800 bg-[#0F141E] flex flex-wrap items-center justify-between gap-4 shrink-0">
        <div className="flex flex-wrap items-center gap-3">
          <label className="text-xs text-slate-400 whitespace-nowrap" htmlFor="preset-select">
            Benchmark
          </label>
          <select
            id="preset-select"
            value={isBuiltinId ? model.id : resolvedBasePreset}
            onChange={(e) => onSelectPreset(e.target.value as PresetId)}
            className="bg-[#07090E] border border-slate-700 text-slate-100 text-xs font-medium rounded px-2.5 py-1.5 focus:outline-none focus:border-cyan-400 cursor-pointer"
          >
            <option value="pendulum">Inverted Pendulum (Cart-Pole LQR + PID)</option>
            <option value="dcmotor">DC Motor Velocity &amp; Current Cascade</option>
            <option value="buck">Buck Converter Discrete Voltage-Mode</option>
          </select>

          <label
            className="text-xs text-slate-400 whitespace-nowrap"
            htmlFor="plant-template-select"
          >
            Plant Template
          </label>
          <select
            id="plant-template-select"
            value={PLANT_TEMPLATES.some((t) => t.id === model.id) ? model.id : ''}
            onChange={(e) => {
              if (e.target.value) {
                onSelectTemplate(e.target.value);
              }
            }}
            className="bg-[#07090E] border border-slate-700 text-cyan-300 text-xs font-medium rounded px-2.5 py-1.5 focus:outline-none focus:border-cyan-400 cursor-pointer"
          >
            <option value="">Load Template…</option>
            {PLANT_TEMPLATES.map((tpl) => (
              <option key={tpl.id} value={tpl.id}>
                {tpl.category}: {tpl.label}
              </option>
            ))}
          </select>

          <div className="flex items-center gap-1 p-0.5 bg-[#07090E] border border-slate-800 rounded">
            {(['zoh', 'tustin'] as DiscretizationMethod[]).map((method) => (
              <button
                key={method}
                type="button"
                onClick={() => onChangeModel({ ...model, discretization: method })}
                className={`px-2.5 py-1 text-[11px] font-mono uppercase rounded transition-colors cursor-pointer ${
                  model.discretization === method
                    ? 'bg-slate-800 text-cyan-300'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                {method}
              </button>
            ))}
          </div>

          <span
            className={`text-xs font-mono tabular-nums whitespace-nowrap ${
              validation.valid ? 'text-emerald-400' : 'text-rose-400'
            }`}
          >
            {validation.valid
              ? `● Valid · ${baseHz} Hz (dt=${model.baseDt}s)`
              : `✖ ${validation.issues[0]?.code ?? 'Graph Fault'}`}
          </span>
        </div>

        {/* Simulation Playback & Disturbance Controls */}
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onTogglePlay}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-slate-800 hover:bg-slate-700 text-slate-100 border border-slate-700 rounded transition-colors cursor-pointer whitespace-nowrap"
          >
            {isPlaying ? <Pause className="w-3.5 h-3.5 text-cyan-400" /> : <Play className="w-3.5 h-3.5 text-cyan-400" />}
            {isPlaying ? 'Pause' : 'Play'}
          </button>

          <button
            type="button"
            onClick={onInjectImpulse}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-amber-500/10 hover:bg-amber-500/20 text-amber-300 border border-amber-500/30 rounded transition-colors cursor-pointer whitespace-nowrap"
          >
            <Zap className="w-3.5 h-3.5" />
            Inject Impulse
          </button>

          <button
            type="button"
            aria-pressed={showStepResponse}
            onClick={() => setShowStepResponse((v) => !v)}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium border rounded transition-colors cursor-pointer whitespace-nowrap ${
              showStepResponse
                ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/40'
                : 'bg-[#07090E] hover:bg-slate-800 text-slate-200 border-slate-700'
            }`}
          >
            <TrendingUp className="w-3.5 h-3.5 text-emerald-400" />
            Step Response
          </button>

          <button
            type="button"
            onClick={onResetPlayback}
            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium bg-[#07090E] hover:bg-slate-800 text-slate-300 border border-slate-800 rounded transition-colors cursor-pointer whitespace-nowrap"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            Reset
          </button>

          <input
            ref={fileInputRef}
            type="file"
            accept=".json,.toml,.ctrl.json,.ctrl.toml"
            onChange={handleFileImport}
            className="hidden"
          />

          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-[#07090E] hover:bg-slate-800 text-slate-200 border border-slate-700 rounded transition-colors cursor-pointer whitespace-nowrap"
          >
            <Upload className="w-3.5 h-3.5 text-cyan-400" />
            Import Model
          </button>

          <button
            type="button"
            onClick={onSaveModel}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-[#07090E] hover:bg-slate-800 text-cyan-300 border border-slate-700 rounded transition-colors cursor-pointer whitespace-nowrap"
          >
            <Save className="w-3.5 h-3.5" />
            Save Model
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

      {importFeedback && (
        <div
          className={`px-4 py-1.5 border-b border-slate-800 text-xs font-mono flex items-center justify-between ${
            importFeedback.kind === 'error'
              ? 'bg-rose-950/30 text-rose-300'
              : 'bg-emerald-950/20 text-emerald-300'
          }`}
        >
          <span>{importFeedback.message}</span>
          <button
            type="button"
            onClick={() => setImportFeedback(null)}
            className="text-[11px] text-slate-400 hover:text-slate-200 cursor-pointer"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Asymmetric Split Console */}
      <div className="flex-1 flex flex-col lg:flex-row min-h-0">
        {/* Left Control & Parameter Column (340px) */}
        <aside className="w-full lg:w-[340px] border-b lg:border-b-0 lg:border-r border-slate-800 bg-[#0B0E17] overflow-y-auto shrink-0">
          {/* Group 1: Timing & Reference */}
          <div className="border-b border-slate-800">
            <button
              type="button"
              onClick={() => setOpenGroup(openGroup === 'timing' ? 'controller' : 'timing')}
              className="w-full px-4 py-3 flex items-center justify-between text-left hover:bg-slate-900/60 transition-colors cursor-pointer"
            >
              <span className="text-xs font-semibold text-slate-200">
                01. Fixed-Step Timing &amp; Reference
              </span>
              {openGroup === 'timing' ? (
                <ChevronDown className="w-4 h-4 text-slate-400" />
              ) : (
                <ChevronRight className="w-4 h-4 text-slate-400" />
              )}
            </button>
            {openGroup === 'timing' && (
              <div className="px-4 pb-4 space-y-3">
                <div>
                  <div className="flex justify-between text-xs mb-1">
                    <span className="text-slate-400">Sample Period (dt)</span>
                    <span className="font-mono tabular-nums text-cyan-300">
                      {model.baseDt}s ({baseHz} Hz)
                    </span>
                  </div>
                  <input
                    type="range"
                    className="w-full instrument-slider"
                    min={model.id === 'buck' ? 0.00002 : 0.0005}
                    max={model.id === 'buck' ? 0.0002 : 0.02}
                    step={model.id === 'buck' ? 0.00001 : 0.0005}
                    value={model.baseDt}
                    onChange={(e) =>
                      onChangeModel({ ...model, baseDt: Number(e.target.value) })
                    }
                  />
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-[11px] text-slate-400 mb-1">
                      Step Target ({model.plant.outputUnits[0]})
                    </label>
                    <input
                      type="number"
                      step={
                        model.id === 'pendulum' || model.id === 'mass_spring_damper'
                          ? 0.1
                          : 1
                      }
                      value={model.reference.finalValue}
                      onChange={(e) =>
                        onChangeModel({
                          ...model,
                          reference: {
                            ...model.reference,
                            finalValue: Number(e.target.value),
                          },
                        })
                      }
                      className="w-full bg-[#07090E] border border-slate-800 rounded px-2.5 py-1.5 text-xs font-mono tabular-nums text-slate-100 focus:outline-none focus:border-cyan-400"
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] text-slate-400 mb-1">
                      Step Time (s)
                    </label>
                    <input
                      type="number"
                      step={model.duration < 0.1 ? 0.0005 : 0.1}
                      min={0}
                      max={model.duration}
                      value={model.reference.stepTime}
                      onChange={(e) =>
                        onChangeModel({
                          ...model,
                          reference: {
                            ...model.reference,
                            stepTime: Number(e.target.value),
                          },
                        })
                      }
                      className="w-full bg-[#07090E] border border-slate-800 rounded px-2.5 py-1.5 text-xs font-mono tabular-nums text-slate-100 focus:outline-none focus:border-cyan-400"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-[11px] text-slate-400 mb-1">
                      Disturbance Time (s)
                    </label>
                    <input
                      type="number"
                      step={model.duration < 0.1 ? 0.001 : 0.1}
                      min={0}
                      value={model.reference.disturbanceTime}
                      onChange={(e) =>
                        onChangeModel({
                          ...model,
                          reference: {
                            ...model.reference,
                            disturbanceTime: Number(e.target.value),
                          },
                        })
                      }
                      className="w-full bg-[#07090E] border border-slate-800 rounded px-2.5 py-1.5 text-xs font-mono tabular-nums text-slate-100 focus:outline-none focus:border-cyan-400"
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] text-slate-400 mb-1">
                      Impulse ({model.plant.inputUnit})
                    </label>
                    <input
                      type="number"
                      step={0.5}
                      value={model.reference.disturbanceMagnitude}
                      onChange={(e) =>
                        onChangeModel({
                          ...model,
                          reference: {
                            ...model.reference,
                            disturbanceMagnitude: Number(e.target.value),
                          },
                        })
                      }
                      className="w-full bg-[#07090E] border border-slate-800 rounded px-2.5 py-1.5 text-xs font-mono tabular-nums text-slate-100 focus:outline-none focus:border-cyan-400"
                    />
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Group 2: Controller LQR + PID */}
          <div className="border-b border-slate-800">
            <button
              type="button"
              onClick={() => setOpenGroup(openGroup === 'controller' ? 'matrices' : 'controller')}
              className="w-full px-4 py-3 flex items-center justify-between text-left hover:bg-slate-900/60 transition-colors cursor-pointer"
            >
              <span className="text-xs font-semibold text-slate-200">
                02. LQR Gain &amp; PID Regulator
              </span>
              {openGroup === 'controller' ? (
                <ChevronDown className="w-4 h-4 text-slate-400" />
              ) : (
                <ChevronRight className="w-4 h-4 text-slate-400" />
              )}
            </button>
            {openGroup === 'controller' && (
              <div className="px-4 pb-4 space-y-3">
                <div>
                  <div className="text-[11px] text-slate-400 mb-1.5">
                    Full-State Feedback Gain K
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    {model.lqrK.map((kVal, idx) => (
                      <div key={idx} className="flex items-center gap-1.5">
                        <span className="text-[11px] font-mono text-slate-500 w-12 truncate">
                          {model.plant.stateNames[idx]}
                        </span>
                        <input
                          type="number"
                          step={0.1}
                          value={Number(kVal.toFixed(4))}
                          onChange={(e) => updateLqrK(idx, Number(e.target.value))}
                          className="w-full bg-[#07090E] border border-slate-800 rounded px-2 py-1 text-xs font-mono tabular-nums text-cyan-300 focus:outline-none focus:border-cyan-400"
                        />
                      </div>
                    ))}
                  </div>
                </div>

                <div className="pt-2 border-t border-slate-800/70">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-[11px] text-slate-300 font-medium truncate">
                      PID Regulator ({model.plant.outputNames[model.pid.targetOutputIndex] ?? `y_${model.pid.targetOutputIndex}`})
                    </span>
                    <button
                      type="button"
                      onClick={() =>
                        onChangeModel({
                          ...model,
                          pid: { ...model.pid, enabled: !model.pid.enabled },
                        })
                      }
                      className={`px-2 py-0.5 text-[11px] font-mono rounded border cursor-pointer shrink-0 ${
                        model.pid.enabled
                          ? 'border-cyan-500/40 bg-cyan-500/10 text-cyan-300'
                          : 'border-slate-700 bg-slate-900 text-slate-500'
                      }`}
                    >
                      {model.pid.enabled ? 'ENABLED' : 'BYPASSED'}
                    </button>
                  </div>

                  {model.plant.p > 1 && (
                    <div className="mb-2">
                      <label
                        htmlFor="pid-target-output"
                        className="block text-[11px] text-slate-500 mb-1"
                      >
                        Feedback Output Channel
                      </label>
                      <select
                        id="pid-target-output"
                        value={model.pid.targetOutputIndex}
                        onChange={(e) =>
                          onChangeModel({
                            ...model,
                            pid: {
                              ...model.pid,
                              targetOutputIndex: Number(e.target.value),
                            },
                          })
                        }
                        className="w-full bg-[#07090E] border border-slate-800 rounded px-2 py-1 text-xs font-mono text-slate-100 focus:outline-none focus:border-cyan-400 cursor-pointer"
                      >
                        {model.plant.outputNames.map((outName, idx) => (
                          <option key={idx} value={idx}>
                            y[{idx}]: {outName}
                          </option>
                        ))}
                      </select>
                    </div>
                  )}

                  <div className="grid grid-cols-3 gap-2">
                    <div>
                      <label className="block text-[11px] text-slate-500 mb-1">Kp</label>
                      <input
                        type="number"
                        step={0.1}
                        value={model.pid.kp}
                        onChange={(e) =>
                          onChangeModel({
                            ...model,
                            pid: { ...model.pid, kp: Number(e.target.value) },
                          })
                        }
                        className="w-full bg-[#07090E] border border-slate-800 rounded px-2 py-1 text-xs font-mono tabular-nums text-slate-100 focus:outline-none focus:border-cyan-400"
                      />
                    </div>
                    <div>
                      <label className="block text-[11px] text-slate-500 mb-1">Ki</label>
                      <input
                        type="number"
                        step={0.1}
                        value={model.pid.ki}
                        onChange={(e) =>
                          onChangeModel({
                            ...model,
                            pid: { ...model.pid, ki: Number(e.target.value) },
                          })
                        }
                        className="w-full bg-[#07090E] border border-slate-800 rounded px-2 py-1 text-xs font-mono tabular-nums text-slate-100 focus:outline-none focus:border-cyan-400"
                      />
                    </div>
                    <div>
                      <label className="block text-[11px] text-slate-500 mb-1">Kd</label>
                      <input
                        type="number"
                        step={0.05}
                        value={model.pid.kd}
                        onChange={(e) =>
                          onChangeModel({
                            ...model,
                            pid: { ...model.pid, kd: Number(e.target.value) },
                          })
                        }
                        className="w-full bg-[#07090E] border border-slate-800 rounded px-2 py-1 text-xs font-mono tabular-nums text-slate-100 focus:outline-none focus:border-cyan-400"
                      />
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-2 mt-2">
                    <div>
                      <label className="block text-[11px] text-slate-500 mb-1">
                        Deriv Filter N
                      </label>
                      <input
                        type="number"
                        step={5}
                        min={1}
                        value={model.pid.nFilter}
                        onChange={(e) =>
                          onChangeModel({
                            ...model,
                            pid: { ...model.pid, nFilter: Number(e.target.value) },
                          })
                        }
                        className="w-full bg-[#07090E] border border-slate-800 rounded px-2 py-1 text-xs font-mono tabular-nums text-slate-100 focus:outline-none focus:border-cyan-400"
                      />
                    </div>
                    <div>
                      <label className="block text-[11px] text-slate-500 mb-1">
                        Anti-Windup Kb
                      </label>
                      <input
                        type="number"
                        step={0.5}
                        min={0}
                        value={model.pid.kbAntiWindup}
                        onChange={(e) =>
                          onChangeModel({
                            ...model,
                            pid: {
                              ...model.pid,
                              kbAntiWindup: Number(e.target.value),
                            },
                          })
                        }
                        className="w-full bg-[#07090E] border border-slate-800 rounded px-2 py-1 text-xs font-mono tabular-nums text-slate-100 focus:outline-none focus:border-cyan-400"
                      />
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Group 3: State-Space Matrices (A, B, C, D) */}
          <div className="border-b border-slate-800">
            <button
              type="button"
              onClick={() => setOpenGroup(openGroup === 'matrices' ? 'limits' : 'matrices')}
              className="w-full px-4 py-3 flex items-center justify-between text-left hover:bg-slate-900/60 transition-colors cursor-pointer"
            >
              <span className="text-xs font-semibold text-slate-200">
                03. State-Space Plant (A, B, C, D)
              </span>
              {openGroup === 'matrices' ? (
                <ChevronDown className="w-4 h-4 text-slate-400" />
              ) : (
                <ChevronRight className="w-4 h-4 text-slate-400" />
              )}
            </button>
            {openGroup === 'matrices' && (
              <div className="px-4 pb-4 space-y-3">
                <div className="flex items-center justify-between text-[11px] text-slate-400">
                  <span className="font-mono truncate pr-2">
                    Active:{' '}
                    <span className="text-slate-200">
                      {PLANT_TEMPLATES.find((t) => t.id === model.id)?.label ??
                        (!isBuiltinId ? model.name : resolvedBasePreset)}
                    </span>
                  </span>
                  {(model.isCustomModel || !isBuiltinId) && (
                    <button
                      type="button"
                      onClick={() => onSelectPreset(resolvedBasePreset)}
                      className="text-[11px] font-mono text-cyan-300 hover:text-cyan-200 underline underline-offset-2 cursor-pointer shrink-0"
                    >
                      Reset to Base Benchmark
                    </button>
                  )}
                </div>

                {/* Inline Transfer Function (num/den) -> State-Space Converter */}
                <div className="rounded border border-slate-800 bg-[#07090E]">
                  <button
                    type="button"
                    onClick={() => setShowTfDrawer((prev) => !prev)}
                    className="w-full px-2.5 py-2 flex items-center justify-between text-left hover:bg-slate-900/60 transition-colors cursor-pointer"
                  >
                    <span className="text-[11px] font-mono text-cyan-300">
                      Transfer Function G(s) = N(s)/D(s) → State-Space
                    </span>
                    {showTfDrawer ? (
                      <ChevronDown className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                    ) : (
                      <ChevronRight className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                    )}
                  </button>

                  {showTfDrawer &&
                    (() => {
                      const numParsed = parseCoefficientList(tfNumText);
                      const denParsed = parseCoefficientList(tfDenText);
                      const previewConv =
                        !numParsed.error && !denParsed.error
                          ? transferFunctionToStateSpace(
                              numParsed.coeffs,
                              denParsed.coeffs
                            )
                          : {
                              result: null,
                              error: numParsed.error || denParsed.error,
                            };

                      const handleReadFromPlant = () => {
                        const tf = stateSpaceToTransferFunction(
                          model.plant,
                          model.pid.targetOutputIndex,
                          0
                        );
                        setTfNumText(
                          tf.numerator
                            .map((v) =>
                              Number.isInteger(v)
                                ? String(v)
                                : Number(v.toPrecision(5)).toString()
                            )
                            .join(', ')
                        );
                        setTfDenText(
                          tf.denominator
                            .map((v) =>
                              Number.isInteger(v)
                                ? String(v)
                                : Number(v.toPrecision(5)).toString()
                            )
                            .join(', ')
                        );
                        setTfError(null);
                      };

                      const handleApplyTf = () => {
                        if (numParsed.error) {
                          setTfError(numParsed.error);
                          return;
                        }
                        if (denParsed.error) {
                          setTfError(denParsed.error);
                          return;
                        }
                        const { model: nextModel, error } =
                          applyTransferFunctionToModel(
                            model,
                            numParsed.coeffs,
                            denParsed.coeffs,
                            tfLabel.trim() || undefined
                          );
                        if (error) {
                          setTfError(error);
                          return;
                        }
                        setTfError(null);
                        onChangeModel(nextModel);
                      };

                      return (
                        <div className="px-2.5 pb-2.5 pt-2 border-t border-slate-800 space-y-2">
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-[10px] font-mono text-slate-400">
                              Descending powers of s (e.g. 1, 4, 16)
                            </span>
                            <button
                              type="button"
                              onClick={handleReadFromPlant}
                              className="px-2 py-0.5 text-[10px] font-mono border border-slate-700 bg-[#0B0E17] hover:bg-slate-800 text-slate-300 rounded cursor-pointer shrink-0"
                            >
                              Read Active SISO
                            </button>
                          </div>

                          <div className="space-y-1.5">
                            <div>
                              <label
                                htmlFor="tf-num-input"
                                className="block text-[10px] font-mono text-slate-400 mb-0.5"
                              >
                                Numerator N(s)
                              </label>
                              <input
                                id="tf-num-input"
                                type="text"
                                value={tfNumText}
                                onChange={(e) => {
                                  setTfNumText(e.target.value);
                                  setTfError(null);
                                }}
                                placeholder="e.g. 1, 3"
                                className="w-full bg-[#0B0E17] border border-slate-800 rounded px-2 py-1 text-[11px] font-mono text-slate-100 focus:outline-none focus:border-cyan-400"
                              />
                            </div>

                            <div>
                              <label
                                htmlFor="tf-den-input"
                                className="block text-[10px] font-mono text-slate-400 mb-0.5"
                              >
                                Denominator D(s)
                              </label>
                              <input
                                id="tf-den-input"
                                type="text"
                                value={tfDenText}
                                onChange={(e) => {
                                  setTfDenText(e.target.value);
                                  setTfError(null);
                                }}
                                placeholder="e.g. 1, 4, 16"
                                className="w-full bg-[#0B0E17] border border-slate-800 rounded px-2 py-1 text-[11px] font-mono text-slate-100 focus:outline-none focus:border-cyan-400"
                              />
                            </div>

                            <div>
                              <label
                                htmlFor="tf-label-input"
                                className="block text-[10px] font-mono text-slate-400 mb-0.5"
                              >
                                System Label (Optional)
                              </label>
                              <input
                                id="tf-label-input"
                                type="text"
                                value={tfLabel}
                                onChange={(e) => setTfLabel(e.target.value)}
                                placeholder="e.g. Xcos Linearized Plant"
                                className="w-full bg-[#0B0E17] border border-slate-800 rounded px-2 py-1 text-[11px] font-mono text-slate-200 focus:outline-none focus:border-cyan-400"
                              />
                            </div>
                          </div>

                          {previewConv.result ? (
                            <div className="p-2 rounded border border-slate-800 bg-[#0B0E17] space-y-1 text-[10px] font-mono tabular-nums">
                              <div className="text-slate-300 break-words">
                                G(s) = ({formatPolynomial(previewConv.result.normalizedNum)}) / (
                                {formatPolynomial(previewConv.result.normalizedDen)})
                              </div>
                              <div className="flex flex-wrap items-center justify-between gap-2 text-slate-400">
                                <span>Order n={previewConv.result.order}</span>
                                <span>
                                  DC Gain:{' '}
                                  <span className="text-cyan-300">
                                    {previewConv.result.dcGain !== null
                                      ? previewConv.result.dcGain.toFixed(4)
                                      : '∞ (Integrator)'}
                                  </span>
                                </span>
                                <span>
                                  D = {previewConv.result.D[0][0].toFixed(3)}
                                </span>
                              </div>
                            </div>
                          ) : (
                            <div className="p-2 rounded border border-rose-500/40 bg-rose-500/10 text-[10px] font-mono text-rose-300">
                              {tfError || previewConv.error}
                            </div>
                          )}

                          {tfError && previewConv.result && (
                            <div className="p-2 rounded border border-rose-500/40 bg-rose-500/10 text-[10px] font-mono text-rose-300">
                              {tfError}
                            </div>
                          )}

                          <button
                            type="button"
                            onClick={handleApplyTf}
                            disabled={!previewConv.result}
                            className="w-full py-1.5 px-2.5 text-[11px] font-mono font-medium rounded border border-cyan-500/50 bg-cyan-500/15 hover:bg-cyan-500/25 disabled:opacity-40 disabled:cursor-not-allowed text-cyan-200 transition-colors cursor-pointer"
                          >
                            Apply num/den → State-Space
                          </button>
                        </div>
                      );
                    })()}
                </div>

                <div className="grid grid-cols-3 gap-2 pb-2 border-b border-slate-800/80">
                  <div>
                    <label
                      htmlFor="plant-dim-n"
                      className="block text-[11px] text-slate-400 mb-1"
                    >
                      States (n)
                    </label>
                    <div className="flex items-center">
                      <button
                        type="button"
                        aria-label="Decrease states"
                        disabled={model.plant.n <= MIN_STATE_DIM}
                        onClick={() =>
                          onChangeModel(
                            resizePlantDimensions(
                              model,
                              model.plant.n - 1,
                              model.plant.p,
                              model.plant.m
                            )
                          )
                        }
                        className="px-1.5 py-1 bg-[#07090E] hover:bg-slate-800 disabled:opacity-35 disabled:cursor-not-allowed border border-slate-800 rounded-l text-slate-400 cursor-pointer"
                      >
                        <Minus className="w-2.5 h-2.5" />
                      </button>
                      <input
                        id="plant-dim-n"
                        type="number"
                        min={MIN_STATE_DIM}
                        max={MAX_STATE_DIM}
                        step={1}
                        value={model.plant.n}
                        onChange={(e) => {
                          const val = Number(e.target.value);
                          if (Number.isFinite(val) && val >= MIN_STATE_DIM) {
                            onChangeModel(
                              resizePlantDimensions(
                                model,
                                val,
                                model.plant.p,
                                model.plant.m
                              )
                            );
                          }
                        }}
                        className="w-full min-w-0 bg-[#07090E] border-y border-slate-800 px-1 py-1 text-xs font-mono tabular-nums text-cyan-300 text-center focus:outline-none focus:border-cyan-400"
                      />
                      <button
                        type="button"
                        aria-label="Increase states"
                        disabled={model.plant.n >= MAX_STATE_DIM}
                        onClick={() =>
                          onChangeModel(
                            resizePlantDimensions(
                              model,
                              model.plant.n + 1,
                              model.plant.p,
                              model.plant.m
                            )
                          )
                        }
                        className="px-1.5 py-1 bg-[#07090E] hover:bg-slate-800 disabled:opacity-35 disabled:cursor-not-allowed border border-slate-800 rounded-r text-slate-400 cursor-pointer"
                      >
                        <Plus className="w-2.5 h-2.5" />
                      </button>
                    </div>
                  </div>
                  <div>
                    <label
                      htmlFor="plant-dim-m"
                      className="block text-[11px] text-slate-400 mb-1"
                    >
                      Inputs (m)
                    </label>
                    <div className="flex items-center">
                      <button
                        type="button"
                        aria-label="Decrease inputs"
                        disabled={model.plant.m <= MIN_INPUT_DIM}
                        onClick={() =>
                          onChangeModel(
                            resizePlantDimensions(
                              model,
                              model.plant.n,
                              model.plant.p,
                              model.plant.m - 1
                            )
                          )
                        }
                        className="px-1.5 py-1 bg-[#07090E] hover:bg-slate-800 disabled:opacity-35 disabled:cursor-not-allowed border border-slate-800 rounded-l text-slate-400 cursor-pointer"
                      >
                        <Minus className="w-2.5 h-2.5" />
                      </button>
                      <input
                        id="plant-dim-m"
                        type="number"
                        min={MIN_INPUT_DIM}
                        max={MAX_INPUT_DIM}
                        step={1}
                        value={model.plant.m}
                        onChange={(e) => {
                          const val = Number(e.target.value);
                          if (Number.isFinite(val) && val >= MIN_INPUT_DIM) {
                            onChangeModel(
                              resizePlantDimensions(
                                model,
                                model.plant.n,
                                model.plant.p,
                                val
                              )
                            );
                          }
                        }}
                        className="w-full min-w-0 bg-[#07090E] border-y border-slate-800 px-1 py-1 text-xs font-mono tabular-nums text-amber-300 text-center focus:outline-none focus:border-cyan-400"
                      />
                      <button
                        type="button"
                        aria-label="Increase inputs"
                        disabled={model.plant.m >= MAX_INPUT_DIM}
                        onClick={() =>
                          onChangeModel(addInputChannel(model))
                        }
                        className="px-1.5 py-1 bg-[#07090E] hover:bg-slate-800 disabled:opacity-35 disabled:cursor-not-allowed border border-slate-800 rounded-r text-slate-400 cursor-pointer"
                      >
                        <Plus className="w-2.5 h-2.5" />
                      </button>
                    </div>
                  </div>
                  <div>
                    <label
                      htmlFor="plant-dim-p"
                      className="block text-[11px] text-slate-400 mb-1"
                    >
                      Outputs (p)
                    </label>
                    <div className="flex items-center">
                      <button
                        type="button"
                        aria-label="Decrease outputs"
                        disabled={model.plant.p <= MIN_OUTPUT_DIM}
                        onClick={() =>
                          onChangeModel(
                            resizePlantDimensions(
                              model,
                              model.plant.n,
                              model.plant.p - 1,
                              model.plant.m
                            )
                          )
                        }
                        className="px-1.5 py-1 bg-[#07090E] hover:bg-slate-800 disabled:opacity-35 disabled:cursor-not-allowed border border-slate-800 rounded-l text-slate-400 cursor-pointer"
                      >
                        <Minus className="w-2.5 h-2.5" />
                      </button>
                      <input
                        id="plant-dim-p"
                        type="number"
                        min={MIN_OUTPUT_DIM}
                        max={MAX_OUTPUT_DIM}
                        step={1}
                        value={model.plant.p}
                        onChange={(e) => {
                          const val = Number(e.target.value);
                          if (Number.isFinite(val) && val >= MIN_OUTPUT_DIM) {
                            onChangeModel(
                              resizePlantDimensions(
                                model,
                                model.plant.n,
                                val,
                                model.plant.m
                              )
                            );
                          }
                        }}
                        className="w-full min-w-0 bg-[#07090E] border-y border-slate-800 px-1 py-1 text-xs font-mono tabular-nums text-emerald-300 text-center focus:outline-none focus:border-cyan-400"
                      />
                      <button
                        type="button"
                        aria-label="Increase outputs"
                        disabled={model.plant.p >= MAX_OUTPUT_DIM}
                        onClick={() =>
                          onChangeModel(addOutputChannel(model))
                        }
                        className="px-1.5 py-1 bg-[#07090E] hover:bg-slate-800 disabled:opacity-35 disabled:cursor-not-allowed border border-slate-800 rounded-r text-slate-400 cursor-pointer"
                      >
                        <Plus className="w-2.5 h-2.5" />
                      </button>
                    </div>
                  </div>
                </div>

                {/* Compact Tabbed Channel Manager: Inputs (m) | Outputs (p) | States (n) */}
                <div className="space-y-2 pb-2 border-b border-slate-800/80">
                  <div className="flex items-center gap-1 p-0.5 bg-[#07090E] border border-slate-800 rounded">
                    {(
                      [
                        { id: 'inputs', label: `Inputs (${model.plant.m})` },
                        { id: 'outputs', label: `Outputs (${model.plant.p})` },
                        { id: 'states', label: `States (${model.plant.n})` },
                      ] as const
                    ).map((tab) => (
                      <button
                        key={tab.id}
                        type="button"
                        onClick={() => setChannelTab(tab.id)}
                        className={`flex-1 py-1 text-[11px] font-mono rounded transition-colors cursor-pointer ${
                          channelTab === tab.id
                            ? 'bg-slate-800 text-cyan-300'
                            : 'text-slate-400 hover:text-slate-200'
                        }`}
                      >
                        {tab.label}
                      </button>
                    ))}
                  </div>

                  {channelTab === 'inputs' && (
                    <div className="space-y-1.5">
                      <div className="flex items-center justify-between">
                        <span className="text-[11px] font-mono text-slate-400">
                          Input Channels ({model.plant.m}/{MAX_INPUT_DIM})
                        </span>
                        <button
                          type="button"
                          disabled={model.plant.m >= MAX_INPUT_DIM}
                          onClick={() => onChangeModel(addInputChannel(model))}
                          className="inline-flex items-center gap-1 px-2 py-0.5 text-[11px] font-mono bg-[#07090E] hover:bg-slate-800 disabled:opacity-40 disabled:cursor-not-allowed text-amber-300 border border-slate-700 rounded cursor-pointer"
                        >
                          <Plus className="w-3 h-3" />
                          Add Input
                        </button>
                      </div>
                      <div className="space-y-1">
                        {inputChannelNames.map((name, idx) => (
                          <div key={idx} className="space-y-1">
                            <div className="flex items-center gap-1.5">
                              <span className="text-[10px] font-mono text-amber-300 w-6 shrink-0">
                                u{idx}
                              </span>
                              <input
                                type="text"
                                aria-label={`Input channel ${idx} name`}
                                value={name}
                                onChange={(e) =>
                                  updateInputChannelMeta(idx, 'name', e.target.value)
                                }
                                className="flex-1 min-w-0 bg-[#07090E] border border-slate-800 rounded px-1.5 py-1 text-[11px] font-mono text-slate-200 focus:outline-none focus:border-cyan-400"
                              />
                              <input
                                type="text"
                                aria-label={`Input channel ${idx} unit`}
                                value={inputChannelUnits[idx] ?? 'u'}
                                onChange={(e) =>
                                  updateInputChannelMeta(idx, 'unit', e.target.value)
                                }
                                className="w-11 bg-[#07090E] border border-slate-800 rounded px-1 py-1 text-[11px] font-mono text-slate-400 text-center focus:outline-none focus:border-cyan-400"
                              />
                              {idx > 0 && (
                                <input
                                  type="number"
                                  step={0.1}
                                  title={`Steady bias excitation for u${idx}`}
                                  aria-label={`Input channel ${idx} bias`}
                                  value={model.plant.auxInputs?.[idx] ?? 0}
                                  onChange={(e) =>
                                    updateAuxInput(idx, Number(e.target.value))
                                  }
                                  className="w-14 bg-[#07090E] border border-slate-800 rounded px-1.5 py-1 text-[11px] font-mono tabular-nums text-amber-200 text-right focus:outline-none focus:border-cyan-400"
                                />
                              )}
                              <button
                                type="button"
                                aria-label={`Remove input channel ${idx}`}
                                disabled={model.plant.m <= MIN_INPUT_DIM}
                                onClick={() =>
                                  onChangeModel(removeInputChannel(model, idx))
                                }
                                className="p-1 bg-[#07090E] hover:bg-rose-950/50 disabled:opacity-35 disabled:cursor-not-allowed text-slate-400 hover:text-rose-300 border border-slate-800 rounded cursor-pointer"
                              >
                                <Minus className="w-3 h-3" />
                              </button>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {channelTab === 'outputs' && (
                    <div className="space-y-1.5">
                      <div className="flex items-center justify-between">
                        <span className="text-[11px] font-mono text-slate-400">
                          Output Channels ({model.plant.p}/{MAX_OUTPUT_DIM})
                        </span>
                        <button
                          type="button"
                          disabled={model.plant.p >= MAX_OUTPUT_DIM}
                          onClick={() => onChangeModel(addOutputChannel(model))}
                          className="inline-flex items-center gap-1 px-2 py-0.5 text-[11px] font-mono bg-[#07090E] hover:bg-slate-800 disabled:opacity-40 disabled:cursor-not-allowed text-emerald-300 border border-slate-700 rounded cursor-pointer"
                        >
                          <Plus className="w-3 h-3" />
                          Add Output
                        </button>
                      </div>
                      <div className="space-y-1">
                        {model.plant.outputNames.map((name, idx) => (
                          <div key={idx} className="flex items-center gap-1.5">
                            <span className="text-[10px] font-mono text-emerald-300 w-6 shrink-0">
                              y{idx}
                            </span>
                            <input
                              type="text"
                              aria-label={`Output channel ${idx} name`}
                              value={name}
                              onChange={(e) =>
                                updateOutputChannelMeta(idx, 'name', e.target.value)
                              }
                              className="flex-1 min-w-0 bg-[#07090E] border border-slate-800 rounded px-1.5 py-1 text-[11px] font-mono text-slate-200 focus:outline-none focus:border-cyan-400"
                            />
                            <input
                              type="text"
                              aria-label={`Output channel ${idx} unit`}
                              value={model.plant.outputUnits[idx] ?? 'u'}
                              onChange={(e) =>
                                updateOutputChannelMeta(idx, 'unit', e.target.value)
                              }
                              className="w-11 bg-[#07090E] border border-slate-800 rounded px-1 py-1 text-[11px] font-mono text-slate-400 text-center focus:outline-none focus:border-cyan-400"
                            />
                            <button
                              type="button"
                              aria-label={`Remove output channel ${idx}`}
                              disabled={model.plant.p <= MIN_OUTPUT_DIM}
                              onClick={() =>
                                onChangeModel(removeOutputChannel(model, idx))
                              }
                              className="p-1 bg-[#07090E] hover:bg-rose-950/50 disabled:opacity-35 disabled:cursor-not-allowed text-slate-400 hover:text-rose-300 border border-slate-800 rounded cursor-pointer"
                            >
                              <Minus className="w-3 h-3" />
                            </button>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {channelTab === 'states' && (
                    <div className="space-y-1.5">
                      <div className="flex items-center justify-between">
                        <span className="text-[11px] font-mono text-slate-400">
                          State Vector ({model.plant.n}/{MAX_STATE_DIM})
                        </span>
                        <button
                          type="button"
                          disabled={model.plant.n >= MAX_STATE_DIM}
                          onClick={() =>
                            onChangeModel(
                              resizePlantDimensions(
                                model,
                                model.plant.n + 1,
                                model.plant.p,
                                model.plant.m
                              )
                            )
                          }
                          className="inline-flex items-center gap-1 px-2 py-0.5 text-[11px] font-mono bg-[#07090E] hover:bg-slate-800 disabled:opacity-40 disabled:cursor-not-allowed text-cyan-300 border border-slate-700 rounded cursor-pointer"
                        >
                          <Plus className="w-3 h-3" />
                          Add State
                        </button>
                      </div>
                      <div className="space-y-1">
                        {model.plant.stateNames.map((name, idx) => (
                          <div key={idx} className="flex items-center gap-1.5">
                            <span className="text-[10px] font-mono text-cyan-300 w-6 shrink-0">
                              x{idx}
                            </span>
                            <input
                              type="text"
                              aria-label={`State ${idx} name`}
                              value={name}
                              onChange={(e) =>
                                updateStateMeta(idx, 'name', e.target.value)
                              }
                              className="flex-1 min-w-0 bg-[#07090E] border border-slate-800 rounded px-1.5 py-1 text-[11px] font-mono text-slate-200 focus:outline-none focus:border-cyan-400"
                            />
                            <input
                              type="text"
                              aria-label={`State ${idx} unit`}
                              value={model.plant.stateUnits[idx] ?? 'u'}
                              onChange={(e) =>
                                updateStateMeta(idx, 'unit', e.target.value)
                              }
                              className="w-12 bg-[#07090E] border border-slate-800 rounded px-1.5 py-1 text-[11px] font-mono text-slate-400 text-center focus:outline-none focus:border-cyan-400"
                            />
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>

                <div>
                  <div className="text-[11px] font-mono text-slate-400 mb-1">
                    Matrix A ({model.plant.n}×{model.plant.n})
                  </div>
                  <div className="overflow-x-auto pb-1">
                    <div className="space-y-1 min-w-max">
                      {model.plant.A.map((row, r) => (
                        <div key={r} className="flex items-center gap-1">
                          <span className="text-[10px] font-mono text-slate-500 w-5 shrink-0">
                            x{r}
                          </span>
                          <div
                            className="grid gap-1 flex-1"
                            style={{
                              gridTemplateColumns: `repeat(${model.plant.n}, minmax(44px, 1fr))`,
                            }}
                          >
                            {row.map((val, c) => (
                              <input
                                key={c}
                                type="number"
                                step={0.1}
                                aria-label={`A[${r},${c}]`}
                                value={val}
                                onChange={(e) =>
                                  updateMatrixA(r, c, Number(e.target.value))
                                }
                                className="w-full min-w-[44px] bg-[#07090E] border border-slate-800 rounded px-1 py-1 text-[11px] font-mono tabular-nums text-slate-100 text-right focus:outline-none focus:border-cyan-400"
                              />
                            ))}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>

                <div
                  className={
                    model.plant.m > 1 ? 'space-y-3' : 'grid grid-cols-2 gap-3'
                  }
                >
                  <div>
                    <div className="text-[11px] font-mono text-slate-400 mb-1">
                      Matrix B ({model.plant.n}×{model.plant.m})
                    </div>
                    <div className="overflow-x-auto pb-1">
                      <div className="space-y-1 min-w-max">
                        {model.plant.B.map((row, r) => (
                          <div key={r} className="flex items-center gap-1">
                            <span className="text-[10px] font-mono text-slate-500 w-5 shrink-0">
                              x{r}
                            </span>
                            <div
                              className="grid gap-1 flex-1"
                              style={{
                                gridTemplateColumns: `repeat(${model.plant.m}, minmax(44px, 1fr))`,
                              }}
                            >
                              {row.map((val, c) => (
                                <input
                                  key={c}
                                  type="number"
                                  step={0.1}
                                  aria-label={`B[${r},${c}]`}
                                  value={val}
                                  onChange={(e) =>
                                    updateMatrixB(r, c, Number(e.target.value))
                                  }
                                  className="w-full min-w-[44px] bg-[#07090E] border border-slate-800 rounded px-1 py-1 text-[11px] font-mono tabular-nums text-amber-200 text-right focus:outline-none focus:border-cyan-400"
                                />
                              ))}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                  <div>
                    <div className="text-[11px] font-mono text-slate-400 mb-1">
                      Initial State x0 ({model.plant.n})
                    </div>
                    <div
                      className={
                        model.plant.m > 1 ? 'grid grid-cols-2 gap-1' : 'space-y-1'
                      }
                    >
                      {model.plant.x0.map((val, r) => (
                        <input
                          key={r}
                          type="number"
                          step={0.02}
                          aria-label={`x0[${r}]`}
                          value={val}
                          onChange={(e) => updateX0(r, Number(e.target.value))}
                          className="w-full bg-[#07090E] border border-slate-800 rounded px-2 py-1 text-[11px] font-mono tabular-nums text-slate-100 text-right focus:outline-none focus:border-cyan-400"
                        />
                      ))}
                    </div>
                  </div>
                </div>

                <div>
                  <div className="text-[11px] font-mono text-slate-400 mb-1">
                    Output Matrix C ({model.plant.p}×{model.plant.n})
                  </div>
                  <div className="overflow-x-auto pb-1">
                    <div className="space-y-1 min-w-max">
                      {model.plant.C.map((row, r) => (
                        <div key={r} className="flex items-center gap-1">
                          <span className="text-[10px] font-mono text-emerald-400/80 w-5 shrink-0">
                            y{r}
                          </span>
                          <div
                            className="grid gap-1 flex-1"
                            style={{
                              gridTemplateColumns: `repeat(${model.plant.n}, minmax(44px, 1fr))`,
                            }}
                          >
                            {row.map((val, c) => (
                              <input
                                key={c}
                                type="number"
                                step={0.1}
                                aria-label={`C[${r},${c}]`}
                                value={val}
                                onChange={(e) =>
                                  updateMatrixC(r, c, Number(e.target.value))
                                }
                                className="w-full min-w-[44px] bg-[#07090E] border border-slate-800 rounded px-1 py-1 text-[11px] font-mono tabular-nums text-emerald-300 text-right focus:outline-none focus:border-cyan-400"
                              />
                            ))}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>

                <div>
                  <div className="text-[11px] font-mono text-slate-400 mb-1">
                    Feedthrough Matrix D ({model.plant.p}×{model.plant.m})
                  </div>
                  <div className="overflow-x-auto pb-1">
                    <div className="space-y-1 min-w-max">
                      {model.plant.D.map((row, r) => (
                        <div key={r} className="flex items-center gap-1">
                          <span className="text-[10px] font-mono text-slate-500 w-5 shrink-0">
                            y{r}
                          </span>
                          <div
                            className="grid gap-1 flex-1"
                            style={{
                              gridTemplateColumns: `repeat(${model.plant.m}, minmax(44px, 1fr))`,
                            }}
                          >
                            {row.map((val, c) => (
                              <input
                                key={c}
                                type="number"
                                step={0.1}
                                aria-label={`D[${r},${c}]`}
                                value={val}
                                onChange={(e) =>
                                  updateMatrixD(r, c, Number(e.target.value))
                                }
                                className="w-full min-w-[44px] bg-[#07090E] border border-slate-800 rounded px-1 py-1 text-[11px] font-mono tabular-nums text-slate-300 text-right focus:outline-none focus:border-cyan-400"
                              />
                            ))}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Group 4: Saturation & Rate Limits */}
          <div className="border-b border-slate-800">
            <button
              type="button"
              onClick={() => setOpenGroup(openGroup === 'limits' ? 'timing' : 'limits')}
              className="w-full px-4 py-3 flex items-center justify-between text-left hover:bg-slate-900/60 transition-colors cursor-pointer"
            >
              <span className="text-xs font-semibold text-slate-200">
                04. Saturation &amp; Rate Limiter
              </span>
              {openGroup === 'limits' ? (
                <ChevronDown className="w-4 h-4 text-slate-400" />
              ) : (
                <ChevronRight className="w-4 h-4 text-slate-400" />
              )}
            </button>
            {openGroup === 'limits' && (
              <div className="px-4 pb-4 space-y-3">
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-[11px] text-slate-400 mb-1">
                      Sat Min ({model.plant.inputUnit})
                    </label>
                    <input
                      type="number"
                      step={0.5}
                      value={model.limits.satMin}
                      onChange={(e) =>
                        onChangeModel({
                          ...model,
                          limits: { ...model.limits, satMin: Number(e.target.value) },
                        })
                      }
                      className="w-full bg-[#07090E] border border-slate-800 rounded px-2.5 py-1.5 text-xs font-mono tabular-nums text-amber-300 focus:outline-none focus:border-cyan-400"
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] text-slate-400 mb-1">
                      Sat Max ({model.plant.inputUnit})
                    </label>
                    <input
                      type="number"
                      step={0.5}
                      value={model.limits.satMax}
                      onChange={(e) =>
                        onChangeModel({
                          ...model,
                          limits: { ...model.limits, satMax: Number(e.target.value) },
                        })
                      }
                      className="w-full bg-[#07090E] border border-slate-800 rounded px-2.5 py-1.5 text-xs font-mono tabular-nums text-amber-300 focus:outline-none focus:border-cyan-400"
                    />
                  </div>
                </div>
                <div>
                  <label className="block text-[11px] text-slate-400 mb-1">
                    Rate Limit ({model.plant.inputUnit}/s)
                  </label>
                  <input
                    type="number"
                    step={10}
                    min={1}
                    value={model.limits.rateLimit}
                    onChange={(e) =>
                      onChangeModel({
                        ...model,
                        limits: {
                          ...model.limits,
                          rateLimit: Number(e.target.value),
                        },
                      })
                    }
                    className="w-full bg-[#07090E] border border-slate-800 rounded px-2.5 py-1.5 text-xs font-mono tabular-nums text-slate-100 focus:outline-none focus:border-cyan-400"
                  />
                </div>
              </div>
            )}
          </div>

          {/* Group 5: Control Unit Converter */}
          <div className="border-b border-slate-800">
            <button
              type="button"
              onClick={() =>
                setOpenGroup(openGroup === 'converter' ? 'controller' : 'converter')
              }
              className="w-full px-4 py-3 flex items-center justify-between text-left hover:bg-slate-900/60 transition-colors cursor-pointer"
            >
              <span className="text-xs font-semibold text-slate-200">
                05. Unit Converter
              </span>
              {openGroup === 'converter' ? (
                <ChevronDown className="w-4 h-4 text-slate-400" />
              ) : (
                <ChevronRight className="w-4 h-4 text-slate-400" />
              )}
            </button>
            {openGroup === 'converter' && (
              <UnitConverterPanel
                currentBaseDt={model.baseDt}
                onApplyBaseDt={(nextDt) =>
                  onChangeModel({ ...model, baseDt: nextDt })
                }
              />
            )}
          </div>
        </aside>

        {/* Main Viewport Stage */}
        <main className="flex-1 flex flex-col min-w-0 min-h-0 bg-[#07090E] overflow-y-auto">
          {/* Upper Stage: Model Diagram (Pipeline / Dynamic State-Space Topology) + Synchronized 2D / Vector Stage */}
          <div className="flex-1 grid grid-cols-1 xl:grid-cols-12 min-h-[300px]">
            <div className="xl:col-span-8 border-b xl:border-b-0 xl:border-r border-slate-800 bg-[#0B0E17] min-w-0 flex flex-col">
              <div className="flex items-center justify-between px-3 py-1.5 border-b border-slate-800/80 bg-[#0F141E]/60">
                <div
                  className="flex items-center gap-1"
                  role="tablist"
                  aria-label="Model diagram view mode"
                >
                  <button
                    type="button"
                    role="tab"
                    aria-selected={activeDiagramTab === 'topology'}
                    onClick={() => setDiagramTabOverride('topology')}
                    className={`px-2.5 py-1 text-[11px] font-medium rounded transition-colors cursor-pointer whitespace-nowrap shrink-0 ${
                      activeDiagramTab === 'topology'
                        ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/40'
                        : 'text-slate-400 hover:text-slate-200 border border-transparent'
                    }`}
                  >
                    State-Space Model GUI
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={activeDiagramTab === 'pipeline'}
                    onClick={() => setDiagramTabOverride('pipeline')}
                    className={`px-2.5 py-1 text-[11px] font-medium rounded transition-colors cursor-pointer whitespace-nowrap shrink-0 ${
                      activeDiagramTab === 'pipeline'
                        ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/40'
                        : 'text-slate-400 hover:text-slate-200 border border-transparent'
                    }`}
                  >
                    Control Pipeline
                  </button>
                </div>
                <span className="text-[11px] font-mono text-slate-400 truncate pl-2">
                  {isImportedOrCustom
                    ? 'Custom / Imported Plant Topology'
                    : 'Built-In Benchmark'}
                </span>
              </div>

              <div className="flex-1 min-h-0">
                {activeDiagramTab === 'topology' ? (
                  <StateSpaceTopologyViewer
                    model={model}
                    sample={currentSample}
                    isPlaying={isPlaying}
                    onInspectTarget={(group) => setOpenGroup(group)}
                  />
                ) : (
                  <BlockDiagram
                    model={model}
                    validation={validation}
                    selectedBlockId={selectedBlockId}
                    onSelectBlock={handleSelectBlock}
                    isPlaying={isPlaying}
                  />
                )}
              </div>
            </div>
            <div className="xl:col-span-4 bg-[#0B0E17] min-w-0">
              <PlantSchematic model={model} sample={currentSample} />
            </div>
          </div>

          {/* KPI Metric Strip (Single flat hairline bar) */}
          <div className="border-t border-slate-800 bg-[#0F141E] px-4 py-2.5 grid grid-cols-2 sm:grid-cols-5 gap-4 shrink-0">
            <div>
              <div className="text-[11px] text-slate-400">RMS Tracking Error</div>
              <div className="text-sm font-mono font-semibold tabular-nums text-slate-100">
                {trace.metrics.rmsError.toFixed(4)}{' '}
                <span className="text-[11px] text-slate-400">
                  {model.plant.outputUnits[0]}
                </span>
              </div>
            </div>
            <div>
              <div className="text-[11px] text-slate-400">Settling Time (2%)</div>
              <div className="text-sm font-mono font-semibold tabular-nums text-cyan-300">
                {trace.metrics.settlingTimeSec !== null
                  ? `${trace.metrics.settlingTimeSec.toFixed(3)} s`
                  : 'Unsettled'}
              </div>
            </div>
            <div>
              <div className="text-[11px] text-slate-400">Peak Overshoot</div>
              <div className="text-sm font-mono font-semibold tabular-nums text-slate-100">
                {trace.metrics.peakOvershootPct.toFixed(2)} %
              </div>
            </div>
            <div>
              <div className="text-[11px] text-slate-400">Peak Effort</div>
              <div className="text-sm font-mono font-semibold tabular-nums text-amber-300">
                {trace.metrics.peakEffort.toFixed(2)}{' '}
                <span className="text-[11px] text-slate-400">
                  {model.plant.inputUnit}
                </span>
              </div>
            </div>
            <div>
              <div className="text-[11px] text-slate-400">Spectral Radius ρ(Ad)</div>
              <div
                className={`text-sm font-mono font-semibold tabular-nums ${
                  trace.discrete.spectralRadius <= 1.0001
                    ? 'text-emerald-400'
                    : 'text-rose-400'
                }`}
              >
                {trace.discrete.spectralRadius.toFixed(5)}
              </div>
            </div>
          </div>

          {/* Bottom Multi-Channel Oscilloscope */}
          <Oscilloscope
            model={model}
            trace={trace}
            activeIndex={activeIndex}
            onScrubIndex={onScrubIndex}
            showStepResponse={showStepResponse}
            onToggleStepResponse={() => setShowStepResponse((v) => !v)}
          />

          {/* Performance Statistics Card */}
          {(() => {
            const currentStepIdx = currentSample?.stepIndex ?? 0;
            const totalStepIdx = Math.max(0, trace.metrics.executedSteps - 1);
            const currentFlops = currentStepIdx * trace.metrics.flopsPerIteration;
            const totalFlops = totalStepIdx * trace.metrics.flopsPerIteration;
            const perIterUs = trace.metrics.computeTimePerIterationUs;
            return (
              <section
                aria-label="Performance Statistics"
                className="border-t border-slate-800 bg-[#0B0E17] px-4 py-3 shrink-0"
              >
                <div className="rounded border border-slate-800 bg-[#0F141E] px-4 py-3">
                  <div className="flex flex-wrap items-center justify-between gap-2 pb-2 mb-2.5 border-b border-slate-800/80">
                    <div className="flex items-center gap-2">
                      <h3 className="text-xs font-semibold text-slate-200">
                        Performance Statistics
                      </h3>
                      <span className="text-slate-600" aria-hidden="true">
                        ·
                      </span>
                      <span className="text-[11px] font-mono text-slate-400">
                        {model.plant.n}×{model.plant.m}→{model.plant.p} {model.discretization.toUpperCase()} Kernel
                      </span>
                    </div>
                    <span className="text-[11px] font-mono tabular-nums text-slate-400">
                      Total Budget {totalFlops.toLocaleString()} FLOPs ({trace.metrics.executedSteps} steps)
                    </span>
                  </div>

                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                    <div>
                      <div className="text-[11px] text-slate-400">
                        Compute Time / Iteration
                      </div>
                      <div className="text-sm font-mono font-semibold tabular-nums text-cyan-300 mt-0.5">
                        {perIterUs >= 0.01 ? `${perIterUs.toFixed(2)} μs` : '< 0.01 μs'}
                      </div>
                    </div>
                    <div>
                      <div className="text-[11px] text-slate-400">
                        Current FLOPs Count
                      </div>
                      <div className="text-sm font-mono font-semibold tabular-nums text-slate-100 mt-0.5">
                        {currentFlops.toLocaleString()}{' '}
                        <span className="text-[11px] font-normal text-slate-400">
                          FLOPs
                        </span>
                      </div>
                    </div>
                    <div>
                      <div className="text-[11px] text-slate-400">
                        FLOPs / Iteration
                      </div>
                      <div className="text-sm font-mono font-semibold tabular-nums text-amber-300 mt-0.5">
                        {trace.metrics.flopsPerIteration.toLocaleString()}{' '}
                        <span className="text-[11px] font-normal text-slate-400">
                          ops/step
                        </span>
                      </div>
                    </div>
                    <div>
                      <div className="text-[11px] text-slate-400">
                        Active Iteration
                      </div>
                      <div className="text-sm font-mono font-semibold tabular-nums text-slate-200 mt-0.5">
                        #{currentStepIdx.toLocaleString()}{' '}
                        <span className="text-[11px] font-normal text-slate-500">
                          / {totalStepIdx.toLocaleString()}
                        </span>
                      </div>
                    </div>
                  </div>
                </div>
              </section>
            );
          })()}

          {/* Time-Domain Impulse Response vs Simulated Output Overlay */}
          <ImpulseOverlayPanel
            model={model}
            trace={trace}
            activeIndex={activeIndex}
            onScrubIndex={onScrubIndex}
          />

          {/* Frequency-Domain Bode Magnitude & Phase Diagrams (D3.js) */}
          <FrequencyResponsePanel model={model} />
        </main>
      </div>
    </div>
  );
};
