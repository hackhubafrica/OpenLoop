import { ControlModel, SimulationTrace } from '../types/control';

export type SvgThemeMode = 'publication' | 'dark';

export interface TraceSvgOptions {
  channel: number | 'effort';
  showMil: boolean;
  showSil: boolean;
  theme?: SvgThemeMode;
}

function escapeXml(raw: string): string {
  return raw
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function formatTickValue(val: number): string {
  if (Math.abs(val) < 1e-10) return '0.00';
  if (Math.abs(val) < 0.01 || Math.abs(val) >= 1000) {
    return val.toExponential(1);
  }
  return val.toFixed(2);
}

/**
 * Builds a clean, standalone, publication-ready vector SVG string of the active
 * Workbench simulation trace (MIL RK4, SIL discrete, reference, or actuator effort).
 */
export function generateTraceSvgString(
  model: ControlModel,
  trace: SimulationTrace,
  options: TraceSvgOptions
): string {
  const { channel, showMil, showSil, theme = 'publication' } = options;
  const isPub = theme === 'publication';

  const palette = isPub
    ? {
        bg: '#FFFFFF',
        plotBg: '#F8FAFC',
        border: '#CBD5E1',
        gridMajor: '#E2E8F0',
        gridMinor: '#F1F5F9',
        title: '#0F172A',
        subtitle: '#475569',
        axisText: '#334155',
        axisTitle: '#0F172A',
        ref: '#64748B',
        mil: '#0284C7',
        sil: '#D97706',
        limit: '#DC2626',
        footerBg: '#F8FAFC',
      }
    : {
        bg: '#07090E',
        plotBg: '#0B0E17',
        border: '#334155',
        gridMajor: '#1E293B',
        gridMinor: '#151D2B',
        title: '#F8FAFC',
        subtitle: '#94A3B8',
        axisText: '#94A3B8',
        axisTitle: '#CBD5E1',
        ref: '#64748B',
        mil: '#06B6D4',
        sil: '#F59E0B',
        limit: '#F43F5E',
        footerBg: '#0F141E',
      };

  const isEffort = channel === 'effort';
  const activeOutputIdx =
    channel === 'effort' ? 0 : Math.min(Math.max(0, channel), Math.max(0, model.plant.p - 1));

  const samples = trace.samples;
  const channelName = isEffort
    ? `${model.plant.inputName} (Actuator Effort)`
    : model.plant.outputNames[activeOutputIdx] ?? `y_${activeOutputIdx}`;
  const unitLabel = isEffort
    ? model.plant.inputUnit
    : model.plant.outputUnits[activeOutputIdx] ?? '';
  const unitSuffix = unitLabel ? ` [${unitLabel}]` : '';

  const width = 960;
  const height = 420;
  const padL = 74;
  const padR = 28;
  const padT = 78;
  const padB = 74;
  const plotW = width - padL - padR;
  const plotH = height - padT - padB;

  let minV = Infinity;
  let maxV = -Infinity;

  const extractSample = (idx: number) => {
    const s = samples[idx];
    if (!isEffort) {
      const ref =
        activeOutputIdx === 0
          ? s.ref
          : activeOutputIdx === 1 && model.id === 'pendulum'
          ? 0
          : null;
      return {
        mil: s.milOutputs[activeOutputIdx] ?? 0,
        sil: s.silOutputs[activeOutputIdx] ?? 0,
        ref,
      };
    }
    return {
      mil: s.uRaw,
      sil: s.uSat,
      ref: null as number | null,
    };
  };

  for (let i = 0; i < samples.length; i++) {
    const { mil, sil, ref } = extractSample(i);
    if (showMil) {
      minV = Math.min(minV, mil);
      maxV = Math.max(maxV, mil);
    }
    if (showSil) {
      minV = Math.min(minV, sil);
      maxV = Math.max(maxV, sil);
    }
    if (ref !== null) {
      minV = Math.min(minV, ref);
      maxV = Math.max(maxV, ref);
    }
  }

  if (isEffort) {
    minV = Math.min(minV, model.limits.satMin);
    maxV = Math.max(maxV, model.limits.satMax);
  }

  if (!Number.isFinite(minV) || !Number.isFinite(maxV)) {
    minV = -1;
    maxV = 1;
  }

  const span = Math.max(1e-4, maxV - minV);
  const yLo = minV - span * 0.12;
  const yHi = maxV + span * 0.12;

  const toX = (i: number) =>
    padL + (samples.length > 1 ? (i / (samples.length - 1)) * plotW : 0);
  const toY = (v: number) =>
    padT + (1 - (v - yLo) / Math.max(1e-9, yHi - yLo)) * plotH;

  let milPath = '';
  let silPath = '';
  let refPath = '';

  for (let i = 0; i < samples.length; i++) {
    const { mil, sil, ref } = extractSample(i);
    const x = toX(i).toFixed(2);
    if (showMil) {
      milPath += `${milPath ? ' L' : 'M'} ${x} ${toY(mil).toFixed(2)}`;
    }
    if (showSil) {
      silPath += `${silPath ? ' L' : 'M'} ${x} ${toY(sil).toFixed(2)}`;
    }
    if (ref !== null) {
      refPath += `${refPath ? ' L' : 'M'} ${x} ${toY(ref).toFixed(2)}`;
    }
  }

  const xFracs = [0, 0.25, 0.5, 0.75, 1];
  const yFracs = [0, 0.25, 0.5, 0.75, 1];
  const fontSans = 'IBM Plex Sans, Inter, Helvetica Neue, Arial, sans-serif';
  const fontMono = 'IBM Plex Mono, JetBrains Mono, Consolas, monospace';

  const lines: string[] = [];
  lines.push('<?xml version="1.0" encoding="UTF-8"?>');
  lines.push(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="${escapeXml(
      `${model.name} - ${channelName} Simulation Trace`
    )}">`
  );
  lines.push(`  <rect x="0" y="0" width="${width}" height="${height}" fill="${palette.bg}" />`);

  // Header metadata
  lines.push(
    `  <text x="${padL}" y="28" fill="${palette.title}" font-family="${fontSans}" font-size="15" font-weight="600">${escapeXml(
      model.name
    )} — ${escapeXml(channelName)}</text>`
  );
  lines.push(
    `  <text x="${padL}" y="47" fill="${palette.subtitle}" font-family="${fontMono}" font-size="11">${escapeXml(
      `dt=${model.baseDt}s (${Math.round(1 / Math.max(1e-6, model.baseDt))} Hz) · Discretization=${model.discretization.toUpperCase()} · Duration=${model.duration}s · States n=${model.plant.n}`
    )}</text>`
  );

  // Top-right vector legend
  const legendItems: Array<{ label: string; color: string; dash?: string }> = [];
  if (refPath) legendItems.push({ label: 'Reference', color: palette.ref, dash: '5 4' });
  if (showMil && milPath)
    legendItems.push({ label: isEffort ? 'u_raw' : 'MIL (RK4)', color: palette.mil });
  if (showSil && silPath)
    legendItems.push({
      label: isEffort ? 'u_sat' : `SIL (${model.discretization.toUpperCase()})`,
      color: palette.sil,
      dash: isEffort ? undefined : '6 3',
    });

  let legendCursorX = width - padR;
  for (let i = legendItems.length - 1; i >= 0; i--) {
    const item = legendItems[i];
    const estTextW = item.label.length * 6.8 + 28;
    legendCursorX -= estTextW;
    lines.push(
      `  <line x1="${legendCursorX}" y1="62" x2="${legendCursorX + 18}" y2="62" stroke="${item.color}" stroke-width="2.2"${
        item.dash ? ` stroke-dasharray="${item.dash}"` : ''
      } />`
    );
    lines.push(
      `  <text x="${legendCursorX + 24}" y="66" fill="${palette.axisText}" font-family="${fontMono}" font-size="10.5">${escapeXml(
        item.label
      )}</text>`
    );
  }

  // Plot frame background & clipPath
  lines.push('  <defs>');
  lines.push(
    `    <clipPath id="trace-plot-clip"><rect x="${padL}" y="${padT}" width="${plotW}" height="${plotH}" /></clipPath>`
  );
  lines.push('  </defs>');
  lines.push(
    `  <rect x="${padL}" y="${padT}" width="${plotW}" height="${plotH}" fill="${palette.plotBg}" stroke="${palette.border}" stroke-width="1" />`
  );

  // Horizontal Y grid lines & tick labels
  for (const frac of yFracs) {
    const y = padT + frac * plotH;
    const val = yHi - frac * (yHi - yLo);
    lines.push(
      `  <line x1="${padL}" y1="${y.toFixed(1)}" x2="${width - padR}" y2="${y.toFixed(
        1
      )}" stroke="${palette.gridMajor}" stroke-width="1" />`
    );
    lines.push(
      `  <text x="${padL - 9}" y="${(y + 3.5).toFixed(
        1
      )}" text-anchor="end" fill="${palette.axisText}" font-family="${fontMono}" font-size="10.5">${formatTickValue(
        val
      )}</text>`
    );
  }

  // Vertical time grid lines & tick labels
  for (const frac of xFracs) {
    const x = padL + frac * plotW;
    const tVal = frac * model.duration;
    lines.push(
      `  <line x1="${x.toFixed(1)}" y1="${padT}" x2="${x.toFixed(1)}" y2="${
        padT + plotH
      }" stroke="${palette.gridMinor}" stroke-width="1" />`
    );
    lines.push(
      `  <text x="${x.toFixed(1)}" y="${
        padT + plotH + 17
      }" text-anchor="middle" fill="${palette.axisText}" font-family="${fontMono}" font-size="10.5">${tVal.toFixed(
        model.duration < 0.1 ? 4 : 2
      )}s</text>`
    );
  }

  // Zero baseline inside plot
  if (yLo <= 0 && yHi >= 0) {
    const yZero = toY(0).toFixed(1);
    lines.push(
      `  <line x1="${padL}" y1="${yZero}" x2="${width - padR}" y2="${yZero}" stroke="${
        palette.border
      }" stroke-width="1" stroke-dasharray="2 3" />`
    );
  }

  // Vector curves group clipped to plot box
  lines.push('  <g clip-path="url(#trace-plot-clip)">');

  if (isEffort) {
    const ySatMax = toY(model.limits.satMax).toFixed(1);
    const ySatMin = toY(model.limits.satMin).toFixed(1);
    lines.push(
      `    <line x1="${padL}" y1="${ySatMax}" x2="${width - padR}" y2="${ySatMax}" stroke="${palette.limit}" stroke-opacity="0.7" stroke-width="1.2" stroke-dasharray="5 3" />`
    );
    lines.push(
      `    <line x1="${padL}" y1="${ySatMin}" x2="${width - padR}" y2="${ySatMin}" stroke="${palette.limit}" stroke-opacity="0.7" stroke-width="1.2" stroke-dasharray="5 3" />`
    );
  }

  if (refPath) {
    lines.push(
      `    <path d="${refPath}" fill="none" stroke="${palette.ref}" stroke-width="1.4" stroke-dasharray="5 4" />`
    );
  }
  if (showMil && milPath) {
    lines.push(
      `    <path d="${milPath}" fill="none" stroke="${palette.mil}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" />`
    );
  }
  if (showSil && silPath) {
    lines.push(
      `    <path d="${silPath}" fill="none" stroke="${palette.sil}" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"${
        isEffort ? '' : ' stroke-dasharray="6 3"'
      } />`
    );
  }
  lines.push('  </g>');

  // Axis Titles
  const yCenter = padT + plotH / 2;
  lines.push(
    `  <text x="18" y="${yCenter.toFixed(
      1
    )}" transform="rotate(-90 18 ${yCenter.toFixed(
      1
    )})" text-anchor="middle" fill="${palette.axisTitle}" font-family="${fontSans}" font-size="11.5" font-weight="500">${escapeXml(
      `${channelName}${unitSuffix}`
    )}</text>`
  );
  lines.push(
    `  <text x="${(padL + plotW / 2).toFixed(1)}" y="${
      padT + plotH + 35
    }" text-anchor="middle" fill="${palette.axisTitle}" font-family="${fontSans}" font-size="11.5" font-weight="500">Time t (s)</text>`
  );

  // Bottom Quantitative Telemetry Summary Bar
  const settlingLabel =
    trace.metrics.settlingTimeSec !== null
      ? `${trace.metrics.settlingTimeSec.toFixed(3)}s`
      : 'Unsettled';
  const summaryText = `RMS Error: ${trace.metrics.rmsError.toFixed(
    4
  )}   |   Overshoot: ${trace.metrics.peakOvershootPct.toFixed(
    2
  )}%   |   Settling (2%): ${settlingLabel}   |   Peak Effort: ${trace.metrics.peakEffort.toFixed(
    2
  )} ${model.plant.inputUnit}   |   ρ(Ad): ${trace.discrete.spectralRadius.toFixed(5)}`;

  lines.push(
    `  <rect x="${padL}" y="${height - 28}" width="${plotW}" height="22" rx="3" fill="${palette.footerBg}" stroke="${palette.border}" stroke-width="0.75" />`
  );
  lines.push(
    `  <text x="${padL + 10}" y="${height - 13.5}" fill="${palette.subtitle}" font-family="${fontMono}" font-size="10">${escapeXml(
      summaryText
    )}</text>`
  );

  lines.push('</svg>');
  return lines.join('\n') + '\n';
}

export function exportTraceAsSvg(
  model: ControlModel,
  trace: SimulationTrace,
  options: TraceSvgOptions
): string {
  const svgContent = generateTraceSvgString(model, trace, options);
  const safeId = (model.id || 'openloop_model').replace(/[^a-z0-9_-]+/gi, '_');
  const chSlug =
    options.channel === 'effort'
      ? 'effort_u'
      : `y${options.channel}`;
  const themeSuffix = options.theme ?? 'publication';
  const filename = `openloop-${safeId}-${chSlug}-${themeSuffix}.svg`;

  const blob = new Blob([svgContent], { type: 'image/svg+xml;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);

  return filename;
}
