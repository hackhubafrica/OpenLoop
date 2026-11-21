import { describe, expect, it } from 'vitest';
import { getPlantTemplateById, PLANT_TEMPLATES } from '../plantTemplates';
import { generateEmbeddedCode } from '../../engine/codegen';
import { discretizeStateSpace } from '../../engine/math';
import { runSimulation } from '../../engine/simulator';
import { validateControlModel } from '../../engine/validator';
import { importModelFromText } from '../../utils/modelHelpers';
import { serializeModelToToml } from '../../engine/ir';
import { verifyEmbeddedBuild } from '../../../server/bridgeService';

describe('PLANT_TEMPLATES Catalog & Mass-Spring-Damper', () => {
  it('registers the 2-state Mass-Spring-Damper template cleanly and passes graph validation', () => {
    expect(PLANT_TEMPLATES.length).toBeGreaterThanOrEqual(1);
    const tpl = getPlantTemplateById('mass_spring_damper');
    expect(tpl).toBeDefined();

    const model = tpl!.model;
    expect(model.isCustomModel).toBe(true);
    expect(model.plant.n).toBe(2);
    expect(model.plant.m).toBe(1);
    expect(model.plant.p).toBe(2);
    expect(model.plant.A).toEqual([
      [0, 1],
      [-16.0, -1.2],
    ]);
    expect(model.plant.B).toEqual([[0], [1.0]]);

    const report = validateControlModel(model);
    expect(report.valid).toBe(true);
    expect(report.issues).toHaveLength(0);
  });

  it('tracks step reference cleanly and settles near target after disturbance', () => {
    const tpl = getPlantTemplateById('mass_spring_damper')!;
    const trace = runSimulation(tpl.model);

    expect(trace.samples.length).toBeGreaterThan(100);
    expect(trace.metrics.finalValue).toBeCloseTo(tpl.model.reference.finalValue, 1);
    expect(trace.metrics.rmsError).toBeLessThan(0.5);
    expect(trace.metrics.settlingTimeSec).not.toBeNull();
  });

  it('round-trips through TOML IR and compiles cleanly as C99 firmware', async () => {
    const tpl = getPlantTemplateById('mass_spring_damper')!;
    const toml = serializeModelToToml(tpl.model);
    const reimported = importModelFromText('msd.ctrl.toml', toml, tpl.model);

    expect(reimported.error).toBeNull();
    expect(reimported.model.plant.A).toEqual(tpl.model.plant.A);
    expect(reimported.model.plant.B).toEqual(tpl.model.plant.B);
    expect(reimported.model.plant.stateNames).toEqual(['x', 'x_dot']);

    const discrete = discretizeStateSpace(
      reimported.model.plant,
      reimported.model.baseDt,
      reimported.model.discretization
    );
    const bundle = generateEmbeddedCode(reimported.model, discrete);
    const verify = await verifyEmbeddedBuild({
      modelId: reimported.model.id,
      cHeader: bundle.cHeader,
      cSource: bundle.cSource,
      hilHeader: bundle.hilHeader,
      rustLib: bundle.rustLib,
    });
    expect(verify.c99.status).toBe('passed');
  });
});
