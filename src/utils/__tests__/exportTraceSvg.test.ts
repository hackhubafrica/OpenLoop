import { describe, expect, it } from 'vitest';
import { PRESET_MODELS } from '../../data/presets';
import { runSimulation } from '../../engine/simulator';
import { generateTraceSvgString } from '../exportTraceSvg';

describe('generateTraceSvgString', () => {
  it('generates valid standalone vector SVG markup for simulation output traces in publication and dark palettes', () => {
    const model = structuredClone(PRESET_MODELS.dcmotor);
    model.name = 'DC Motor <Test & Validation>';
    const trace = runSimulation(model);

    const pubSvg = generateTraceSvgString(model, trace, {
      channel: 0,
      showMil: true,
      showSil: true,
      theme: 'publication',
    });

    expect(pubSvg.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(pubSvg).toContain('<svg xmlns="http://www.w3.org/2000/svg"');
    expect(pubSvg).toContain('viewBox="0 0 960 420"');
    expect(pubSvg).toContain('#FFFFFF');
    // Safely escapes XML special chars
    expect(pubSvg).toContain('DC Motor &lt;Test &amp; Validation&gt;');
    expect(pubSvg).toContain('MIL (RK4)');
    expect(pubSvg).toContain('SIL (ZOH)');
    expect(pubSvg).toContain('Reference');
    expect(pubSvg).toContain('<path d="M ');
    expect(pubSvg).toContain('RMS Error:');

    const darkSvg = generateTraceSvgString(model, trace, {
      channel: 'effort',
      showMil: true,
      showSil: false,
      theme: 'dark',
    });

    expect(darkSvg).toContain('#07090E');
    expect(darkSvg).toContain('Actuator Effort');
    expect(darkSvg).toContain('u_raw');
    expect(darkSvg).not.toContain('u_sat');
  });
});
