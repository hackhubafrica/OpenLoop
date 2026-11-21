import { parse as parseToml } from 'smol-toml';
import { PRESET_MODELS } from '../data/presets';
import { ControlModel, PresetId } from '../types/control';

export const MIN_STATE_DIM = 1;
export const MAX_STATE_DIM = 8;
export const MIN_INPUT_DIM = 1;
export const MAX_INPUT_DIM = 4;
export const MIN_OUTPUT_DIM = 1;
export const MAX_OUTPUT_DIM = 4;

function clampInt(val: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(val)));
}

function isFiniteMatrix(mat: unknown, rows: number, cols: number): mat is number[][] {
  if (!Array.isArray(mat) || mat.length !== rows) return false;
  return mat.every(
    (row) =>
      Array.isArray(row) &&
      row.length === cols &&
      row.every((v) => typeof v === 'number' && Number.isFinite(v))
  );
}

function isFiniteVector(vec: unknown, len: number): vec is number[] {
  return (
    Array.isArray(vec) &&
    vec.length === len &&
    vec.every((v) => typeof v === 'number' && Number.isFinite(v))
  );
}

function asRecord(val: unknown): Record<string, unknown> {
  return val && typeof val === 'object' && !Array.isArray(val)
    ? (val as Record<string, unknown>)
    : {};
}

/**
 * Resizes plant state dimension n (1..8), output dimension p (1..4), and input dimension m (1..4)
 * while preserving overlapping matrix/vector values and zero-padding additions.
 */
export function resizePlantDimensions(
  model: ControlModel,
  rawNextN: number,
  rawNextP: number,
  rawNextM: number = model.plant.m || 1
): ControlModel {
  const nextN = clampInt(rawNextN, MIN_STATE_DIM, MAX_STATE_DIM);
  const nextM = clampInt(rawNextM, MIN_INPUT_DIM, MAX_INPUT_DIM);
  const nextP = clampInt(rawNextP, MIN_OUTPUT_DIM, MAX_OUTPUT_DIM);
  const next = structuredClone(model);

  const oldA = model.plant.A;
  const oldB = model.plant.B;
  const oldC = model.plant.C;
  const oldD = model.plant.D;

  next.plant.n = nextN;
  next.plant.m = nextM;
  next.plant.p = nextP;

  next.plant.A = Array.from({ length: nextN }, (_, r) =>
    Array.from({ length: nextN }, (__, c) => {
      if (r < oldA.length && c < (oldA[r]?.length ?? 0)) {
        return oldA[r][c];
      }
      // Give newly added diagonal states gentle stable damping (-1) by default
      return r === c ? -1 : 0;
    })
  );

  next.plant.B = Array.from({ length: nextN }, (_, r) =>
    Array.from({ length: nextM }, (__, c) =>
      r < oldB.length && c < (oldB[r]?.length ?? 0) ? oldB[r][c] : 0
    )
  );

  next.plant.C = Array.from({ length: nextP }, (_, r) =>
    Array.from({ length: nextN }, (__, c) => {
      if (r < oldC.length && c < (oldC[r]?.length ?? 0)) {
        return oldC[r][c];
      }
      return r === c ? 1 : 0;
    })
  );

  next.plant.D = Array.from({ length: nextP }, (_, r) =>
    Array.from({ length: nextM }, (__, c) =>
      r < oldD.length && c < (oldD[r]?.length ?? 0) ? oldD[r][c] : 0
    )
  );

  next.plant.x0 = Array.from({ length: nextN }, (_, i) =>
    i < model.plant.x0.length ? model.plant.x0[i] : 0
  );

  next.lqrK = Array.from({ length: nextN }, (_, i) =>
    i < model.lqrK.length ? model.lqrK[i] : 0
  );

  next.plant.stateNames = Array.from({ length: nextN }, (_, i) =>
    model.plant.stateNames[i]?.trim() ? model.plant.stateNames[i] : `x_${i}`
  );
  next.plant.stateUnits = Array.from({ length: nextN }, (_, i) =>
    model.plant.stateUnits[i]?.trim() ? model.plant.stateUnits[i] : 'u'
  );

  const prevInputNames =
    model.plant.inputNames && model.plant.inputNames.length > 0
      ? model.plant.inputNames
      : [model.plant.inputName || 'u_0'];
  const prevInputUnits =
    model.plant.inputUnits && model.plant.inputUnits.length > 0
      ? model.plant.inputUnits
      : [model.plant.inputUnit || 'u'];

  next.plant.inputNames = Array.from({ length: nextM }, (_, i) =>
    prevInputNames[i]?.trim() ? prevInputNames[i] : `u_${i}`
  );
  next.plant.inputUnits = Array.from({ length: nextM }, (_, i) =>
    prevInputUnits[i]?.trim() ? prevInputUnits[i] : prevInputUnits[0] ?? 'u'
  );
  next.plant.inputName = next.plant.inputNames[0];
  next.plant.inputUnit = next.plant.inputUnits[0];

  const prevAux = model.plant.auxInputs ?? [];
  next.plant.auxInputs = Array.from({ length: nextM }, (_, i) =>
    Number.isFinite(prevAux[i]) ? prevAux[i] : 0
  );

  next.plant.outputNames = Array.from({ length: nextP }, (_, i) =>
    model.plant.outputNames[i]?.trim() ? model.plant.outputNames[i] : `y_${i}`
  );
  next.plant.outputUnits = Array.from({ length: nextP }, (_, i) =>
    model.plant.outputUnits[i]?.trim() ? model.plant.outputUnits[i] : 'u'
  );

  next.pid.targetOutputIndex = clampInt(
    model.pid.targetOutputIndex,
    0,
    Math.max(0, nextP - 1)
  );

  return syncDerivedPlantMeta(next);
}

