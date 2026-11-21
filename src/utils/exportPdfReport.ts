import { jsPDF } from 'jspdf';
import { ControlModel } from '../types/control';
import {
  analyzeSystemStability,
  ComplexPoleZero,
  computePoleZeroStabilitySummary,
  computeRootLocus,
  generateLatexStabilityReport,
  RootLocusAnalysis,
  StabilityVerdict,
  stateSpaceToTransferFunction,
} from '../engine/stability';
import { formatPolynomial } from '../engine/transferFunction';

export interface PdfReportOptions {
  model: ControlModel;
  scope?: 'open' | 'closed';
  outputIndex?: number;
  inputIndex?: number;
  rootLocus?: RootLocusAnalysis | null;
}

export interface BuiltPdfReport {
  doc: jsPDF;
  bytes: Uint8Array;
  filename: string;
}

function sanitizePdfText(text: string): string {
  return text
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/\u2212/g, '-')
    .replace(/\u00d7/g, 'x')
    .replace(/\u2192/g, '->')
    .replace(/\u2208/g, 'in')
    .replace(/\u221e/g, 'inf')
    .replace(/\u03b6/g, 'zeta')
    .replace(/\u03c9/g, 'omega')
    .replace(/\u03bb/g, 'lambda')
    .replace(/\u03c3/g, 'sigma')
    .replace(/\u03b8/g, 'theta')
    .replace(/\u00b7/g, '|')
    .replace(/[^\x20-\x7e\u00b0\u00b1]/g, '');
}

function formatComplexAscii(p: ComplexPoleZero): string {
  const sign = p.im >= 0 ? '+' : '-';
  return Math.abs(p.im) < 1e-6
    ? p.re.toFixed(4)
    : `${p.re.toFixed(3)} ${sign} j*${Math.abs(p.im).toFixed(3)}`;
}

function verdictRgb(verdict: StabilityVerdict): [number, number, number] {
  if (verdict === 'STABLE') return [5, 150, 105];
  if (verdict === 'MARGINAL') return [217, 119, 6];
  return [225, 29, 72];
}

function clipSegmentToRect(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  xmin: number,
  ymin: number,
  xmax: number,
  ymax: number
): [number, number, number, number] | null {
  let t0 = 0;
  let t1 = 1;
  const dx = x1 - x0;
  const dy = y1 - y0;
  const p = [-dx, dx, -dy, dy];
  const q = [x0 - xmin, xmax - x0, y0 - ymin, ymax - y0];

  for (let i = 0; i < 4; i++) {
    if (Math.abs(p[i]) < 1e-12) {
      if (q[i] < 0) return null;
    } else {
      const t = q[i] / p[i];
      if (p[i] < 0) {
        if (t > t1) return null;
        if (t > t0) t0 = t;
      } else {
        if (t < t0) return null;
        if (t < t1) t1 = t;
      }
    }
  }

  return [x0 + t0 * dx, y0 + t0 * dy, x0 + t1 * dx, y0 + t1 * dy];
}

function niceTicks(min: number, max: number, approxCount: number): number[] {
  const span = Math.max(1e-9, max - min);
  const rawStep = span / Math.max(2, approxCount);
  const mag = Math.pow(10, Math.floor(Math.log10(rawStep)));
  const norm = rawStep / mag;
  const niceStep =
    (norm <= 1.5 ? 1 : norm <= 3 ? 2 : norm <= 7 ? 5 : 10) * mag;
  const start = Math.ceil(min / niceStep) * niceStep;
  const ticks: number[] = [];
  for (let v = start; v <= max + 1e-9 * span; v += niceStep) {
    ticks.push(Math.abs(v) < 1e-11 ? 0 : Number(v.toPrecision(6)));
  }
  return ticks;
}

const LOCUS_BRANCH_RGB: [number, number, number][] = [
  [2, 132, 199],
  [124, 58, 237],
  [5, 150, 105],
  [217, 119, 6],
  [219, 39, 119],
  [37, 99, 235],
];

