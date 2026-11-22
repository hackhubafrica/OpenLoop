import { ControlModel, DiscretizedMatrices } from '../types/control';

export type Esp32BoardEnv =
  | 'esp32dev'
  | 'esp32-s3-devkitc-1'
  | 'esp32-c3-devkitm-1';

export interface Esp32SensorSelection {
  ultrasonic: boolean;
  gas: boolean;
  humidity: boolean;
}

export interface Esp32BoardSpec {
  id: Esp32BoardEnv;
  label: string;
  mcuSummary: string;
  maxGpio: number;
  adc1Pins: number[];
  flashPins: number[];
  strappingPins: number[];
  inputOnlyPins: number[];
  extraBuildFlags: string[];
  defaultPins: Omit<Esp32PinProfile, 'boardEnv' | 'relayThreshold' | 'baudRate' | 'sensors'>;
}

export interface Esp32PinProfile {
  boardEnv: Esp32BoardEnv;
  trigPin: number;
  echoPin: number;
  gasAdcPin: number;
  humidityPin: number;
  pwmLedPin: number;
  buzzerPin: number;
  relayPin: number;
  relayThreshold: number;
  baudRate: number;
  sensors?: Esp32SensorSelection;
}

export const ESP32_BOARD_SPECS: Record<Esp32BoardEnv, Esp32BoardSpec> = {
  esp32dev: {
    id: 'esp32dev',
    label: 'ESP32-WROOM-32 (esp32dev)',
    mcuSummary: 'Xtensa LX6 Dual-Core 240 MHz · ADC1 GPIO32–39 · GPIO0–39',
    maxGpio: 39,
    adc1Pins: [32, 33, 34, 35, 36, 39],
    flashPins: [6, 7, 8, 9, 10, 11],
    strappingPins: [0, 2, 12, 15],
    inputOnlyPins: [34, 35, 36, 39],
    extraBuildFlags: [],
    defaultPins: {
      trigPin: 5,
      echoPin: 18,
      gasAdcPin: 34,
      humidityPin: 4,
      pwmLedPin: 25,
      buzzerPin: 26,
      relayPin: 27,
    },
  },
  'esp32-s3-devkitc-1': {
    id: 'esp32-s3-devkitc-1',
    label: 'ESP32-S3-DevKitC-1 (N8/N16R8)',
    mcuSummary: 'Xtensa LX7 Dual-Core 240 MHz · ADC1 GPIO1–10 · Native USB',
    maxGpio: 48,
    adc1Pins: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
    flashPins: [26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37],
    strappingPins: [0, 3, 45, 46],
    inputOnlyPins: [],
    extraBuildFlags: ['-DARDUINO_USB_MODE=1', '-DARDUINO_USB_CDC_ON_BOOT=1'],
    defaultPins: {
      trigPin: 11,
      echoPin: 12,
      gasAdcPin: 4,
      humidityPin: 5,
      pwmLedPin: 13,
      buzzerPin: 14,
      relayPin: 15,
    },
  },
  'esp32-c3-devkitm-1': {
    id: 'esp32-c3-devkitm-1',
    label: 'ESP32-C3-DevKitM-1 (RISC-V)',
    mcuSummary: 'RISC-V Single-Core 160 MHz · ADC1 GPIO0–4 · GPIO0–21',
    maxGpio: 21,
    adc1Pins: [0, 1, 2, 3, 4],
    flashPins: [11, 12, 13, 14, 15, 16, 17],
    strappingPins: [2, 8, 9],
    inputOnlyPins: [],
    extraBuildFlags: ['-DARDUINO_USB_MODE=1', '-DARDUINO_USB_CDC_ON_BOOT=1'],
    defaultPins: {
      trigPin: 5,
      echoPin: 6,
      gasAdcPin: 0,
      humidityPin: 4,
      pwmLedPin: 7,
      buzzerPin: 10,
      relayPin: 3,
    },
  },
};