function syncDerivedPlantMeta(model: ControlModel): ControlModel {
  const { n, m, p } = model.plant;
  const presetKey = (model.basePreset ?? model.id) as PresetId;
  const preset = PRESET_MODELS[presetKey];

  const dimsChanged =
    !preset || n !== preset.plant.n || m !== preset.plant.m || p !== preset.plant.p;
  if (dimsChanged) {
    model.isCustomModel = true;
    if (!model.basePreset && preset) {
      model.basePreset = preset.id as PresetId;
    }
  }

  model.blocks = model.blocks.map((b) =>
    b.id === 'plant_ss'
      ? {
          ...b,
          label: dimsChanged
            ? `SS Plant (${n}×${m}→${p})`
            : preset.blocks.find((pb) => pb.id === 'plant_ss')?.label ?? b.label,
        }
      : b
  );
  return model;
}

export function addInputChannel(model: ControlModel): ControlModel {
  if (model.plant.m >= MAX_INPUT_DIM) return model;
  return resizePlantDimensions(
    model,
    model.plant.n,
    model.plant.p,
    model.plant.m + 1
  );
}

export function removeInputChannel(
  model: ControlModel,
  channelIndex: number
): ControlModel {
  if (model.plant.m <= MIN_INPUT_DIM) return model;
  const next = structuredClone(model);
  const idx = clampInt(channelIndex, 0, next.plant.m - 1);
  next.plant.B = next.plant.B.map((row) => row.filter((_, c) => c !== idx));
  next.plant.D = next.plant.D.map((row) => row.filter((_, c) => c !== idx));

  const prevNames =
    next.plant.inputNames && next.plant.inputNames.length === next.plant.m
      ? [...next.plant.inputNames]
      : Array.from({ length: next.plant.m }, (_, i) =>
          i === 0 ? next.plant.inputName : `u_${i}`
        );
  const prevUnits =
    next.plant.inputUnits && next.plant.inputUnits.length === next.plant.m
      ? [...next.plant.inputUnits]
      : Array.from({ length: next.plant.m }, () => next.plant.inputUnit);

  const prevAux =
    next.plant.auxInputs && next.plant.auxInputs.length === next.plant.m
      ? [...next.plant.auxInputs]
      : Array.from({ length: next.plant.m }, () => 0);

  next.plant.inputNames = prevNames.filter((_, i) => i !== idx);
  next.plant.inputUnits = prevUnits.filter((_, i) => i !== idx);
  next.plant.auxInputs = prevAux.filter((_, i) => i !== idx);
  next.plant.m -= 1;
  next.plant.inputName = next.plant.inputNames[0] ?? 'u_0';
  next.plant.inputUnit = next.plant.inputUnits[0] ?? 'u';
  next.isCustomModel = true;
  return syncDerivedPlantMeta(next);
}

