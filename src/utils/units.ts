export type UnitCategory = 'frequency' | 'torque' | 'angularVelocity' | 'angle' | 'gain';

export const TWO_PI = 2 * Math.PI;
export const NM_TO_OZIN = 141.61193227806;
export const NM_TO_LBFFT = 0.73756214927727;
export const RPM_TO_RAD_S = Math.PI / 30;
export const DEG_TO_RAD = Math.PI / 180;

export function hzToRadPerSec(hz: number): number {
  return hz * TWO_PI;
}

export function radPerSecToHz(radPerSec: number): number {
  return radPerSec / TWO_PI;
}

export function hzToPeriodMs(hz: number): number {
  if (!Number.isFinite(hz) || hz <= 0) return Infinity;
  return 1000 / hz;
}

export function nmToOzin(nm: number): number {
  return nm * NM_TO_OZIN;
}

export function ozinToNm(ozin: number): number {
  return ozin / NM_TO_OZIN;
}

export function nmToLbfft(nm: number): number {
  return nm * NM_TO_LBFFT;
}

export function lbfftToNm(lbfft: number): number {
  return lbfft / NM_TO_LBFFT;
}

export function rpmToRadPerSec(rpm: number): number {
  return rpm * RPM_TO_RAD_S;
}

export function radPerSecToRpm(radPerSec: number): number {
  return radPerSec / RPM_TO_RAD_S;
}

export function degToRad(deg: number): number {
  return deg * DEG_TO_RAD;
}

export function radToDeg(rad: number): number {
  return rad / DEG_TO_RAD;
}

export function linearToDb(linear: number): number {
  const absVal = Math.abs(linear);
  if (absVal <= 0) return -Infinity;
  return 20 * Math.log10(absVal);
}

export function dbToLinear(db: number): number {
  return Math.pow(10, db / 20);
}

export function formatConvertedNumber(value: number, decimals = 4): string {
  if (!Number.isFinite(value)) return '';
  const rounded = Number(value.toFixed(decimals));
  return Object.is(rounded, -0) ? '0' : String(rounded);
}