export function resolveEsp32Sensors(
  modelId: string,
  profile?: Partial<Esp32PinProfile>
): Esp32SensorSelection {
  if (profile?.sensors) {
    return {
      ultrasonic: Boolean(profile.sensors.ultrasonic),
      gas: Boolean(profile.sensors.gas),
      humidity: Boolean(profile.sensors.humidity),
    };
  }
  if (modelId === 'esp32_ultrasonic_hold') {
    return { ultrasonic: true, gas: true, humidity: true };
  }
  if (modelId === 'esp32_gas_humidity_relay') {
    return { ultrasonic: false, gas: true, humidity: true };
  }
  return { ultrasonic: false, gas: false, humidity: false };
}

export function getDefaultEsp32PinProfile(
  boardEnv: Esp32BoardEnv = 'esp32dev',
  sensors?: Esp32SensorSelection
): Esp32PinProfile {
  const spec = ESP32_BOARD_SPECS[boardEnv] ?? ESP32_BOARD_SPECS.esp32dev;
  return {
    boardEnv: spec.id,
    ...spec.defaultPins,
    relayThreshold: 25.0,
    baudRate: 921600,
    ...(sensors ? { sensors: { ...sensors } } : {}),
  };
}

export const DEFAULT_ESP32_PIN_PROFILE: Esp32PinProfile =
  getDefaultEsp32PinProfile('esp32dev');

export interface Esp32PinIssue {
  severity: 'error' | 'warning';
  field: keyof Esp32PinProfile;
  message: string;
}

export interface Esp32WiringRow {
  peripheral: string;
  sensorGroup: 'ultrasonic' | 'gas' | 'humidity' | 'actuator';
  signal: string;
  gpio: number;
  direction: string;
  protectionNote: string;
  warningLevel: 'safe' | 'divider';
}

export interface Esp32PlatformIoBundle {
  platformioIni: string;
  mainCpp: string;
  wiringMarkdown: string;
  wiringRows: Esp32WiringRow[];
  issues: Esp32PinIssue[];
  boardSpec: Esp32BoardSpec;
  activeSensors: Esp32SensorSelection;
}

export function validateEsp32PinProfile(
  profile: Esp32PinProfile,
  activeSensors?: Esp32SensorSelection
): Esp32PinIssue[] {
  const spec = ESP32_BOARD_SPECS[profile.boardEnv] ?? ESP32_BOARD_SPECS.esp32dev;
  const sensors = activeSensors ?? profile.sensors ?? { ultrasonic: true, gas: true, humidity: true };
  const flashSet = new Set(spec.flashPins);
  const strappingSet = new Set(spec.strappingPins);
  const inputOnlySet = new Set(spec.inputOnlyPins);
  const adc1Set = new Set(spec.adc1Pins);

  const issues: Esp32PinIssue[] = [];

  const pinFields: {
    key: keyof Esp32PinProfile;
    label: string;
    needsOutput: boolean;
    enabled: boolean;
  }[] = [
    { key: 'trigPin', label: 'HC-SR04 TRIG', needsOutput: true, enabled: sensors.ultrasonic },
    { key: 'echoPin', label: 'HC-SR04 ECHO', needsOutput: false, enabled: sensors.ultrasonic },
    { key: 'gasAdcPin', label: 'MQ Gas ADC1', needsOutput: false, enabled: sensors.gas },
    { key: 'humidityPin', label: 'DHT22 Humidity Data', needsOutput: true, enabled: sensors.humidity },
    { key: 'pwmLedPin', label: 'PWM Actuator / LED', needsOutput: true, enabled: true },
    { key: 'buzzerPin', label: 'Buzzer Tone Out', needsOutput: true, enabled: true },
    { key: 'relayPin', label: 'Relay Trigger Out', needsOutput: true, enabled: true },
  ];

  const seen = new Map<number, string>();

  for (const item of pinFields) {
    if (!item.enabled) continue;
    const pin = Number(profile[item.key]);
    if (!Number.isInteger(pin) || pin < 0 || pin > spec.maxGpio) {
      issues.push({
        severity: 'error',
        field: item.key,
        message: `${item.label} GPIO ${pin} is outside valid ${spec.id} range (0..${spec.maxGpio}).`,
      });
      continue;
    }

    if (flashSet.has(pin)) {
      issues.push({
        severity: 'error',
        field: item.key,
        message: `${item.label} on GPIO ${pin} conflicts with internal SPI flash/PSRAM on ${spec.id}.`,
      });
    }

    if (strappingSet.has(pin)) {
      issues.push({
        severity: 'warning',
        field: item.key,
        message: `${item.label} uses boot-strapping GPIO ${pin} on ${spec.id}; external pull-ups/downs may affect flashing.`,
      });
    }

    if (item.needsOutput && inputOnlySet.has(pin)) {
      issues.push({
        severity: 'error',
        field: item.key,
        message: `${item.label} requires output/bidirectional drive, but GPIO ${pin} is input-only on ${spec.id}.`,
      });
    }

    if (item.key === 'gasAdcPin' && !adc1Set.has(pin)) {
      issues.push({
        severity: 'warning',
        field: item.key,
        message: `Analog input on GPIO ${pin} is outside ADC1 (${spec.adc1Pins.join(', ')}) on ${spec.id}; ADC2 conflicts with Wi-Fi.`,
      });
    }

    const prevOwner = seen.get(pin);
    if (prevOwner) {
      issues.push({
        severity: 'error',
        field: item.key,
        message: `GPIO ${pin} conflict: assigned to both ${prevOwner} and ${item.label}.`,
      });
    } else {
      seen.set(pin, item.label);
    }
  }

  return issues;
}