export function addOutputChannel(model: ControlModel): ControlModel {
  if (model.plant.p >= MAX_OUTPUT_DIM) return model;
  return resizePlantDimensions(
    model,
    model.plant.n,
    model.plant.p + 1,
    model.plant.m
  );
}

export function removeOutputChannel(
  model: ControlModel,
  channelIndex: number
): ControlModel {
  if (model.plant.p <= MIN_OUTPUT_DIM) return model;
  const next = structuredClone(model);
  const idx = clampInt(channelIndex, 0, next.plant.p - 1);
  next.plant.C = next.plant.C.filter((_, r) => r !== idx);
  next.plant.D = next.plant.D.filter((_, r) => r !== idx);
  next.plant.outputNames = next.plant.outputNames.filter((_, i) => i !== idx);
  next.plant.outputUnits = next.plant.outputUnits.filter((_, i) => i !== idx);
  next.plant.p -= 1;
  next.pid.targetOutputIndex = clampInt(
    next.pid.targetOutputIndex,
    0,
    Math.max(0, next.plant.p - 1)
  );
  next.isCustomModel = true;
  return syncDerivedPlantMeta(next);
}

function importFromTomlString(
  rawText: string,
  fallbackModel: ControlModel
): { model: ControlModel; format: 'toml'; error: string | null } {
  try {
    const doc = asRecord(parseToml(rawText));
    const modelSec = asRecord(doc.model);
    const plantRoot = asRecord(doc.plant);
    const ssSec = asRecord(plantRoot.state_space ?? doc.plant);
    const ctrlSec = asRecord(doc.controller);
    const lqrSec = asRecord(ctrlSec.lqr);
    const pidSec = asRecord(ctrlSec.pid);
    const limitsSec = asRecord(doc.limits);
    const refSec = asRecord(doc.reference);
    const hilSec = asRecord(doc.hil);

    const A = ssSec.A;
    const B = ssSec.B;
    const C = ssSec.C;
    const D = ssSec.D;
    const x0 = ssSec.x0;
    const lqrK = lqrSec.K ?? doc.lqrK;

    const n = Number(ssSec.n ?? (Array.isArray(A) ? A.length : fallbackModel.plant.n));
    const m = Number(
      ssSec.m ?? (Array.isArray(B) && Array.isArray(B[0]) ? B[0].length : 1)
    );
    const p = Number(ssSec.p ?? (Array.isArray(C) ? C.length : fallbackModel.plant.p));

    if (
      !Number.isInteger(n) ||
      !Number.isInteger(m) ||
      !Number.isInteger(p) ||
      n < MIN_STATE_DIM ||
      n > MAX_STATE_DIM ||
      m < MIN_INPUT_DIM ||
      m > MAX_INPUT_DIM ||
      p < MIN_OUTPUT_DIM ||
      p > MAX_OUTPUT_DIM
    ) {
      return {
        model: fallbackModel,
        format: 'toml',
        error: `Unsupported TOML plant dimensions (n=${n}, m=${m}, p=${p}). Expected n in 1..8, m in 1..4, p in 1..4.`,
      };
    }

    if (
      !isFiniteMatrix(A, n, n) ||
      !isFiniteMatrix(B, n, m) ||
      !isFiniteMatrix(C, p, n) ||
      !isFiniteMatrix(D, p, m) ||
      !isFiniteVector(x0, n)
    ) {
      return {
        model: fallbackModel,
        format: 'toml',
        error: `TOML [plant.state_space] matrices A(${n}x${n}), B(${n}x${m}), C(${p}x${n}), D(${p}x${m}), x0(${n}) must match declared dimensions.`,
      };
    }

    if (!isFiniteVector(lqrK, n)) {
      return {
        model: fallbackModel,
        format: 'toml',
        error: `TOML [controller.lqr].K must be an array of ${n} finite numbers.`,
      };
    }

    const rawId =
      typeof modelSec.id === 'string' && modelSec.id.trim()
        ? modelSec.id.trim()
        : fallbackModel.id;
    const baseKey: PresetId =
      rawId === 'pendulum' || rawId === 'dcmotor' || rawId === 'buck'
        ? rawId
        : fallbackModel.basePreset ??
          (fallbackModel.id === 'pendulum' ||
          fallbackModel.id === 'dcmotor' ||
          fallbackModel.id === 'buck'
            ? fallbackModel.id
            : 'pendulum');
    const template = structuredClone(PRESET_MODELS[baseKey]);

    const rawStates = Array.isArray(ssSec.states) ? ssSec.states : null;
    const rawStateUnits = Array.isArray(ssSec.state_units) ? ssSec.state_units : null;
    const rawInputs = Array.isArray(ssSec.inputs) ? ssSec.inputs : null;
    const rawInputUnits = Array.isArray(ssSec.input_units) ? ssSec.input_units : null;
    const rawOutputs = Array.isArray(ssSec.outputs) ? ssSec.outputs : null;
    const rawOutputUnits = Array.isArray(ssSec.output_units) ? ssSec.output_units : null;
    const rawTx = Array.isArray(hilSec.tx_channels) ? hilSec.tx_channels : null;
    const rawRx = Array.isArray(hilSec.rx_channels) ? hilSec.rx_channels : null;

    const baseDt = Number(modelSec.base_dt ?? fallbackModel.baseDt);
    const duration = Number(modelSec.duration ?? fallbackModel.duration);
    if (!Number.isFinite(baseDt) || baseDt <= 0 || !Number.isFinite(duration) || duration <= 0) {
      return {
        model: fallbackModel,
        format: 'toml',
        error: 'TOML [model].base_dt and [model].duration must be positive finite numbers.',
      };
    }

    const rawConnections = Array.isArray(doc.connections) ? doc.connections : [];
    const hasLoopConn = rawConnections.some((conn) => {
      const rec = asRecord(conn);
      return rec.from === 'lqr_ctrl.u_lqr' && rec.to === 'sum_err.alg_fb';
    });

    const inputNames = rawInputs
      ? Array.from({ length: m }, (_, i) => String(rawInputs[i] ?? `u_${i}`))
      : Array.from({ length: m }, (_, i) =>
          i === 0 ? template.plant.inputName : `u_${i}`
        );
    const inputUnits = rawInputUnits
      ? Array.from({ length: m }, (_, i) => String(rawInputUnits[i] ?? 'u'))
      : Array.from({ length: m }, () => template.plant.inputUnit);

    const next: ControlModel = {
      ...template,
      id: rawId,
      basePreset: baseKey,
      isCustomModel:
        rawId !== baseKey ||
        n !== template.plant.n ||
        m !== template.plant.m ||
        p !== template.plant.p,
      name:
        typeof modelSec.name === 'string' && modelSec.name.trim()
          ? modelSec.name.trim()
          : template.name,
      subtitle:
        typeof modelSec.subtitle === 'string' && modelSec.subtitle.trim()
          ? modelSec.subtitle.trim()
          : `${n}-state TOML state-space model`,
      license: modelSec.license === 'Apache-2.0' ? 'Apache-2.0' : 'MIT',
      baseDt,
      fastDtRatio:
        Number.isFinite(Number(modelSec.fast_dt_ratio)) &&
        Number(modelSec.fast_dt_ratio) >= 1
          ? Math.round(Number(modelSec.fast_dt_ratio))
          : template.fastDtRatio,
      duration,
      discretization: modelSec.discretization === 'tustin' ? 'tustin' : 'zoh',
      lqrK: [...lqrK],
      lqrTracksRefOnState0:
        typeof lqrSec.tracks_ref_state0 === 'boolean'
          ? lqrSec.tracks_ref_state0
          : template.lqrTracksRefOnState0,
      plant: {
        n,
        m,
        p,
        stateNames: rawStates
          ? Array.from({ length: n }, (_, i) => String(rawStates[i] ?? `x_${i}`))
          : Array.from({ length: n }, (_, i) => template.plant.stateNames[i] ?? `x_${i}`),
        stateUnits: rawStateUnits
          ? Array.from({ length: n }, (_, i) => String(rawStateUnits[i] ?? 'u'))
          : Array.from({ length: n }, (_, i) => template.plant.stateUnits[i] ?? 'u'),
        outputNames: rawOutputs
          ? Array.from({ length: p }, (_, i) => String(rawOutputs[i] ?? `y_${i}`))
          : Array.from({ length: p }, (_, i) => template.plant.outputNames[i] ?? `y_${i}`),
        outputUnits: rawOutputUnits
          ? Array.from({ length: p }, (_, i) => String(rawOutputUnits[i] ?? 'u'))
          : Array.from({ length: p }, (_, i) => template.plant.outputUnits[i] ?? 'u'),
        inputName: inputNames[0] ?? template.plant.inputName,
        inputUnit: inputUnits[0] ?? template.plant.inputUnit,
        inputNames,
        inputUnits,
        A: A.map((row) => [...row]),
        B: B.map((row) => [...row]),
        C: C.map((row) => [...row]),
        D: D.map((row) => [...row]),
        x0: [...x0],
      },
      pid: {
        enabled:
          typeof pidSec.enabled === 'boolean' ? pidSec.enabled : template.pid.enabled,
        targetOutputIndex: clampInt(
          Number(pidSec.target_output_idx ?? template.pid.targetOutputIndex),
          0,
          p - 1
        ),
        tracksStepRef:
          typeof pidSec.tracks_step_ref === 'boolean'
            ? pidSec.tracks_step_ref
            : template.pid.tracksStepRef,
        kp: Number.isFinite(Number(pidSec.kp)) ? Number(pidSec.kp) : template.pid.kp,
        ki: Number.isFinite(Number(pidSec.ki)) ? Number(pidSec.ki) : template.pid.ki,
        kd: Number.isFinite(Number(pidSec.kd)) ? Number(pidSec.kd) : template.pid.kd,
        nFilter: Number.isFinite(Number(pidSec.n_filter))
          ? Number(pidSec.n_filter)
          : template.pid.nFilter,
        kbAntiWindup: Number.isFinite(Number(pidSec.kb_anti_windup))
          ? Number(pidSec.kb_anti_windup)
          : template.pid.kbAntiWindup,
      },
      limits: {
        satMin: Number.isFinite(Number(limitsSec.sat_min))
          ? Number(limitsSec.sat_min)
          : template.limits.satMin,
        satMax: Number.isFinite(Number(limitsSec.sat_max))
          ? Number(limitsSec.sat_max)
          : template.limits.satMax,
        rateLimit: Number.isFinite(Number(limitsSec.rate_limit))
          ? Number(limitsSec.rate_limit)
          : template.limits.rateLimit,
      },
      reference: {
        stepTime: Number.isFinite(Number(refSec.step_time))
          ? Number(refSec.step_time)
          : template.reference.stepTime,
        initialValue: Number.isFinite(Number(refSec.initial_value))
          ? Number(refSec.initial_value)
          : template.reference.initialValue,
        finalValue: Number.isFinite(Number(refSec.final_value))
          ? Number(refSec.final_value)
          : template.reference.finalValue,
        disturbanceTime: Number.isFinite(Number(refSec.disturbance_time))
          ? Number(refSec.disturbance_time)
          : template.reference.disturbanceTime,
        disturbanceMagnitude: Number.isFinite(Number(refSec.disturbance_magnitude))
          ? Number(refSec.disturbance_magnitude)
          : template.reference.disturbanceMagnitude,
      },
      hil: {
        transport:
          hilSec.transport === 'socketcan' ||
          hilSec.transport === 'udp' ||
          hilSec.transport === 'uart_cobs'
            ? hilSec.transport
            : template.hil.transport,
        baudOrRate:
          typeof hilSec.rate === 'string' && hilSec.rate.trim()
            ? hilSec.rate
            : template.hil.baudOrRate,
        watchdogMissLimit: Number.isFinite(Number(hilSec.watchdog_miss_limit))
          ? Math.max(1, Math.round(Number(hilSec.watchdog_miss_limit)))
          : template.hil.watchdogMissLimit,
        safeClampValue: Number.isFinite(Number(hilSec.safe_clamp_value))
          ? Number(hilSec.safe_clamp_value)
          : template.hil.safeClampValue,
        txChannels: rawTx ? rawTx.map(String) : template.hil.txChannels,
        rxChannels: rawRx ? rawRx.map(String) : template.hil.rxChannels,
      },
      injectAlgebraicLoopTest: hasLoopConn,
    };

    return { model: next, format: 'toml', error: null };
  } catch (err) {
    return {
      model: fallbackModel,
      format: 'toml',
      error: err instanceof Error ? `Invalid TOML: ${err.message}` : 'Invalid TOML syntax.',
    };
  }
}