export function buildSystemAnalysisPdf({
  model,
  scope = 'closed',
  outputIndex = model.pid.targetOutputIndex,
  inputIndex = 0,
  rootLocus = null,
}: PdfReportOptions): BuiltPdfReport {
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  const pageW = 210;
  const pageH = 297;
  const margin = 14;
  const contentW = pageW - margin * 2;

  const analysis = analyzeSystemStability(model, outputIndex, inputIndex);
  const openSummary = computePoleZeroStabilitySummary(
    model,
    'open',
    outputIndex,
    inputIndex
  );
  const closedSummary = computePoleZeroStabilitySummary(
    model,
    'closed',
    outputIndex,
    inputIndex
  );
  const activeSummary = scope === 'closed' ? closedSummary : openSummary;
  const activeRootLocus =
    rootLocus ?? computeRootLocus(model, outputIndex, inputIndex, 60);
  const tf = stateSpaceToTransferFunction(model.plant, outputIndex, inputIndex);
  const latexSnippet = generateLatexStabilityReport(
    model,
    outputIndex,
    inputIndex
  );

  // Header Banner
  doc.setFillColor(15, 20, 30);
  doc.rect(0, 0, pageW, 28, 'F');

  doc.setTextColor(6, 182, 212);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(8.5);
  doc.text('OPENLOOP CONTROL SYSTEMS WORKBENCH · STABILITY & DESIGN REPORT', margin, 9);

  doc.setTextColor(248, 250, 252);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(13.5);
  doc.text(sanitizePdfText(model.name), margin, 16.5, { maxWidth: contentW });

  doc.setTextColor(148, 163, 184);
  doc.setFont('courier', 'normal');
  doc.setFontSize(8);
  const metaLine = `States n=${model.plant.n} | Inputs m=${model.plant.m} | Outputs p=${model.plant.p} | dt=${model.baseDt} s (${Math.round(1 / model.baseDt)} Hz) | ${model.discretization.toUpperCase()} | Channel u[${inputIndex}] -> y[${outputIndex}]`;
  doc.text(sanitizePdfText(metaLine), margin, 23);

  let y = 35;

  // Section 1: Stability Metrics Panel
  doc.setTextColor(15, 23, 42);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10.5);
  doc.text('1. Stability Metrics Panel (Pole-Zero Derived)', margin, y);
  doc.setFont('courier', 'normal');
  doc.setFontSize(8);
  doc.setTextColor(100, 116, 139);
  doc.text(
    `Active View: ${scope === 'closed' ? 'Closed-Loop (Acl)' : 'Open-Loop (A)'}`,
    pageW - margin,
    y,
    { align: 'right' }
  );
  y += 3;

  // 4 KPI Cards Row
  const cardGap = 3;
  const cardW = (contentW - cardGap * 3) / 4;
  const cardH = 17;

  const kpiCards = [
    {
      label: 'OPEN-LOOP VERDICT',
      value: analysis.openLoopVerdict,
      sub: `max Re = ${analysis.maxRealPartOpen.toFixed(3)}`,
      rgb: verdictRgb(analysis.openLoopVerdict),
    },
    {
      label: 'CLOSED-LOOP VERDICT',
      value: analysis.closedLoopVerdict,
      sub: `max Re = ${analysis.maxRealPartClosed.toFixed(3)}`,
      rgb: verdictRgb(analysis.closedLoopVerdict),
    },
    {
      label: `DAMPING RATIO (${scope === 'closed' ? 'CL' : 'OL'})`,
      value:
        activeSummary.dampingRatio !== null
          ? activeSummary.dampingRatio.toFixed(4)
          : '---',
      sub: sanitizePdfText(activeSummary.dampingRegime),
      rgb: [15, 23, 42] as [number, number, number],
    },
    {
      label: `NATURAL FREQ (${scope === 'closed' ? 'CL' : 'OL'})`,
      value:
        activeSummary.naturalFreqRad !== null
          ? `${activeSummary.naturalFreqRad.toFixed(2)} rad/s`
          : '---',
      sub:
        activeSummary.naturalFreqHz !== null
          ? `${activeSummary.naturalFreqHz.toFixed(2)} Hz`
          : 'Origin pole',
      rgb: [2, 132, 199] as [number, number, number],
    },
  ];

  kpiCards.forEach((card, idx) => {
    const cx = margin + idx * (cardW + cardGap);
    doc.setFillColor(248, 250, 252);
    doc.setDrawColor(203, 213, 225);
    doc.setLineWidth(0.25);
    doc.rect(cx, y, cardW, cardH, 'FD');

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(6.5);
    doc.setTextColor(100, 116, 139);
    doc.text(card.label, cx + 2.5, y + 4.5);

    doc.setFont('courier', 'bold');
    doc.setFontSize(10);
    doc.setTextColor(card.rgb[0], card.rgb[1], card.rgb[2]);
    doc.text(card.value, cx + 2.5, y + 10.2);

    doc.setFont('courier', 'normal');
    doc.setFontSize(7);
    doc.setTextColor(71, 85, 105);
    doc.text(card.sub, cx + 2.5, y + 14.5, { maxWidth: cardW - 5 });
  });
  y += cardH + 3;

  // Detailed Metrics Summary Table (Margins, Discrete, PID)
  const metricRows: [string, string, string, string][] = [
    [
      'Dominant Pole (CL)',
      closedSummary.dominantPole
        ? formatComplexAscii(closedSummary.dominantPole)
        : '---',
      'Dominant Pole (OL)',
      openSummary.dominantPole ? formatComplexAscii(openSummary.dominantPole) : '---',
    ],
    [
      'Gain Margin (GM)',
      activeSummary.gainMarginDb !== null
        ? `${activeSummary.gainMarginDb.toFixed(2)} dB${activeSummary.phaseCrossoverOmega !== null ? ` @ ${activeSummary.phaseCrossoverOmega.toFixed(2)} rad/s` : ''}`
        : 'inf dB (No -180 deg cross)',
      'Phase Margin (PM)',
      activeSummary.phaseMarginDeg !== null
        ? `${activeSummary.phaseMarginDeg.toFixed(1)} deg${activeSummary.gainCrossoverOmega !== null ? ` @ ${activeSummary.gainCrossoverOmega.toFixed(2)} rad/s` : ''}`
        : 'No 0 dB crossing',
    ],
    [
      'Discrete Radius max|z|',
      `${analysis.maxDiscreteMag.toFixed(5)} (${analysis.discreteVerdict})`,
      'PID Gains (y[' + model.pid.targetOutputIndex + '])',
      model.pid.enabled
        ? `Kp=${model.pid.kp}, Ki=${model.pid.ki}, Kd=${model.pid.kd}, N=${model.pid.nFilter}`
        : 'BYPASSED',
    ],
  ];

  if (activeRootLocus.jwCrossings.length > 0) {
    metricRows.push([
      'Root Locus j*w Crossing',
      activeRootLocus.jwCrossings
        .map((c) => `K_crit=${c.gainK.toFixed(2)} (w=${c.omega.toFixed(2)})`)
        .join(', '),
      'Asymptotes (centroid)',
      activeRootLocus.asymptoteCentroid !== null
        ? `sigma_a=${activeRootLocus.asymptoteCentroid.toFixed(2)}`
        : 'None',
    ]);
  }

  const rowH = 5.6;
  const colWidths = [38, 53, 38, 53];
  doc.setDrawColor(203, 213, 225);
  doc.setLineWidth(0.2);
  metricRows.forEach((row, rIdx) => {
    const ry = y + rIdx * rowH;
    doc.setFillColor(rIdx % 2 === 0 ? 255 : 248, rIdx % 2 === 0 ? 255 : 250, rIdx % 2 === 0 ? 255 : 252);
    doc.rect(margin, ry, contentW, rowH, 'FD');

    let cx = margin;
    row.forEach((cell, cIdx) => {
      const isLabel = cIdx === 0 || cIdx === 2;
      doc.setFont(isLabel ? 'helvetica' : 'courier', isLabel ? 'bold' : 'normal');
      doc.setFontSize(7.3);
      doc.setTextColor(isLabel ? 71 : 15, isLabel ? 85 : 23, isLabel ? 105 : 42);
      doc.text(sanitizePdfText(cell), cx + 2, ry + 3.9, {
        maxWidth: colWidths[cIdx] - 3,
      });
      cx += colWidths[cIdx];
      if (cIdx < 3) {
        doc.line(cx, ry, cx, ry + rowH);
      }
    });
  });

  y += metricRows.length * rowH + 7;

  // Section 2: s-Plane Pole-Zero Vector Visualization
  doc.setTextColor(15, 23, 42);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10.5);
  doc.text('2. s-Plane Pole-Zero Visualization', margin, y);
  doc.setFont('courier', 'normal');
  doc.setFontSize(7.5);
  doc.setTextColor(100, 116, 139);
  doc.text(
    `Im(s) vs Re(s) · ${scope === 'closed' ? 'Closed-Loop Poles + Plant/PID Zeros' : 'Open-Loop Poles + Plant Zeros'}`,
    pageW - margin,
    y,
    { align: 'right' }
  );
  y += 3;

  const boxX = margin;
  const boxY = y;
  const boxW = contentW;
  const boxH = 82;

  doc.setFillColor(255, 255, 255);
  doc.setDrawColor(148, 163, 184);
  doc.setLineWidth(0.3);
  doc.rect(boxX, boxY, boxW, boxH, 'FD');

  const padL = 14;
  const padR = 6;
  const padT = 6;
  const padB = 9;
  const plotX = boxX + padL;
  const plotY = boxY + padT;
  const plotW = boxW - padL - padR;
  const plotH = boxH - padT - padB;

  const plottedPoles =
    scope === 'closed' ? analysis.closedLoopPoles : analysis.openLoopPoles;
  const plottedZeros =
    scope === 'closed'
      ? [...analysis.plantZeros, ...analysis.pidZeros]
      : analysis.plantZeros;
  const showLocusInPdf = Boolean(rootLocus && rootLocus.branches.length > 0 && scope === 'open');
  const locusPts = showLocusInPdf && rootLocus
    ? rootLocus.branches.flatMap((b) => b.points)
    : [];

  const allReals = [
    0,
    ...plottedPoles.map((p) => p.re),
    ...plottedZeros.map((z) => z.re),
    ...locusPts.map((pt) => pt.re),
  ];
  const allImags = [
    ...plottedPoles.map((p) => Math.abs(p.im)),
    ...plottedZeros.map((z) => Math.abs(z.im)),
    ...locusPts.map((pt) => Math.abs(pt.im)),
  ];

  const minRe = Math.min(-2, ...allReals);
  const maxRe = Math.max(1, ...allReals);
  const spanRe = Math.max(2, maxRe - minRe);
  const xMin = minRe - spanRe * 0.14;
  const xMax = maxRe + spanRe * 0.14;

  const maxIm = Math.max(1.5, ...allImags);
  const yMax = maxIm * 1.2;
  const yMin = -yMax;

  const toPxX = (re: number) => plotX + ((re - xMin) / (xMax - xMin)) * plotW;
  const toPxY = (im: number) => plotY + plotH - ((im - yMin) / (yMax - yMin)) * plotH;

  const originPxX = toPxX(0);
  const originPxY = toPxY(0);

  // RHP Unstable shading (Re > 0)
  if (originPxX < plotX + plotW) {
    const rhpLeft = Math.max(plotX, originPxX);
    doc.setFillColor(255, 241, 242);
    doc.rect(rhpLeft, plotY, plotX + plotW - rhpLeft, plotH, 'F');
  }

  // Grid lines & ticks
  const xTicks = niceTicks(xMin, xMax, 7);
  const yTicks = niceTicks(yMin, yMax, 5);

  doc.setDrawColor(226, 232, 240);
  doc.setLineWidth(0.18);
  for (const xt of xTicks) {
    const gx = toPxX(xt);
    if (gx >= plotX && gx <= plotX + plotW) {
      doc.line(gx, plotY, gx, plotY + plotH);
      doc.setFont('courier', 'normal');
      doc.setFontSize(6.5);
      doc.setTextColor(100, 116, 139);
      doc.text(String(xt), gx, plotY + plotH + 3.6, { align: 'center' });
    }
  }
  for (const yt of yTicks) {
    const gy = toPxY(yt);
    if (gy >= plotY && gy <= plotY + plotH) {
      doc.line(plotX, gy, plotX + plotW, gy);
      doc.setFont('courier', 'normal');
      doc.setFontSize(6.5);
      doc.setTextColor(100, 116, 139);
      doc.text(String(yt), plotX - 1.5, gy + 1, { align: 'right' });
    }
  }

  // Constant damping guide rays (zeta = 0.5, 0.707)
  doc.setDrawColor(148, 163, 184);
  doc.setLineWidth(0.22);
  doc.setLineDashPattern([1.2, 1.8], 0);
  const rayLen = Math.max(Math.abs(xMin), yMax) * 1.6;
  for (const zeta of [0.5, 0.707]) {
    const angle = Math.acos(zeta);
    const endRe = -rayLen * Math.cos(angle);
    const endIm = rayLen * Math.sin(angle);
    for (const sgn of [1, -1]) {
      const clipped = clipSegmentToRect(
        originPxX,
        originPxY,
        toPxX(endRe),
        toPxY(sgn * endIm),
        plotX,
        plotY,
        plotX + plotW,
        plotY + plotH
      );
      if (clipped) {
        doc.line(clipped[0], clipped[1], clipped[2], clipped[3]);
      }
    }
  }

  // Real axis
  doc.setLineDashPattern([], 0);
  doc.setDrawColor(100, 116, 139);
  doc.setLineWidth(0.3);
  if (originPxY >= plotY && originPxY <= plotY + plotH) {
    doc.line(plotX, originPxY, plotX + plotW, originPxY);
  }

  // Imaginary axis (stability boundary)
  doc.setDrawColor(225, 29, 72);
  doc.setLineWidth(0.35);
  doc.setLineDashPattern([1.8, 1.4], 0);
  if (originPxX >= plotX && originPxX <= plotX + plotW) {
    doc.line(originPxX, plotY, originPxX, plotY + plotH);
  }
  doc.setLineDashPattern([], 0);

  // RHP label
  if (originPxX < plotX + plotW - 22) {
    doc.setFont('courier', 'bold');
    doc.setFontSize(6.5);
    doc.setTextColor(225, 29, 72);
    doc.text('RHP Unstable (Re > 0)', Math.max(plotX + 2, originPxX + 2), plotY + 4);
  }

  // Root locus trajectories if active
  if (showLocusInPdf && rootLocus) {
    doc.setLineWidth(0.45);
    rootLocus.branches.forEach((branch, bIdx) => {
      const rgb = LOCUS_BRANCH_RGB[bIdx % LOCUS_BRANCH_RGB.length];
      doc.setDrawColor(rgb[0], rgb[1], rgb[2]);
      for (let i = 1; i < branch.points.length; i++) {
        const p0 = branch.points[i - 1];
        const p1 = branch.points[i];
        const clipped = clipSegmentToRect(
          toPxX(p0.re),
          toPxY(p0.im),
          toPxX(p1.re),
          toPxY(p1.im),
          plotX,
          plotY,
          plotX + plotW,
          plotY + plotH
        );
        if (clipped) {
          doc.line(clipped[0], clipped[1], clipped[2], clipped[3]);
        }
      }
    });
  }

  // Faint open-loop pole ghosts when in closed-loop view
  if (scope === 'closed') {
    doc.setDrawColor(148, 163, 184);
    doc.setLineWidth(0.35);
    for (const p of analysis.openLoopPoles) {
      const cx = toPxX(p.re);
      const cy = toPxY(p.im);
      if (cx < plotX || cx > plotX + plotW || cy < plotY || cy > plotY + plotH) continue;
      const r = 1.3;
      doc.line(cx - r, cy - r, cx + r, cy + r);
      doc.line(cx - r, cy + r, cx + r, cy - r);
    }
  }

  // Zeros (O)
  doc.setLineWidth(0.48);
  for (const z of plottedZeros) {
    const cx = toPxX(z.re);
    const cy = toPxY(z.im);
    if (cx < plotX || cx > plotX + plotW || cy < plotY || cy > plotY + plotH) continue;
    if (z.source === 'pid') {
      doc.setDrawColor(124, 58, 237);
    } else {
      doc.setDrawColor(217, 119, 6);
    }
    doc.circle(cx, cy, 1.65, 'S');
  }

  // Poles (X)
  doc.setLineWidth(0.58);
  for (const p of plottedPoles) {
    const cx = toPxX(p.re);
    const cy = toPxY(p.im);
    if (cx < plotX || cx > plotX + plotW || cy < plotY || cy > plotY + plotH) continue;
    if (p.stable) {
      doc.setDrawColor(8, 145, 178);
    } else if (p.marginal) {
      doc.setDrawColor(217, 119, 6);
    } else {
      doc.setDrawColor(225, 29, 72);
    }
    const r = 1.65;
    doc.line(cx - r, cy - r, cx + r, cy + r);
    doc.line(cx - r, cy + r, cx + r, cy - r);
  }

  // Plot frame border & axis labels
  doc.setDrawColor(148, 163, 184);
  doc.setLineWidth(0.25);
  doc.rect(plotX, plotY, plotW, plotH, 'S');

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(7);
  doc.setTextColor(71, 85, 105);
  doc.text('Re(s)', plotX + plotW / 2, boxY + boxH - 1.5, { align: 'center' });
  doc.text('Im(s)', boxX + 2, plotY + 4);

  // Legend below plot
  y = boxY + boxH + 4;
  doc.setFont('courier', 'normal');
  doc.setFontSize(7);
  doc.setTextColor(71, 85, 105);
  const legendItems = [
    'x Pole (Cyan=LHP, Amber=Margin, Rose=RHP)',
    'o Plant Zero (Amber)',
    ...(scope === 'closed' && analysis.pidZeros.length > 0
      ? ['o PID Zero (Violet)']
      : []),
    ...(scope === 'closed' ? ['x Open-Loop Ref (Gray)'] : []),
    ...(showLocusInPdf ? ['-- Root Locus'] : []),
    'Dashed rays: zeta = 0.5, 0.707',
  ];
  doc.text(legendItems.join('   |   '), margin, y);
  y += 6;

  // Compact Pole-Zero Table on Page 1 (overflows cleanly if long)
  const ensureSpace = (neededMm: number) => {
    if (y + neededMm > pageH - 16) {
      doc.addPage();
      y = 16;
    }
  };

  ensureSpace(18);
  doc.setTextColor(15, 23, 42);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(9.5);
  doc.text(
    `Pole & Zero Coordinates (${scope === 'closed' ? 'Closed-Loop' : 'Open-Loop'})`,
    margin,
    y
  );
  y += 2.5;

  const pzRows: {
    type: string;
    coord: string;
    wn: string;
    zeta: string;
    status: string;
    color: [number, number, number];
  }[] = [
    ...plottedPoles.map((p, idx) => ({
      type: `x Pole p${idx + 1}`,
      coord: formatComplexAscii(p),
      wn: p.naturalFreqRad.toFixed(3),
      zeta: p.dampingRatio !== null ? p.dampingRatio.toFixed(3) : '---',
      status: p.stable ? 'LHP Stable' : p.marginal ? 'Marginal' : 'RHP Unstable',
      color: p.stable
        ? ([8, 145, 178] as [number, number, number])
        : p.marginal
        ? ([217, 119, 6] as [number, number, number])
        : ([225, 29, 72] as [number, number, number]),
    })),
    ...plottedZeros.map((z, idx) => ({
      type: `o ${z.source === 'pid' ? 'PID Zero' : 'Plant Zero'} z${idx + 1}`,
      coord: formatComplexAscii(z),
      wn: z.naturalFreqRad.toFixed(3),
      zeta: z.dampingRatio !== null ? z.dampingRatio.toFixed(3) : '---',
      status: z.re < 0 ? 'Minimum-Phase' : z.re > 0 ? 'Non-Min-Phase' : 'Origin/Imag',
      color:
        z.source === 'pid'
          ? ([124, 58, 237] as [number, number, number])
          : ([217, 119, 6] as [number, number, number]),
    })),
  ];

  const pzColW = [38, 52, 28, 28, 36];
  const pzRowH = 5.2;

  const drawPzHeader = () => {
    doc.setFillColor(241, 245, 249);
    doc.setDrawColor(203, 213, 225);
    doc.setLineWidth(0.2);
    doc.rect(margin, y, contentW, pzRowH, 'FD');
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(7.2);
    doc.setTextColor(51, 65, 85);
    const headers = ['Type', 'Coordinate (s-plane)', 'omega_n (rad/s)', 'Damping zeta', 'Classification'];
    let cx = margin;
    headers.forEach((h, i) => {
      doc.text(h, cx + 2, y + 3.6);
      cx += pzColW[i];
    });
    y += pzRowH;
  };

  drawPzHeader();
  for (const row of pzRows) {
    if (y + pzRowH > pageH - 16) {
      doc.addPage();
      y = 16;
      drawPzHeader();
    }
    doc.setFillColor(255, 255, 255);
    doc.setDrawColor(226, 232, 240);
    doc.rect(margin, y, contentW, pzRowH, 'FD');
    let cx = margin;

    doc.setFont('courier', 'bold');
    doc.setFontSize(7.2);
    doc.setTextColor(row.color[0], row.color[1], row.color[2]);
    doc.text(row.type, cx + 2, y + 3.6);
    cx += pzColW[0];

    doc.setFont('courier', 'normal');
    doc.setTextColor(15, 23, 42);
    doc.text(row.coord, cx + 2, y + 3.6);
    cx += pzColW[1];

    doc.text(row.wn, cx + 2, y + 3.6);
    cx += pzColW[2];

    doc.text(row.zeta, cx + 2, y + 3.6);
    cx += pzColW[3];

    doc.setTextColor(71, 85, 105);
    doc.text(row.status, cx + 2, y + 3.6);

    y += pzRowH;
  }

  // Page 2+: Compiled Transfer Function & LaTeX Report
  doc.addPage();
  y = 16;

  doc.setTextColor(15, 23, 42);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10.5);
  doc.text('3. Transfer Function & State-Space Realization', margin, y);
  y += 5;

  const tfStr = `G(s) = (${formatPolynomial(tf.numerator)}) / (${formatPolynomial(tf.denominator)})`;
  doc.setFillColor(248, 250, 252);
  doc.setDrawColor(203, 213, 225);
  const tfLines = doc.splitTextToSize(sanitizePdfText(tfStr), contentW - 6) as string[];
  const tfBoxH = Math.max(10, tfLines.length * 4.5 + 5);
  doc.rect(margin, y, contentW, tfBoxH, 'FD');
  doc.setFont('courier', 'bold');
  doc.setFontSize(8.5);
  doc.setTextColor(8, 145, 178);
  doc.text(tfLines, margin + 3, y + 5.2);
  y += tfBoxH + 6;

  doc.setTextColor(15, 23, 42);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10.5);
  doc.text('4. Compiled LaTeX Report Snippet', margin, y);
  doc.setFont('courier', 'normal');
  doc.setFontSize(7.5);
  doc.setTextColor(100, 116, 139);
  doc.text('Ready for IEEE / LaTeX publication', pageW - margin, y, { align: 'right' });
  y += 3.5;

  doc.setFont('courier', 'normal');
  doc.setFontSize(7.5);
  const rawLatexLines = latexSnippet.split('\n');
  const wrappedLatexLines: string[] = [];
  for (const line of rawLatexLines) {
    if (!line.trim()) {
      wrappedLatexLines.push('');
    } else {
      const parts = doc.splitTextToSize(line, contentW - 8) as string[];
      wrappedLatexLines.push(...parts);
    }
  }

  const lineH = 3.9;
  let lineIdx = 0;
  while (lineIdx < wrappedLatexLines.length) {
    const availH = pageH - 16 - y;
    const maxLinesHere = Math.max(1, Math.floor((availH - 6) / lineH));
    const slice = wrappedLatexLines.slice(lineIdx, lineIdx + maxLinesHere);
    const boxHeight = slice.length * lineH + 6;

    doc.setFillColor(248, 250, 252);
    doc.setDrawColor(203, 213, 225);
    doc.setLineWidth(0.25);
    doc.rect(margin, y, contentW, boxHeight, 'FD');

    doc.setTextColor(30, 41, 59);
    let ly = y + 4.8;
    for (const l of slice) {
      if (l.length > 0) {
        doc.text(l, margin + 3.5, ly);
      }
      ly += lineH;
    }

    lineIdx += slice.length;
    if (lineIdx < wrappedLatexLines.length) {
      doc.addPage();
      y = 16;
    }
  }

  // Page Footers
  const totalPages = doc.getNumberOfPages();
  for (let p = 1; p <= totalPages; p++) {
    doc.setPage(p);
    doc.setDrawColor(226, 232, 240);
    doc.setLineWidth(0.2);
    doc.line(margin, pageH - 11, pageW - margin, pageH - 11);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7.5);
    doc.setTextColor(100, 116, 139);
    doc.text(
      sanitizePdfText(`OpenLoop System Analysis · ${model.name}`),
      margin,
      pageH - 6.5
    );
    doc.text(`Page ${p} of ${totalPages}`, pageW - margin, pageH - 6.5, {
      align: 'right',
    });
  }

  const arrayBuffer = doc.output('arraybuffer');
  const bytes = new Uint8Array(arrayBuffer);
  const safeId = (model.id || 'openloop_model').replace(/[^a-z0-9_-]+/gi, '_');
  return {
    doc,
    bytes,
    filename: `${safeId}_analysis_report.pdf`,
  };
}

export function exportSystemAnalysisPdf(options: PdfReportOptions): BuiltPdfReport {
  const built = buildSystemAnalysisPdf(options);
  const blob = new Blob(
    [built.bytes.buffer.slice(built.bytes.byteOffset, built.bytes.byteOffset + built.bytes.byteLength) as ArrayBuffer],
    { type: 'application/pdf' }
  );
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = built.filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  return built;
}
