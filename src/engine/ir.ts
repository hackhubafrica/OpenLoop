import { ControlModel } from '../types/control';

function formatMatrix(mat: number[][]): string {
  const rows = mat.map(
    (r) => `  [ ${r.map((v) => Number(v.toFixed(6))).join(', ')} ]`
  );
  return `[\n${rows.join(',\n')}\n]`;
}

function formatVector(vec: number[]): string {
  return `[ ${vec.map((v) => Number(v.toFixed(6))).join(', ')} ]`;
}

/**
 * Serializes a ControlModel into a clean, Git-diffable declarative TOML IR.
 */
export function serializeModelToToml(model: ControlModel): string {
  const lines: string[] = [
    `# OpenLoop Declarative Control Model IR (v1.0)`,
    `# Git-friendly, diffable specification — zero proprietary binary blobs.`,
    ``,
    `[model]`,
    `id = "${model.id}"`,
    `name = "${model.name}"`,
    `license = "${model.license}"`,
    `base_dt = ${model.baseDt}`,
    `fast_dt_ratio = ${model.fastDtRatio}`,
    `duration = ${model.duration}`,
    `discretization = "${model.discretization}"`,
    ``,
    `[plant.state_space]`,
    `n = ${model.plant.n}`,
    `m = ${model.plant.m}`,
    `p = ${model.plant.p}`,
    `states = [ ${model.plant.stateNames.map((s) => `"${s}"`).join(', ')} ]`,
    `state_units = [ ${model.plant.stateUnits.map((s) => `"${s}"`).join(', ')} ]`,
    `inputs = [ ${(model.plant.inputNames ?? [model.plant.inputName]).map((s) => `"${s}"`).join(', ')} ]`,
    `input_units = [ ${(model.plant.inputUnits ?? [model.plant.inputUnit]).map((s) => `"${s}"`).join(', ')} ]`,
    `outputs = [ ${model.plant.outputNames.map((s) => `"${s}"`).join(', ')} ]`,
    `output_units = [ ${model.plant.outputUnits.map((s) => `"${s}"`).join(', ')} ]`,
    `x0 = ${formatVector(model.plant.x0)}`,
    `A = ${formatMatrix(model.plant.A)}`,
    `B = ${formatMatrix(model.plant.B)}`,
    `C = ${formatMatrix(model.plant.C)}`,
    `D = ${formatMatrix(model.plant.D)}`,
    ``,
    `[controller.lqr]`,
    `tracks_ref_state0 = ${model.lqrTracksRefOnState0}`,
    `K = ${formatVector(model.lqrK)}`,
    ``,
    `[controller.pid]`,
    `enabled = ${model.pid.enabled}`,
    `target_output_idx = ${model.pid.targetOutputIndex}`,
    `tracks_step_ref = ${model.pid.tracksStepRef}`,
    `kp = ${model.pid.kp}`,
    `ki = ${model.pid.ki}`,
    `kd = ${model.pid.kd}`,
    `n_filter = ${model.pid.nFilter}`,
    `kb_anti_windup = ${model.pid.kbAntiWindup}`,
    ``,
    `[limits]`,
    `sat_min = ${model.limits.satMin}`,
    `sat_max = ${model.limits.satMax}`,
    `rate_limit = ${model.limits.rateLimit}`,
    ``,
    `[reference]`,
    `step_time = ${model.reference.stepTime}`,
    `initial_value = ${model.reference.initialValue}`,
    `final_value = ${model.reference.finalValue}`,
    `disturbance_time = ${model.reference.disturbanceTime}`,
    `disturbance_magnitude = ${model.reference.disturbanceMagnitude}`,
    ``,
    `[hil]`,
    `transport = "${model.hil.transport}"`,
    `rate = "${model.hil.baudOrRate}"`,
    `watchdog_miss_limit = ${model.hil.watchdogMissLimit}`,
    `safe_clamp_value = ${model.hil.safeClampValue}`,
    `tx_channels = [ ${model.hil.txChannels.map((c) => `"${c}"`).join(', ')} ]`,
    `rx_channels = [ ${model.hil.rxChannels.map((c) => `"${c}"`).join(', ')} ]`,
    ``,
    `# Deterministic Block Graph & Port Connections`,
  ];

  for (const b of model.blocks) {
    lines.push(
      `[[blocks]]`,
      `id = "${b.id}"`,
      `kind = "${b.kind}"`,
      `dt = ${b.dt}`,
      `memory = ${b.hasMemory}`,
      ``
    );
  }

  for (const e of model.edges) {
    lines.push(
      `[[connections]]`,
      `from = "${e.from}.${e.fromPort}"`,
      `to = "${e.to}.${e.toPort}"`,
      `signal = "${e.signalName}"`,
      ``
    );
  }

  if (model.injectAlgebraicLoopTest) {
    lines.push(
      `[[connections]]`,
      `from = "lqr_ctrl.u_lqr"`,
      `to = "sum_err.alg_fb"`,
      `signal = "u_direct_loop"  # Zero-delay cycle test`,
      ``
    );
  }

  return lines.join('\n');
}

