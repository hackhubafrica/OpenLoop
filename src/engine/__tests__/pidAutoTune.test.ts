import { describe, expect, it } from 'vitest';
import { getPlantTemplateById } from '../../data/plantTemplates';
import { PRESET_MODELS } from '../../data/presets';
import {
  autoTunePidGains,
  getRecommendedAutoTuneDefaults,
} from '../pidAutoTune';

describe('ESP32 PID Auto-Tuner (rise time & overshoot constraints)', () => {
  it('provides tailored defaults for ESP32 ultrasonic and gas/humidity models', () => {
    const usModel = getPlantTemplateById('esp32_ultrasonic_hold')!.model;
    const gasModel = getPlantTemplateById('esp32_gas_humidity_relay')!.model;

    const usDefaults = getRecommendedAutoTuneDefaults(usModel);
    const gasDefaults = getRecommendedAutoTuneDefaults(gasModel);

    expect(usDefaults.targetRiseTimeSec).toBeLessThan(gasDefaults.targetRiseTimeSec);
    expect(usDefaults.maxOvershootPct).toBeGreaterThan(0);
    expect(gasDefaults.maxOvershootPct).toBeGreaterThan(0);
  });

  it('synthesizes stable optimal PID gains for ESP32 Ultrasonic Distance Hold within constraints', () => {
    const usModel = getPlantTemplateById('esp32_ultrasonic_hold')!.model;

    const result = autoTunePidGains(usModel, {
      targetRiseTimeSec: 0.4,
      maxOvershootPct: 8,
      esp32Board: 'esp32dev',
    });

    expect(result.closedLoopVerdict).toBe('STABLE');
    expect(result.meetsConstraints).toBe(true);
    expect(result.recommendedPid.kp).toBeGreaterThan(0);
    expect(result.recommendedPid.ki).toBeGreaterThan(0);
    expect(result.recommendedPid.kd).toBeGreaterThanOrEqual(0);
    expect(result.recommendedPid.nFilter).toBeLessThanOrEqual(Math.round(0.95 / usModel.baseDt));
    expect(result.achievedRiseTimeSec).not.toBeNull();
    expect(result.achievedRiseTimeSec!).toBeLessThanOrEqual(0.5);
    expect(result.achievedOvershootPct!).toBeLessThanOrEqual(9);
    expect(result.iterationsEvaluated).toBeGreaterThan(20);
  });

  it('produces faster/higher-gain tuning for strict fast rise time vs relaxed slow rise time on ESP32 Gas & Humidity Relay', () => {
    const gasModel = getPlantTemplateById('esp32_gas_humidity_relay')!.model;

    const fastRes = autoTunePidGains(gasModel, {
      targetRiseTimeSec: 0.75,
      maxOvershootPct: 8,
      esp32Board: 'esp32-s3-devkitc-1',
    });
    const slowRes = autoTunePidGains(gasModel, {
      targetRiseTimeSec: 2.2,
      maxOvershootPct: 2,
      esp32Board: 'esp32-c3-devkitm-1',
    });

    expect(fastRes.closedLoopVerdict).toBe('STABLE');
    expect(slowRes.closedLoopVerdict).toBe('STABLE');
    expect(fastRes.achievedRiseTimeSec!).toBeLessThan(slowRes.achievedRiseTimeSec!);
    expect(slowRes.achievedOvershootPct!).toBeLessThanOrEqual(3);
  });

  it('synthesizes stable gains on DC Motor and regulator Inverted Pendulum presets', () => {
    const dcRes = autoTunePidGains(PRESET_MODELS.dcmotor, {
      targetRiseTimeSec: 0.14,
      maxOvershootPct: 8,
    });
    expect(dcRes.closedLoopVerdict).toBe('STABLE');
    expect(dcRes.recommendedPid.kp).toBeGreaterThan(0);
    expect(dcRes.achievedRiseTimeSec).not.toBeNull();

    const pendRes = autoTunePidGains(PRESET_MODELS.pendulum, {
      targetRiseTimeSec: 0.55,
      maxOvershootPct: 10,
    });
    expect(pendRes.closedLoopVerdict).toBe('STABLE');
    expect(Number.isFinite(pendRes.recommendedPid.kp)).toBe(true);
  });
});
