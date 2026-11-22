import { describe, expect, it } from 'vitest';
import { getPlantTemplateById } from '../../data/plantTemplates';
import { PRESET_MODELS } from '../../data/presets';
import { discretizeStateSpace } from '../math';
import { runSimulation } from '../simulator';
import { validateControlModel } from '../validator';
import {
  DEFAULT_ESP32_PIN_PROFILE,
  ESP32_BOARD_SPECS,
  generateEsp32PlatformIoBundle,
  getDefaultEsp32PinProfile,
  validateEsp32PinProfile,
} from '../esp32Codegen';
import { buildEsp32PlatformIoZipEntries } from '../../utils/exportBundle';
import { getModelSensitivityParameters } from '../stability';

describe('ESP32 Plant Templates & PlatformIO Firmware Codegen', () => {
  it('simulates and validates ESP32 Ultrasonic Distance Hold and Gas/Humidity templates cleanly', () => {
    const usTpl = getPlantTemplateById('esp32_ultrasonic_hold');
    const gasTpl = getPlantTemplateById('esp32_gas_humidity_relay');
    expect(usTpl).toBeDefined();
    expect(gasTpl).toBeDefined();

    const usValidation = validateControlModel(usTpl!.model);
    const gasValidation = validateControlModel(gasTpl!.model);
    expect(usValidation.valid).toBe(true);
    expect(gasValidation.valid).toBe(true);

    const usTrace = runSimulation(usTpl!.model);
    expect(usTrace.samples.length).toBeGreaterThan(100);
    expect(usTrace.metrics.finalValue).toBeCloseTo(
      usTpl!.model.reference.finalValue,
      1
    );

    const gasTrace = runSimulation(gasTpl!.model);
    expect(gasTrace.samples.length).toBeGreaterThan(100);
    expect(gasTrace.metrics.finalValue).toBeCloseTo(
      gasTpl!.model.reference.finalValue,
      -1
    );

    // Sensitivity parameters extracted cleanly
    expect(getModelSensitivityParameters(usTpl!.model)[0].id).toBe('us_damping');
    expect(getModelSensitivityParameters(gasTpl!.model)[0].id).toBe('gas_decay');
  });

  it('validates ESP32 GPIO pin conflicts, SPI flash pins, input-only constraints, and ADC2 warnings', () => {
    expect(validateEsp32PinProfile(DEFAULT_ESP32_PIN_PROFILE)).toHaveLength(0);

    const faulty = validateEsp32PinProfile({
      ...DEFAULT_ESP32_PIN_PROFILE,
      trigPin: 34, // input-only error
      echoPin: 6, // SPI flash error
      gasAdcPin: 25, // ADC2 warning + duplicate with pwmLedPin
    });

    expect(faulty.some((i) => i.severity === 'error' && i.field === 'trigPin')).toBe(
      true
    );
    expect(faulty.some((i) => i.severity === 'error' && i.field === 'echoPin')).toBe(
      true
    );
    expect(faulty.some((i) => i.severity === 'warning' && i.field === 'gasAdcPin')).toBe(
      true
    );
    expect(faulty.some((i) => i.message.includes('conflict'))).toBe(true);
  });

  it('validates chip-specific safe defaults and constraints across ESP32, ESP32-S3, and ESP32-C3 models', () => {
    const s3Profile = getDefaultEsp32PinProfile('esp32-s3-devkitc-1');
    const c3Profile = getDefaultEsp32PinProfile('esp32-c3-devkitm-1');
    expect(validateEsp32PinProfile(s3Profile)).toHaveLength(0);
    expect(validateEsp32PinProfile(c3Profile)).toHaveLength(0);

    const s3FlashFault = validateEsp32PinProfile({
      ...s3Profile,
      trigPin: 35, // S3 SPI flash/PSRAM conflict
    });
    expect(
      s3FlashFault.some(
        (i) => i.severity === 'error' && i.field === 'trigPin' && i.message.includes('SPI flash')
      )
    ).toBe(true);

    const c3RangeFault = validateEsp32PinProfile({
      ...c3Profile,
      echoPin: 25, // Outside C3 GPIO 0..21
    });
    expect(
      c3RangeFault.some(
        (i) =>
          i.severity === 'error' &&
          i.field === 'echoPin' &&
          i.message.includes(`0..${ESP32_BOARD_SPECS['esp32-c3-devkitm-1'].maxGpio}`)
      )
    ).toBe(true);
  });

  it('tailors platformio.ini and src/main.cpp to the selected ESP32 board and control model', () => {
    const usModel = getPlantTemplateById('esp32_ultrasonic_hold')!.model;
    const usDiscrete = discretizeStateSpace(
      usModel.plant,
      usModel.baseDt,
      usModel.discretization
    );

    const s3Profile = getDefaultEsp32PinProfile('esp32-s3-devkitc-1');
    const s3Pio = generateEsp32PlatformIoBundle(usModel, usDiscrete, s3Profile);
    expect(s3Pio.platformioIni).toContain('[env:esp32-s3-devkitc-1]');
    expect(s3Pio.platformioIni).toContain('board = esp32-s3-devkitc-1');
    expect(s3Pio.platformioIni).toContain('platform = espressif32@^6.9.0');
    expect(s3Pio.platformioIni).toContain('framework = arduino');
    expect(s3Pio.platformioIni).toContain('-DARDUINO_USB_MODE=1');
    expect(s3Pio.platformioIni).toContain('-DARDUINO_USB_CDC_ON_BOOT=1');
    expect(s3Pio.platformioIni).toContain('adafruit/DHT sensor library@^1.4.6');
    expect(s3Pio.mainCpp).toContain(`#define PIN_US_TRIG         (${s3Profile.trigPin})`);
    expect(s3Pio.mainCpp).toContain('331.3f + (0.606f * temp_c) + (0.0124f * rh_pct)');

    // Standard non-sensor control model (DC Motor) omits DHT deps and runs ctrl_plant_step twin
    const dcMotor = PRESET_MODELS.dcmotor;
    const dcDiscrete = discretizeStateSpace(
      dcMotor.plant,
      dcMotor.baseDt,
      dcMotor.discretization
    );
    const c3Profile = getDefaultEsp32PinProfile('esp32-c3-devkitm-1');
    const c3Pio = generateEsp32PlatformIoBundle(dcMotor, dcDiscrete, c3Profile);

    expect(c3Pio.platformioIni).toContain('[env:esp32-c3-devkitm-1]');
    expect(c3Pio.platformioIni).toContain('-DARDUINO_USB_CDC_ON_BOOT=1');
    expect(c3Pio.platformioIni).not.toContain('adafruit/DHT sensor library');
    expect(c3Pio.mainCpp).toContain('ctrl_step(&g_ctrl, &ctrl_in, &ctrl_out)');
    expect(c3Pio.mainCpp).toContain('ctrl_plant_step(&g_ctrl, ctrl_out.u_cmd)');
    expect(c3Pio.mainCpp).not.toContain('#include <DHT.h>');
  });

  it('generates PlatformIO manifest, C++ HAL wrapper around ctrl_model.c, and ZIP workspace entries', () => {
    const usModel = getPlantTemplateById('esp32_ultrasonic_hold')!.model;
    const discrete = discretizeStateSpace(
      usModel.plant,
      usModel.baseDt,
      usModel.discretization
    );

    const pio = generateEsp32PlatformIoBundle(
      usModel,
      discrete,
      DEFAULT_ESP32_PIN_PROFILE
    );

    expect(pio.platformioIni).toContain('platform = espressif32');
    expect(pio.platformioIni).toContain('framework = arduino');
    expect(pio.platformioIni).toContain('monitor_speed = 921600');
    expect(pio.mainCpp).toContain('extern "C" {');
    expect(pio.mainCpp).toContain('#include "ctrl_model.h"');
    expect(pio.mainCpp).toContain('#include "hil_frame.h"');
    expect(pio.mainCpp).toContain('ctrl_step(&g_ctrl, &ctrl_in, &ctrl_out)');
    expect(pio.mainCpp).toContain('331.3f + (0.606f * temp_c) + (0.0124f * rh_pct)');
    expect(pio.mainCpp).toContain('hil_cobs_encode(');
    expect(pio.wiringRows).toHaveLength(7);

    const zipEntries = buildEsp32PlatformIoZipEntries(usModel, discrete);
    const names = zipEntries.map((e) => e.name);
    expect(names).toEqual([
      'openloop-esp32_ultrasonic_hold-esp32-pio/platformio.ini',
      'openloop-esp32_ultrasonic_hold-esp32-pio/include/ctrl_model.h',
      'openloop-esp32_ultrasonic_hold-esp32-pio/include/hil_frame.h',
      'openloop-esp32_ultrasonic_hold-esp32-pio/src/ctrl_model.c',
      'openloop-esp32_ultrasonic_hold-esp32-pio/src/main.cpp',
      'openloop-esp32_ultrasonic_hold-esp32-pio/model.ctrl.toml',
      'openloop-esp32_ultrasonic_hold-esp32-pio/WIRING.md',
    ]);
  });

  it('dynamically tailors platformio.ini, src/main.cpp, wiringRows, and pin checks to selected sensors', () => {
    const usModel = getPlantTemplateById('esp32_ultrasonic_hold')!.model;
    const discrete = discretizeStateSpace(
      usModel.plant,
      usModel.baseDt,
      usModel.discretization
    );

    // 1. Ultrasonic + Humidity only (Gas bypassed)
    const usHumOnly = generateEsp32PlatformIoBundle(usModel, discrete, {
      ...DEFAULT_ESP32_PIN_PROFILE,
      gasAdcPin: 6, // normally SPI flash conflict, ignored when gas is disabled
      sensors: { ultrasonic: true, gas: false, humidity: true },
    });
    expect(usHumOnly.issues).toHaveLength(0);
    expect(usHumOnly.platformioIni).toContain('adafruit/DHT sensor library@^1.4.6');
    expect(usHumOnly.platformioIni).toContain('-DOPENLOOP_HAS_ULTRASONIC=1');
    expect(usHumOnly.platformioIni).toContain('-DOPENLOOP_HAS_GAS=0');
    expect(usHumOnly.platformioIni).toContain('-DOPENLOOP_HAS_HUMIDITY=1');
    expect(usHumOnly.mainCpp).toContain('#define PIN_US_TRIG');
    expect(usHumOnly.mainCpp).toContain('#include <DHT.h>');
    expect(usHumOnly.mainCpp).not.toContain('#define PIN_GAS_ADC');
    expect(usHumOnly.wiringRows).toHaveLength(6); // TRIG, ECHO, DHT22 + 3 actuators

    // 2. Gas only (Ultrasonic & Humidity bypassed)
    const gasOnly = generateEsp32PlatformIoBundle(usModel, discrete, {
      ...DEFAULT_ESP32_PIN_PROFILE,
      sensors: { ultrasonic: false, gas: true, humidity: false },
    });
    expect(gasOnly.platformioIni).not.toContain('adafruit/DHT sensor library');
    expect(gasOnly.mainCpp).not.toContain('#include <DHT.h>');
    expect(gasOnly.mainCpp).not.toContain('#define PIN_US_TRIG');
    expect(gasOnly.mainCpp).toContain('#define PIN_GAS_ADC');
    expect(gasOnly.wiringRows).toHaveLength(4); // MQ Gas + 3 actuators
  });
});