export function buildEsp32WiringRows(
  profile: Esp32PinProfile,
  sensors?: Esp32SensorSelection
): Esp32WiringRow[] {
  const active = sensors ?? profile.sensors ?? { ultrasonic: true, gas: true, humidity: true };
  const rows: Esp32WiringRow[] = [];

  if (active.ultrasonic) {
    rows.push(
      {
        peripheral: 'HC-SR04 Ultrasonic',
        sensorGroup: 'ultrasonic',
        signal: 'TRIG',
        gpio: profile.trigPin,
        direction: '3.3V Output',
        protectionNote: 'Direct ESP32 GPIO connection; 3.3V HIGH reliably triggers 5V HC-SR04.',
        warningLevel: 'safe',
      },
      {
        peripheral: 'HC-SR04 Ultrasonic',
        sensorGroup: 'ultrasonic',
        signal: 'ECHO',
        gpio: profile.echoPin,
        direction: 'Input (5V → 3.3V)',
        protectionNote: 'REQUIRED: 1 kΩ series + 2 kΩ pull-down voltage divider (5V → 3.33V max).',
        warningLevel: 'divider',
      }
    );
  }

  if (active.gas) {
    rows.push({
      peripheral: 'MQ-x Gas Sensor',
      sensorGroup: 'gas',
      signal: 'AO (ADC1)',
      gpio: profile.gasAdcPin,
      direction: 'ADC1 Input (≤3.3V)',
      protectionNote: 'REQUIRED if module runs at 5V: 1 kΩ / 2 kΩ divider before ADC1 pin.',
      warningLevel: 'divider',
    });
  }

  if (active.humidity) {
    rows.push({
      peripheral: 'DHT22 / DHT11',
      sensorGroup: 'humidity',
      signal: 'DATA',
      gpio: profile.humidityPin,
      direction: '3.3V Open-Drain',
      protectionNote: 'Power from 3.3V rail with 10 kΩ pull-up resistor to 3.3V.',
      warningLevel: 'safe',
    });
  }

  rows.push(
    {
      peripheral: 'Actuator / Status LED',
      sensorGroup: 'actuator',
      signal: 'PWM (LEDC)',
      gpio: profile.pwmLedPin,
      direction: 'LEDC PWM Out',
      protectionNote: '220 Ω–330 Ω resistor to LED, or gate resistor to MOSFET/driver input.',
      warningLevel: 'safe',
    },
    {
      peripheral: 'Passive Buzzer',
      sensorGroup: 'actuator',
      signal: 'SIG (Tone)',
      gpio: profile.buzzerPin,
      direction: 'LEDC Tone Out',
      protectionNote: 'Series 100 Ω resistor (or NPN transistor if >20 mA coil).',
      warningLevel: 'safe',
    },
    {
      peripheral: 'Relay Module',
      sensorGroup: 'actuator',
      signal: 'IN (Control)',
      gpio: profile.relayPin,
      direction: 'Digital Output',
      protectionNote: 'Opto-isolated 3.3V logic module recommended; power coil from 5V VIN.',
      warningLevel: 'safe',
    }
  );

  return rows;
}

