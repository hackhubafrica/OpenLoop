import { useEffect, useMemo, useState } from 'react';
import { PRESET_MODELS } from './data/presets';
import { getPlantTemplateById } from './data/plantTemplates';
import { runSimulation } from './engine/simulator';
import { validateControlModel } from './engine/validator';
import { ControlModel, PresetId } from './types/control';
import {
  exportPresetZip,
  exportProjectBundle,
  saveModelAsJson,
} from './utils/exportBundle';
import { importModelFromText } from './utils/modelHelpers';
import { Header, AppView } from './components/Header';
import { WorkbenchView } from './components/WorkbenchView';
import { SchemaView } from './components/SchemaView';
import { CodegenView } from './components/CodegenView';
import { HilBridgeView } from './components/HilBridgeView';
import { ArchitectureView } from './components/ArchitectureView';

export default function App() {
  const [activeView, setActiveView] = useState<AppView>('workbench');
  const [model, setModel] = useState<ControlModel>(() =>
    structuredClone(PRESET_MODELS.pendulum)
  );
  const [activeIndex, setActiveIndex] = useState<number>(0);
  const [isPlaying, setIsPlaying] = useState<boolean>(true);

  const validation = useMemo(() => validateControlModel(model), [model]);
  const trace = useMemo(() => runSimulation(model), [model]);

  // Keep activeIndex bounded if trace sample count changes
  useEffect(() => {
    setActiveIndex((prev) =>
      Math.min(prev, Math.max(0, trace.samples.length - 1))
    );
  }, [trace.samples.length]);

  // Deterministic playback loop synchronized with oscilloscope & 2D plant schematic
  useEffect(() => {
    if (!isPlaying || activeView !== 'workbench' || trace.samples.length === 0) {
      return;
    }
    const interval = window.setInterval(() => {
      setActiveIndex((prev) => {
        const next = prev + 2;
        if (next >= trace.samples.length) {
          return 0;
        }
        return next;
      });
    }, 32);
    return () => window.clearInterval(interval);
  }, [isPlaying, activeView, trace.samples.length]);

  const handleSelectPreset = (id: PresetId) => {
    setModel(structuredClone(PRESET_MODELS[id]));
    setActiveIndex(0);
    setIsPlaying(true);
  };

  const handleSelectTemplate = (templateId: string) => {
    const tpl = getPlantTemplateById(templateId);
    if (!tpl) return;
    setModel(structuredClone(tpl.model));
    setActiveIndex(0);
    setIsPlaying(true);
  };

  const handleInjectImpulse = () => {
    const defaultMag =
      model.id === 'pendulum'
        ? 8.5
        : model.id === 'dcmotor'
        ? -10.0
        : model.id === 'mass_spring_damper'
        ? -12.0
        : -0.3;
    const nextDistMag =
      Math.abs(model.reference.disturbanceMagnitude) > 1e-6
        ? model.reference.disturbanceMagnitude * 1.15
        : defaultMag;
    setModel((prev) => ({
      ...prev,
      reference: {
        ...prev.reference,
        disturbanceMagnitude: Number(nextDistMag.toFixed(2)),
      },
    }));
    // Jump playback slightly before disturbance so recovery is immediately visible
    const distIdx = trace.samples.findIndex(
      (s) => s.t >= model.reference.disturbanceTime * 0.9
    );
    if (distIdx >= 0) setActiveIndex(distIdx);
    setIsPlaying(true);
  };

  const handleResetPlayback = () => {
    const activeTpl = getPlantTemplateById(model.id);
    if (activeTpl) {
      setModel(structuredClone(activeTpl.model));
      setActiveIndex(0);
      setIsPlaying(true);
      return;
    }
    const presetKey: PresetId =
      model.basePreset ??
      (model.id === 'pendulum' || model.id === 'dcmotor' || model.id === 'buck'
        ? model.id
        : 'pendulum');
    setModel(structuredClone(PRESET_MODELS[presetKey]));
    setActiveIndex(0);
    setIsPlaying(true);
  };

  const handleImportModel = (
    filename: string,
    rawText: string
  ): { error: string | null; format: 'json' | 'toml' } => {
    const result = importModelFromText(filename, rawText, model);
    if (!result.error) {
      setModel(result.model);
      setActiveIndex(0);
      setIsPlaying(true);
    }
    return { error: result.error, format: result.format };
  };

  const handleExportBundle = () => {
    exportProjectBundle(model, trace.discrete);
  };

  const handleSaveModel = () => {
    saveModelAsJson(model);
  };

  const handleDownloadPresetZip = () => {
    exportPresetZip(model, trace.discrete);
  };

  return (
    <div className="min-h-screen lg:h-screen flex flex-col bg-[#07090E] text-slate-100 lg:overflow-hidden">
      <Header
        activeView={activeView}
        onSelectView={setActiveView}
        onExportBundle={handleExportBundle}
      />

      {activeView === 'workbench' && (
        <WorkbenchView
          model={model}
          trace={trace}
          validation={validation}
          activeIndex={activeIndex}
          isPlaying={isPlaying}
          onTogglePlay={() => setIsPlaying((p) => !p)}
          onResetPlayback={handleResetPlayback}
          onScrubIndex={(idx) => {
            setIsPlaying(false);
            setActiveIndex(idx);
          }}
          onSelectPreset={handleSelectPreset}
          onSelectTemplate={handleSelectTemplate}
          onChangeModel={setModel}
          onInjectImpulse={handleInjectImpulse}
          onSaveModel={handleSaveModel}
          onImportModel={handleImportModel}
          onDownloadPresetZip={handleDownloadPresetZip}
        />
      )}

      {activeView === 'schema' && (
        <SchemaView
          model={model}
          validation={validation}
          onChangeModel={setModel}
          onSaveModel={handleSaveModel}
          onImportModel={handleImportModel}
        />
      )}

      {activeView === 'codegen' && (
        <CodegenView
          model={model}
          discrete={trace.discrete}
          onChangeModel={setModel}
          onDownloadPresetZip={handleDownloadPresetZip}
        />
      )}

      {activeView === 'hil' && (
        <HilBridgeView
          model={model}
          trace={trace}
          onChangeModel={setModel}
        />
      )}

      {activeView === 'architecture' && (
        <ArchitectureView onNavigate={setActiveView} />
      )}
    </div>
  );
}