/**
 * Parses and validates an imported .ctrl.json or .ctrl.toml file into a ControlModel,
 * normalizing optional fields from the active fallback preset.
 */
export function importModelFromText(
  filename: string,
  rawText: string,
  fallbackModel: ControlModel
): { model: ControlModel; format: 'json' | 'toml'; error: string | null } {
  const trimmed = rawText.trim();
  if (!trimmed) {
    return { model: fallbackModel, format: 'json', error: 'Imported file is empty.' };
  }

  const looksJson =
    filename.toLowerCase().endsWith('.json') || trimmed.startsWith('{');

  if (!looksJson) {
    return importFromTomlString(rawText, fallbackModel);
  }

  // JSON import path
  try {
    const raw = JSON.parse(trimmed) as Record<string, unknown>;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return { model: fallbackModel, format: 'json', error: 'JSON root must be an object.' };
    }

    const rawPlant = raw.plant as Record<string, unknown> | undefined;
    if (!rawPlant || typeof rawPlant !== 'object') {
      return { model: fallbackModel, format: 'json', error: 'Missing required "plant" object in JSON.' };
    }

    const n = Number(rawPlant.n ?? (Array.isArray(rawPlant.A) ? rawPlant.A.length : 0));
    const m = Number(rawPlant.m ?? 1);
    const p = Number(rawPlant.p ?? (Array.isArray(rawPlant.C) ? rawPlant.C.length : 0));

    if (
      !Number.isInteger(n) ||
      !Number.isInteger(m) ||
      !Number.isInteger(p) ||
      n < MIN_STATE_DIM ||
      n > MAX_STATE_DIM ||
      m < MIN_INPUT_DIM ||
      m > MAX_INPUT_DIM ||
      p < MIN_OUTPUT_DIM ||
      p > MAX_OUTPUT_DIM
    ) {
      return {
        model: fallbackModel,
        format: 'json',
        error: `Unsupported plant dimensions (n=${n}, m=${m}, p=${p}). Expected n in 1..8, m in 1..4, p in 1..4.`,
      };
    }

    if (
      !isFiniteMatrix(rawPlant.A, n, n) ||
      !isFiniteMatrix(rawPlant.B, n, m) ||
      !isFiniteMatrix(rawPlant.C, p, n) ||
      !isFiniteMatrix(rawPlant.D, p, m) ||
      !isFiniteVector(rawPlant.x0, n)
    ) {
      return {
        model: fallbackModel,
        format: 'json',
        error: `State-space matrices A(${n}x${n}), B(${n}x${m}), C(${p}x${n}), D(${p}x${m}), x0(${n}) must contain finite numbers.`,
      };
    }

    const baseDt = Number(raw.baseDt);
    const duration = Number(raw.duration);
    if (!Number.isFinite(baseDt) || baseDt <= 0 || !Number.isFinite(duration) || duration <= 0) {
      return {
        model: fallbackModel,
        format: 'json',
        error: 'Fields "baseDt" and "duration" must be positive finite numbers.',
      };
    }

    const lqrK = raw.lqrK;
    if (!isFiniteVector(lqrK, n)) {
      return {
        model: fallbackModel,
        format: 'json',
        error: `Field "lqrK" must be an array of ${n} finite numbers.`,
      };
    }

    const rawId = typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : 'custom';
    const baseKey: PresetId =
      rawId === 'pendulum' || rawId === 'dcmotor' || rawId === 'buck'
        ? rawId
        : fallbackModel.basePreset ??
          (fallbackModel.id === 'pendulum' ||
          fallbackModel.id === 'dcmotor' ||
          fallbackModel.id === 'buck'
            ? fallbackModel.id
            : 'pendulum');
    const template = structuredClone(PRESET_MODELS[baseKey]);

    const rawPid = (raw.pid ?? {}) as Record<string, unknown>;
    const rawLimits = (raw.limits ?? {}) as Record<string, unknown>;
    const rawRef = (raw.reference ?? {}) as Record<string, unknown>;
    const rawHil = (raw.hil ?? {}) as Record<string, unknown>;

    const rawStateNames = Array.isArray(rawPlant.stateNames) ? rawPlant.stateNames : null;
    const rawStateUnits = Array.isArray(rawPlant.stateUnits) ? rawPlant.stateUnits : null;
    const rawInputNames = Array.isArray(rawPlant.inputNames) ? rawPlant.inputNames : null;
    const rawInputUnits = Array.isArray(rawPlant.inputUnits) ? rawPlant.inputUnits : null;
    const rawOutputNames = Array.isArray(rawPlant.outputNames) ? rawPlant.outputNames : null;
    const rawOutputUnits = Array.isArray(rawPlant.outputUnits) ? rawPlant.outputUnits : null;

    const jsonInputNames = rawInputNames
      ? Array.from({ length: m }, (_, i) => String(rawInputNames[i] ?? `u_${i}`))
      : Array.from({ length: m }, (_, i) =>
          i === 0
            ? typeof rawPlant.inputName === 'string' && rawPlant.inputName.trim()
              ? rawPlant.inputName
              : template.plant.inputName
            : `u_${i}`
        );
    const jsonInputUnits = rawInputUnits
      ? Array.from({ length: m }, (_, i) => String(rawInputUnits[i] ?? 'u'))
      : Array.from({ length: m }, () =>
          typeof rawPlant.inputUnit === 'string' && rawPlant.inputUnit.trim()
            ? rawPlant.inputUnit
            : template.plant.inputUnit
        );

    const next: ControlModel = {
      ...template,
      id: rawId,
      basePreset: baseKey,
      isCustomModel:
        rawId !== baseKey ||
        n !== template.plant.n ||
        m !== template.plant.m ||
        p !== template.plant.p ||
        Boolean(raw.isCustomModel),
      name: typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : `Imported (${rawId})`,
      subtitle:
        typeof raw.subtitle === 'string' && raw.subtitle.trim()
          ? raw.subtitle.trim()
          : `${n}-state custom imported state-space plant`,
      license: raw.license === 'Apache-2.0' ? 'Apache-2.0' : 'MIT',
      baseDt,
      fastDtRatio:
        Number.isFinite(Number(raw.fastDtRatio)) && Number(raw.fastDtRatio) >= 1
          ? Math.round(Number(raw.fastDtRatio))
          : template.fastDtRatio,
      duration,
      discretization: raw.discretization === 'tustin' ? 'tustin' : 'zoh',
      lqrK: [...lqrK],
      lqrTracksRefOnState0:
        typeof raw.lqrTracksRefOnState0 === 'boolean'
          ? raw.lqrTracksRefOnState0
          : template.lqrTracksRefOnState0,
      plant: {
        n,
        m,
        p,
        stateNames: rawStateNames
          ? Array.from({ length: n }, (_, i) => String(rawStateNames[i] ?? `x_${i}`))
          : Array.from({ length: n }, (_, i) => template.plant.stateNames[i] ?? `x_${i}`),
        stateUnits: rawStateUnits
          ? Array.from({ length: n }, (_, i) => String(rawStateUnits[i] ?? 'u'))
          : Array.from({ length: n }, (_, i) => template.plant.stateUnits[i] ?? 'u'),
        outputNames: rawOutputNames
          ? Array.from({ length: p }, (_, i) => String(rawOutputNames[i] ?? `y_${i}`))
          : Array.from({ length: p }, (_, i) => template.plant.outputNames[i] ?? `y_${i}`),
        outputUnits: rawOutputUnits
          ? Array.from({ length: p }, (_, i) => String(rawOutputUnits[i] ?? 'u'))
          : Array.from({ length: p }, (_, i) => template.plant.outputUnits[i] ?? 'u'),
        inputName: jsonInputNames[0] ?? template.plant.inputName,
        inputUnit: jsonInputUnits[0] ?? template.plant.inputUnit,
        inputNames: jsonInputNames,
        inputUnits: jsonInputUnits,
        A: rawPlant.A.map((r) => [...r]),
        B: rawPlant.B.map((r) => [...r]),
        C: rawPlant.C.map((r) => [...r]),
        D: rawPlant.D.map((r) => [...r]),
        x0: [...rawPlant.x0],
      },
      pid: {
        enabled: typeof rawPid.enabled === 'boolean' ? rawPid.enabled : template.pid.enabled,
        targetOutputIndex: clampInt(
          Number(rawPid.targetOutputIndex ?? template.pid.targetOutputIndex),
          0,
          p - 1
        ),
        tracksStepRef:
          typeof rawPid.tracksStepRef === 'boolean'
            ? rawPid.tracksStepRef
            : template.pid.tracksStepRef,
        kp: Number.isFinite(Number(rawPid.kp)) ? Number(rawPid.kp) : template.pid.kp,
        ki: Number.isFinite(Number(rawPid.ki)) ? Number(rawPid.ki) : template.pid.ki,
        kd: Number.isFinite(Number(rawPid.kd)) ? Number(rawPid.kd) : template.pid.kd,
        nFilter: Number.isFinite(Number(rawPid.nFilter))
          ? Number(rawPid.nFilter)
          : template.pid.nFilter,
        kbAntiWindup: Number.isFinite(Number(rawPid.kbAntiWindup))
          ? Number(rawPid.kbAntiWindup)
          : template.pid.kbAntiWindup,
      },
      limits: {
        satMin: Number.isFinite(Number(rawLimits.satMin))
          ? Number(rawLimits.satMin)
          : template.limits.satMin,
        satMax: Number.isFinite(Number(rawLimits.satMax))
          ? Number(rawLimits.satMax)
          : template.limits.satMax,
        rateLimit: Number.isFinite(Number(rawLimits.rateLimit))
          ? Number(rawLimits.rateLimit)
          : template.limits.rateLimit,
      },
      reference: {
        stepTime: Number.isFinite(Number(rawRef.stepTime))
          ? Number(rawRef.stepTime)
          : template.reference.stepTime,
        initialValue: Number.isFinite(Number(rawRef.initialValue))
          ? Number(rawRef.initialValue)
          : template.reference.initialValue,
        finalValue: Number.isFinite(Number(rawRef.finalValue))
          ? Number(rawRef.finalValue)
          : template.reference.finalValue,
        disturbanceTime: Number.isFinite(Number(rawRef.disturbanceTime))
          ? Number(rawRef.disturbanceTime)
          : template.reference.disturbanceTime,
        disturbanceMagnitude: Number.isFinite(Number(rawRef.disturbanceMagnitude))
          ? Number(rawRef.disturbanceMagnitude)
          : template.reference.disturbanceMagnitude,
      },
      hil: {
        transport:
          rawHil.transport === 'socketcan' ||
          rawHil.transport === 'udp' ||
          rawHil.transport === 'uart_cobs'
            ? rawHil.transport
            : template.hil.transport,
        baudOrRate:
          typeof rawHil.baudOrRate === 'string' && rawHil.baudOrRate.trim()
            ? rawHil.baudOrRate
            : template.hil.baudOrRate,
        watchdogMissLimit: Number.isFinite(Number(rawHil.watchdogMissLimit))
          ? Math.max(1, Math.round(Number(rawHil.watchdogMissLimit)))
          : template.hil.watchdogMissLimit,
        safeClampValue: Number.isFinite(Number(rawHil.safeClampValue))
          ? Number(rawHil.safeClampValue)
          : template.hil.safeClampValue,
        txChannels: Array.isArray(rawHil.txChannels)
          ? rawHil.txChannels.map(String)
          : template.hil.txChannels,
        rxChannels: Array.isArray(rawHil.rxChannels)
          ? rawHil.rxChannels.map(String)
          : template.hil.rxChannels,
      },
      blocks: Array.isArray(raw.blocks) ? (raw.blocks as ControlModel['blocks']) : template.blocks,
      edges: Array.isArray(raw.edges) ? (raw.edges as ControlModel['edges']) : template.edges,
      injectAlgebraicLoopTest: Boolean(raw.injectAlgebraicLoopTest),
    };

    return { model: next, format: 'json', error: null };
  } catch (err) {
    return {
      model: fallbackModel,
      format: 'json',
      error: err instanceof Error ? `Invalid JSON: ${err.message}` : 'Invalid JSON syntax.',
    };
  }
}