export function generateEsp32PlatformIoBundle(
  model: ControlModel,
  discrete: DiscretizedMatrices,
  profile: Esp32PinProfile = DEFAULT_ESP32_PIN_PROFILE
): Esp32PlatformIoBundle {
  const boardSpec =
    ESP32_BOARD_SPECS[profile.boardEnv] ?? ESP32_BOARD_SPECS.esp32dev;
  const activeSensors = resolveEsp32Sensors(model.id, profile);
  const issues = validateEsp32PinProfile(profile, activeSensors);
  const wiringRows = buildEsp32WiringRows(profile, activeSensors);
  const dtUs = Math.max(200, Math.round(model.baseDt * 1e6));
  const defaultRef = Number.isFinite(model.reference.finalValue)
    ? model.reference.finalValue.toPrecision(4)
    : '1.0';

  const activeSensorLabels: string[] = [];
  if (activeSensors.ultrasonic) activeSensorLabels.push('Ultrasonic (HC-SR04)');
  if (activeSensors.gas) activeSensorLabels.push('Gas (MQ-x ADC1)');
  if (activeSensors.humidity) activeSensorLabels.push('Humidity (DHT22)');

  const buildFlags = [
    '-Iinclude',
    '-Wall',
    '-Wextra',
    '-DCTRL_USE_ESP32_HAL=1',
    `-DOPENLOOP_HAS_ULTRASONIC=${activeSensors.ultrasonic ? 1 : 0}`,
    `-DOPENLOOP_HAS_GAS=${activeSensors.gas ? 1 : 0}`,
    `-DOPENLOOP_HAS_HUMIDITY=${activeSensors.humidity ? 1 : 0}`,
    ...boardSpec.extraBuildFlags,
  ];

  const libDepsSection = activeSensors.humidity
    ? `lib_deps =
  adafruit/DHT sensor library@^1.4.6
  adafruit/Adafruit Unified Sensor@^1.1.14
`
    : `; No external Arduino sensor libraries required for active hardware selection
`;

  const platformioIni = `; PlatformIO Project Configuration File
; Target MCU : ${boardSpec.label} (${boardSpec.mcuSummary})
; Model      : ${model.name} (${model.id})
; Sensors    : ${activeSensorLabels.length > 0 ? activeSensorLabels.join(' + ') : 'None (SIL State Twin + PWM/Relay Out)'}
; Fixed Step : dt = ${model.baseDt} s (${Math.round(1 / model.baseDt)} Hz) | ${discrete.method.toUpperCase()}

[env:${boardSpec.id}]
platform = espressif32@^6.9.0
board = ${boardSpec.id}
framework = arduino
monitor_speed = ${profile.baudRate}
upload_speed = 921600

build_flags =
${buildFlags.map((f) => `  ${f}`).join('\n')}

${libDepsSection}`;

  const stateListComment = model.plant.stateNames
    .map((name, idx) => ` *   - meas_state[${idx}] : ${name} (${model.plant.stateUnits[idx] ?? 'pu'})`)
    .join('\n');

  const hardwareHeaders = activeSensors.humidity ? `#include <DHT.h>\n` : '';

  const gpioDefines = [
    activeSensors.ultrasonic ? `#define PIN_US_TRIG         (${profile.trigPin})` : null,
    activeSensors.ultrasonic ? `#define PIN_US_ECHO         (${profile.echoPin})` : null,
    activeSensors.gas ? `#define PIN_GAS_ADC         (${profile.gasAdcPin})` : null,
    activeSensors.humidity ? `#define PIN_DHT_DATA        (${profile.humidityPin})` : null,
    `#define PIN_PWM_LED         (${profile.pwmLedPin})`,
    `#define PIN_BUZZER          (${profile.buzzerPin})`,
    `#define PIN_RELAY           (${profile.relayPin})`,
    activeSensors.humidity ? `#define DHT_TYPE            DHT22` : null,
  ]
    .filter(Boolean)
    .join('\n');

  const helperBlocks: string[] = [];

  if (activeSensors.humidity) {
    helperBlocks.push(`static DHT dht(PIN_DHT_DATA, DHT_TYPE);
static float g_temp_c = 22.0f;
static float g_humidity_pct = 48.0f;
static uint32_t g_last_dht_ms = 0U;`);
  } else if (activeSensors.ultrasonic) {
    helperBlocks.push(`static constexpr float NOMINAL_TEMP_C = 22.0f;
static constexpr float NOMINAL_RH_PCT = 48.0f;`);
  }

  if (activeSensors.ultrasonic) {
    helperBlocks.push(`static float g_prev_dist_m = ${model.plant.x0[0]?.toFixed(3) ?? '0.35'}f;
static float g_vel_ema_ms = 0.0f;

static float read_ultrasonic_meters(float temp_c, float rh_pct, bool *ok_out) {
    digitalWrite(PIN_US_TRIG, LOW);
    delayMicroseconds(2);
    digitalWrite(PIN_US_TRIG, HIGH);
    delayMicroseconds(10);
    digitalWrite(PIN_US_TRIG, LOW);

    /* Timeout 18 ms (~3.1 m max range) keeps fixed-step pacing bounded */
    const unsigned long echo_us = pulseIn(PIN_US_ECHO, HIGH, 18000UL);
    if (echo_us == 0UL) {
        if (ok_out != nullptr) { *ok_out = false; }
        return g_prev_dist_m;
    }
    if (ok_out != nullptr) { *ok_out = true; }

    /* Speed of sound compensated for air temperature & relative humidity */
    const float v_sound = 331.3f + (0.606f * temp_c) + (0.0124f * rh_pct);
    return (static_cast<float>(echo_us) * 1.0e-6f * v_sound) * 0.5f;
}`);
  }

  if (activeSensors.gas) {
    helperBlocks.push(`static float g_gas_ema_ppm = 50.0f;

static float read_gas_ppm_filtered(void) {
    uint32_t mv_sum = 0U;
    for (int i = 0; i < 4; ++i) {
        mv_sum += analogReadMilliVolts(PIN_GAS_ADC);
    }
    /* Undo 1k/2k voltage divider (1.5x) and map 0.2V..4.5V to ~20..1000 ppm */
    const float mv_sensor = (static_cast<float>(mv_sum) * 0.25f) * 1.5f;
    const float raw_ppm = fmaxf(0.0f, (mv_sensor - 200.0f) * 0.23f);
    g_gas_ema_ppm = (0.20f * raw_ppm) + (0.80f * g_gas_ema_ppm);
    return g_gas_ema_ppm;
}`);
  }

  const setupLines: string[] = [];
  if (activeSensors.ultrasonic) {
    setupLines.push(
      `    pinMode(PIN_US_TRIG, OUTPUT);`,
      `    digitalWrite(PIN_US_TRIG, LOW);`,
      `    pinMode(PIN_US_ECHO, INPUT);`
    );
  }
  if (activeSensors.humidity) {
    setupLines.push(`    dht.begin();`);
  }
  if (activeSensors.gas) {
    setupLines.push(
      `    analogReadResolution(12);`,
      `    analogSetPinAttenuation(PIN_GAS_ADC, ADC_11db);`
    );
  }
  if (setupLines.length === 0) {
    setupLines.push(`    /* No external sensors enabled; operating with internal SIL plant twin */`);
  }

  const loopSteps: string[] = [];
  if (activeSensors.humidity) {
    loopSteps.push(`    /* Slow 0.5 Hz DHT22 update prevents blocking the fast control tick */
    const uint32_t now_ms = millis();
    if ((uint32_t)(now_ms - g_last_dht_ms) >= 2000UL) {
        g_last_dht_ms = now_ms;
        const float h = dht.readHumidity();
        const float t = dht.readTemperature();
        if (!isnan(h) && (h >= 0.0f) && (h <= 100.0f)) { g_humidity_pct = h; }
        if (!isnan(t) && (t > -40.0f) && (t < 85.0f)) { g_temp_c = t; }
    }`);
  }

  if (activeSensors.ultrasonic) {
    const tempArg = activeSensors.humidity ? 'g_temp_c' : 'NOMINAL_TEMP_C';
    const rhArg = activeSensors.humidity ? 'g_humidity_pct' : 'NOMINAL_RH_PCT';
    loopSteps.push(`    bool us_ok = false;
    const float dist_m = read_ultrasonic_meters(${tempArg}, ${rhArg}, &us_ok);
    const float raw_vel = (dist_m - g_prev_dist_m) / CTRL_DT_SEC;
    g_vel_ema_ms = (0.35f * raw_vel) + (0.65f * g_vel_ema_ms);
    g_prev_dist_m = dist_m;`);
  }

  if (activeSensors.gas) {
    loopSteps.push(`    const float gas_ppm = read_gas_ppm_filtered();`);
  }

  let ctrlInputMapping = '';
  let plantTwinStep = '';

  if (model.id === 'esp32_gas_humidity_relay' && activeSensors.gas) {
    ctrlInputMapping = `    CtrlInput ctrl_in;
    memset(&ctrl_in, 0, sizeof(ctrl_in));
    ctrl_in.ref = g_target_ref;
    ctrl_in.hil_rx_valid = true;
    ctrl_in.meas_state[0] = gas_ppm;
${activeSensors.humidity ? `    if (CTRL_STATE_DIM > 1U) { ctrl_in.meas_state[1] = g_humidity_pct; }` : `    if (CTRL_STATE_DIM > 1U) { ctrl_in.meas_state[1] = g_ctrl.x[1]; }`}`;
    plantTwinStep = `    const float gas_alarm_val = gas_ppm;`;
  } else if (activeSensors.ultrasonic) {
    ctrlInputMapping = `    CtrlInput ctrl_in;
    memset(&ctrl_in, 0, sizeof(ctrl_in));
    ctrl_in.ref = g_target_ref;
    ctrl_in.hil_rx_valid = us_ok;
    ctrl_in.meas_state[0] = dist_m;
    if (CTRL_STATE_DIM > 1U) { ctrl_in.meas_state[1] = g_vel_ema_ms; }`;
    plantTwinStep = activeSensors.gas
      ? `    const float gas_alarm_val = gas_ppm;`
      : `    const float gas_alarm_val = 0.0f;`;
  } else if (activeSensors.gas) {
    ctrlInputMapping = `    CtrlInput ctrl_in;
    memset(&ctrl_in, 0, sizeof(ctrl_in));
    ctrl_in.ref = g_target_ref;
    ctrl_in.hil_rx_valid = true;
    ctrl_in.meas_state[0] = gas_ppm;
    for (size_t i = 1U; i < CTRL_STATE_DIM; ++i) {
        ctrl_in.meas_state[i] = ${activeSensors.humidity ? '(i == 1U) ? g_humidity_pct : g_ctrl.x[i]' : 'g_ctrl.x[i]'};
    }`;
    plantTwinStep = `    /* Propagate remaining observer states + evaluate MQ gas alarm threshold */
    ctrl_plant_step(&g_ctrl, ctrl_out.u_cmd);
    const float gas_alarm_val = gas_ppm;`;
  } else if (activeSensors.humidity) {
    ctrlInputMapping = `    CtrlInput ctrl_in;
    memset(&ctrl_in, 0, sizeof(ctrl_in));
    ctrl_in.ref = g_target_ref;
    ctrl_in.hil_rx_valid = true;
    ctrl_in.meas_state[0] = g_humidity_pct;
    if (CTRL_STATE_DIM > 1U) { ctrl_in.meas_state[1] = g_temp_c; }`;
    plantTwinStep = `    ctrl_plant_step(&g_ctrl, ctrl_out.u_cmd);
    const float gas_alarm_val = 0.0f;`;
  } else {
    ctrlInputMapping = `    CtrlInput ctrl_in;
    memset(&ctrl_in, 0, sizeof(ctrl_in));
    ctrl_in.ref = g_target_ref;
    ctrl_in.hil_rx_valid = true;
    for (size_t i = 0U; i < CTRL_STATE_DIM; ++i) {
        ctrl_in.meas_state[i] = g_ctrl.x[i];
    }`;
    plantTwinStep = `    /* Step discretized plant twin (Ad, Bd) for hardware-in-the-loop verification */
    ctrl_plant_step(&g_ctrl, ctrl_out.u_cmd);
    const float gas_alarm_val = 0.0f;`;
  }

  const mainCpp = `/**
 * @file src/main.cpp
 * @brief PlatformIO ESP32 Arduino firmware generated for OpenLoop control model
 *
 * Board Target : ${boardSpec.label}
 * Control Model: ${model.name} (${model.id})
 * Active Sensors: ${activeSensorLabels.length > 0 ? activeSensorLabels.join(', ') : 'Internal SIL Twin'}
 * Sample Period: ${dtUs} us (${Math.round(1 / model.baseDt)} Hz)
 * State Mapping:
${stateListComment}
 */

#include <Arduino.h>
#include <math.h>
#include <string.h>
${hardwareHeaders}
extern "C" {
#include "ctrl_model.h"
#include "hil_frame.h"
}

/* ============================================================================
 * Tailored GPIO Configuration for ${boardSpec.id}
 * ========================================================================== */
${gpioDefines}

#define LEDC_CH_LED         (0)
#define LEDC_CH_BUZZER      (1)
#define LEDC_PWM_FREQ_HZ    (5000)
#define LEDC_RES_BITS       (8)

#define UART_BAUD_RATE      (${profile.baudRate}UL)
#define CTRL_PERIOD_US      (${dtUs}UL)
#define RELAY_TRIP_THRESH   (${profile.relayThreshold.toFixed(2)}f)
#define RELAY_HYSTERESIS    (4.0f)

static CtrlState g_ctrl;
static float g_target_ref = ${defaultRef}f;
static bool  g_relay_latched = false;
static uint32_t g_last_step_us = 0U;

${helperBlocks.join('\n\n')}

static void transmit_hil_cobs_frame(float ref, float y0, float y1, float u_cmd) {
    HilWireFrame frame;
    frame.sof = 0xAA55U;
    frame.seq = g_ctrl.tick_count;
    frame.tick_us = micros();
    frame.signals[0] = ref;
    frame.signals[1] = y0;
    frame.signals[2] = y1;
    frame.signals[3] = u_cmd;
    frame.crc16 = hil_crc16_ccitt(
        reinterpret_cast<const uint8_t *>(&frame),
        sizeof(HilWireFrame) - sizeof(uint16_t)
    );

    uint8_t encoded[sizeof(HilWireFrame) + 4U];
    const size_t nbytes = hil_cobs_encode(
        reinterpret_cast<const uint8_t *>(&frame),
        sizeof(HilWireFrame),
        encoded
    );
    Serial.write(encoded, nbytes);
}

void setup() {
    Serial.begin(UART_BAUD_RATE);
    delay(150);

${setupLines.join('\n')}
    pinMode(PIN_RELAY, OUTPUT);
    digitalWrite(PIN_RELAY, LOW);

    ledcSetup(LEDC_CH_LED, LEDC_PWM_FREQ_HZ, LEDC_RES_BITS);
    ledcAttachPin(PIN_PWM_LED, LEDC_CH_LED);

    ledcSetup(LEDC_CH_BUZZER, 2000, LEDC_RES_BITS);
    ledcAttachPin(PIN_BUZZER, LEDC_CH_BUZZER);

    ctrl_init(&g_ctrl);
    g_last_step_us = micros();
}

void loop() {
    const uint32_t now_us = micros();
    if ((uint32_t)(now_us - g_last_step_us) < CTRL_PERIOD_US) {
        return;
    }
    g_last_step_us += CTRL_PERIOD_US;

${loopSteps.length > 0 ? loopSteps.join('\n\n') + '\n\n' : ''}${ctrlInputMapping}

    /* Execute OpenLoop fixed-step discretized C99 controller */
    CtrlOutput ctrl_out;
    ctrl_step(&g_ctrl, &ctrl_in, &ctrl_out);

${plantTwinStep}

    /* Map continuous actuator command u_cmd -> LEDC PWM + Hysteresis Relay + Buzzer */
    const float abs_u = fabsf(ctrl_out.u_cmd);
    const float span = fmaxf(1.0f, fabsf(${model.limits.satMax.toFixed(1)}f));
    const uint32_t pwm_duty = (uint32_t)fminf(255.0f, (abs_u / span) * 255.0f);
    ledcWrite(LEDC_CH_LED, pwm_duty);

    if (!g_relay_latched && (abs_u >= RELAY_TRIP_THRESH)) {
        g_relay_latched = true;
    } else if (g_relay_latched && (abs_u <= fmaxf(0.0f, RELAY_TRIP_THRESH - RELAY_HYSTERESIS))) {
        g_relay_latched = false;
    }
    digitalWrite(PIN_RELAY, g_relay_latched ? HIGH : LOW);

    if (ctrl_out.saturated || (gas_alarm_val > 400.0f)) {
        ledcWriteTone(LEDC_CH_BUZZER, 1800);
    } else {
        ledcWriteTone(LEDC_CH_BUZZER, 0);
    }

    const float y1_val = (CTRL_OUTPUT_DIM > 1U) ? ctrl_out.y_est[1] : 0.0f;
    transmit_hil_cobs_frame(ctrl_in.ref, ctrl_out.y_est[0], y1_val, ctrl_out.u_cmd);
}
`;

  const wiringMarkdown = `# ESP32 Hardware Map & Safety Wiring Checklist
- Board Target: \`${boardSpec.label}\`
- Control Model: \`${model.name}\`
- Enabled Sensors: \`${activeSensorLabels.length > 0 ? activeSensorLabels.join(', ') : 'None (SIL State Twin)'}\`

| Peripheral | Signal | ESP32 Pin | Direction | Electrical Protection |
| --- | --- | --- | --- | --- |
${wiringRows
  .map(
    (r) =>
      `| ${r.peripheral} | ${r.signal} | GPIO ${r.gpio} | ${r.direction} | ${r.protectionNote} |`
  )
  .join('\n')}

## Flashing via PlatformIO
\`\`\`sh
pio run -e ${boardSpec.id} -t upload
pio device monitor -b ${profile.baudRate}
\`\`\`
`;

  return {
    platformioIni,
    mainCpp,
    wiringMarkdown,
    wiringRows,
    issues,
    boardSpec,
    activeSensors,
  };
}