/**
 * Parses editable key-value / matrix fields from the TOML IR back into a ControlModel.
 * Returns { model, error } so invalid edits produce clean syntax diagnostics without crashing.
 */
export function parseTomlToModel(
  toml: string,
  base: ControlModel
): { model: ControlModel; parseError: string | null } {
  try {
    // Strip comments
    const clean = toml
      .split('\n')
      .map((line) => {
        const idx = line.indexOf('#');
        return idx >= 0 ? line.slice(0, idx) : line;
      })
      .join('\n');

    const next: ControlModel = structuredClone(base);

    const readNumber = (section: string, key: string): number | null => {
      const secRegex = new RegExp(`\\[${section.replace('.', '\\.')}\\]([\\s\\S]*?)(?=\\n\\[|$)`);
      const secMatch = clean.match(secRegex);
      if (!secMatch) return null;
      const keyMatch = secMatch[1].match(new RegExp(`^\\s*${key}\\s*=\\s*([-+eE0-9.]+)`, 'm'));
      if (!keyMatch) return null;
      const val = Number(keyMatch[1]);
      if (Number.isNaN(val)) throw new Error(`Invalid numeric value for ${section}.${key}`);
      return val;
    };

    const readBool = (section: string, key: string): boolean | null => {
      const secRegex = new RegExp(`\\[${section.replace('.', '\\.')}\\]([\\s\\S]*?)(?=\\n\\[|$)`);
      const secMatch = clean.match(secRegex);
      if (!secMatch) return null;
      const keyMatch = secMatch[1].match(new RegExp(`^\\s*${key}\\s*=\\s*(true|false)`, 'm'));
      if (!keyMatch) return null;
      return keyMatch[1] === 'true';
    };

    const readString = (section: string, key: string): string | null => {
      const secRegex = new RegExp(`\\[${section.replace('.', '\\.')}\\]([\\s\\S]*?)(?=\\n\\[|$)`);
      const secMatch = clean.match(secRegex);
      if (!secMatch) return null;
      const keyMatch = secMatch[1].match(new RegExp(`^\\s*${key}\\s*=\\s*"([^"]*)"`, 'm'));
      return keyMatch ? keyMatch[1] : null;
    };

    const readArray = (section: string, key: string): unknown | null => {
      const secRegex = new RegExp(`\\[${section.replace('.', '\\.')}\\]([\\s\\S]*?)(?=\\n\\[|$)`);
      const secMatch = clean.match(secRegex);
      if (!secMatch) return null;
      const keyMatch = secMatch[1].match(new RegExp(`^\\s*${key}\\s*=\\s*(?=\\[)`, 'm'));
      if (!keyMatch || keyMatch.index === undefined) return null;

      const startIdx = keyMatch.index + keyMatch[0].length;
      const slice = secMatch[1];
      let depth = 0;
      let inString = false;
      let escaped = false;
      let endIdx = -1;

      for (let i = startIdx; i < slice.length; i++) {
        const ch = slice[i];
        if (escaped) {
          escaped = false;
          continue;
        }
        if (ch === '\\' && inString) {
          escaped = true;
          continue;
        }
        if (ch === '"') {
          inString = !inString;
          continue;
        }
        if (inString) continue;
        if (ch === '[') depth++;
        else if (ch === ']') {
          depth--;
          if (depth === 0) {
            endIdx = i;
            break;
          }
        }
      }

      if (endIdx < 0) return null;
      return JSON.parse(slice.slice(startIdx, endIdx + 1));
    };

    const modelId = readString('model', 'id');
    if (modelId && modelId.trim()) {
      next.id = modelId.trim();
      if (modelId === 'pendulum' || modelId === 'dcmotor' || modelId === 'buck') {
        next.basePreset = modelId;
      } else if (!next.basePreset) {
        next.basePreset =
          base.id === 'pendulum' || base.id === 'dcmotor' || base.id === 'buck'
            ? base.id
            : base.basePreset ?? 'pendulum';
      }
    }
    const modelName = readString('model', 'name');
    if (modelName && modelName.trim()) next.name = modelName.trim();
    const license = readString('model', 'license');
    if (license === 'MIT' || license === 'Apache-2.0') next.license = license;

    const baseDt = readNumber('model', 'base_dt');
    if (baseDt !== null && baseDt > 0) next.baseDt = baseDt;
    const fastRatio = readNumber('model', 'fast_dt_ratio');
    if (fastRatio !== null && fastRatio >= 1) next.fastDtRatio = Math.round(fastRatio);
    const dur = readNumber('model', 'duration');
    if (dur !== null && dur > 0) next.duration = dur;
    const disc = readString('model', 'discretization');
    if (disc === 'zoh' || disc === 'tustin') next.discretization = disc;

    const nDim = readNumber('plant.state_space', 'n');
    if (nDim !== null && nDim >= 1) next.plant.n = Math.round(nDim);
    const mDim = readNumber('plant.state_space', 'm');
    if (mDim !== null && mDim >= 1) next.plant.m = Math.round(mDim);
    const pDim = readNumber('plant.state_space', 'p');
    if (pDim !== null && pDim >= 1) next.plant.p = Math.round(pDim);

    const stateNames = readArray('plant.state_space', 'states');
    if (Array.isArray(stateNames)) {
      next.plant.stateNames = stateNames.map(String);
    }
    const stateUnits = readArray('plant.state_space', 'state_units');
    if (Array.isArray(stateUnits)) {
      next.plant.stateUnits = stateUnits.map(String);
    }
    const inputNames = readArray('plant.state_space', 'inputs');
    if (Array.isArray(inputNames)) {
      next.plant.inputNames = inputNames.map(String);
    }
    const inputUnits = readArray('plant.state_space', 'input_units');
    if (Array.isArray(inputUnits)) {
      next.plant.inputUnits = inputUnits.map(String);
    }
    const outputNames = readArray('plant.state_space', 'outputs');
    if (Array.isArray(outputNames)) {
      next.plant.outputNames = outputNames.map(String);
    }
    const outputUnits = readArray('plant.state_space', 'output_units');
    if (Array.isArray(outputUnits)) {
      next.plant.outputUnits = outputUnits.map(String);
    }

    const A = readArray('plant.state_space', 'A');
    if (Array.isArray(A)) next.plant.A = A as number[][];
    const B = readArray('plant.state_space', 'B');
    if (Array.isArray(B)) next.plant.B = B as number[][];
    const C = readArray('plant.state_space', 'C');
    if (Array.isArray(C)) next.plant.C = C as number[][];
    const D = readArray('plant.state_space', 'D');
    if (Array.isArray(D)) next.plant.D = D as number[][];
    const x0 = readArray('plant.state_space', 'x0');
    if (Array.isArray(x0)) next.plant.x0 = x0 as number[];

    // Sync inferred dimensions & labels if arrays changed size without explicit n/m/p
    if (Array.isArray(next.plant.A) && next.plant.A.length > 0 && nDim === null) {
      next.plant.n = next.plant.A.length;
    }
    if (
      Array.isArray(next.plant.B) &&
      Array.isArray(next.plant.B[0]) &&
      next.plant.B[0].length > 0 &&
      mDim === null
    ) {
      next.plant.m = next.plant.B[0].length;
    }
    if (Array.isArray(next.plant.C) && next.plant.C.length > 0 && pDim === null) {
      next.plant.p = next.plant.C.length;
    }
    while (next.plant.stateNames.length < next.plant.n) {
      next.plant.stateNames.push(`x_${next.plant.stateNames.length}`);
    }
    next.plant.stateNames = next.plant.stateNames.slice(0, next.plant.n);
    while (next.plant.stateUnits.length < next.plant.n) {
      next.plant.stateUnits.push('u');
    }
    next.plant.stateUnits = next.plant.stateUnits.slice(0, next.plant.n);

    const baseInNames = next.plant.inputNames ?? [next.plant.inputName];
    while (baseInNames.length < next.plant.m) {
      baseInNames.push(`u_${baseInNames.length}`);
    }
    next.plant.inputNames = baseInNames.slice(0, next.plant.m);
    next.plant.inputName = next.plant.inputNames[0] ?? next.plant.inputName;

    const baseInUnits = next.plant.inputUnits ?? [next.plant.inputUnit];
    while (baseInUnits.length < next.plant.m) {
      baseInUnits.push(baseInUnits[0] ?? 'u');
    }
    next.plant.inputUnits = baseInUnits.slice(0, next.plant.m);
    next.plant.inputUnit = next.plant.inputUnits[0] ?? next.plant.inputUnit;

    while (next.plant.outputNames.length < next.plant.p) {
      next.plant.outputNames.push(`y_${next.plant.outputNames.length}`);
    }
    next.plant.outputNames = next.plant.outputNames.slice(0, next.plant.p);
    while (next.plant.outputUnits.length < next.plant.p) {
      next.plant.outputUnits.push('u');
    }
    next.plant.outputUnits = next.plant.outputUnits.slice(0, next.plant.p);

    const K = readArray('controller.lqr', 'K');
    if (Array.isArray(K)) next.lqrK = K as number[];
    const tracks0 = readBool('controller.lqr', 'tracks_ref_state0');
    if (tracks0 !== null) next.lqrTracksRefOnState0 = tracks0;

    const pidEnabled = readBool('controller.pid', 'enabled');
    if (pidEnabled !== null) next.pid.enabled = pidEnabled;
    const pidTargetIdx = readNumber('controller.pid', 'target_output_idx');
    if (pidTargetIdx !== null && pidTargetIdx >= 0) {
      next.pid.targetOutputIndex = Math.min(
        Math.max(0, Math.round(pidTargetIdx)),
        Math.max(0, next.plant.p - 1)
      );
    }
    const pidTracksRef = readBool('controller.pid', 'tracks_step_ref');
    if (pidTracksRef !== null) next.pid.tracksStepRef = pidTracksRef;
    const kp = readNumber('controller.pid', 'kp');
    if (kp !== null) next.pid.kp = kp;
    const ki = readNumber('controller.pid', 'ki');
    if (ki !== null) next.pid.ki = ki;
    const kd = readNumber('controller.pid', 'kd');
    if (kd !== null) next.pid.kd = kd;
    const nFilter = readNumber('controller.pid', 'n_filter');
    if (nFilter !== null) next.pid.nFilter = nFilter;
    const kb = readNumber('controller.pid', 'kb_anti_windup');
    if (kb !== null) next.pid.kbAntiWindup = kb;

    const satMin = readNumber('limits', 'sat_min');
    if (satMin !== null) next.limits.satMin = satMin;
    const satMax = readNumber('limits', 'sat_max');
    if (satMax !== null) next.limits.satMax = satMax;
    const rateLimit = readNumber('limits', 'rate_limit');
    if (rateLimit !== null) next.limits.rateLimit = rateLimit;

    const stepTime = readNumber('reference', 'step_time');
    if (stepTime !== null) next.reference.stepTime = stepTime;
    const initVal = readNumber('reference', 'initial_value');
    if (initVal !== null) next.reference.initialValue = initVal;
    const finalVal = readNumber('reference', 'final_value');
    if (finalVal !== null) next.reference.finalValue = finalVal;
    const distTime = readNumber('reference', 'disturbance_time');
    if (distTime !== null) next.reference.disturbanceTime = distTime;
    const distMag = readNumber('reference', 'disturbance_magnitude');
    if (distMag !== null) next.reference.disturbanceMagnitude = distMag;

    const hilTransport = readString('hil', 'transport');
    if (
      hilTransport === 'uart_cobs' ||
      hilTransport === 'socketcan' ||
      hilTransport === 'udp'
    ) {
      next.hil.transport = hilTransport;
    }
    const hilRate = readString('hil', 'rate');
    if (hilRate) next.hil.baudOrRate = hilRate;
    const wdLimit = readNumber('hil', 'watchdog_miss_limit');
    if (wdLimit !== null && wdLimit >= 1) {
      next.hil.watchdogMissLimit = Math.round(wdLimit);
    }
    const safeClamp = readNumber('hil', 'safe_clamp_value');
    if (safeClamp !== null) next.hil.safeClampValue = safeClamp;

    // Detect if user manually added an algebraic feedback connection in TOML
    next.injectAlgebraicLoopTest = clean.includes('lqr_ctrl.u_lqr') && clean.includes('sum_err.alg_fb');

    return { model: next, parseError: null };
  } catch (err) {
    return {
      model: base,
      parseError: err instanceof Error ? err.message : 'Failed to parse TOML IR syntax.',
    };
  }
}
