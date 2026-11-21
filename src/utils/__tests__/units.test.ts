import { describe, expect, it } from 'vitest';
import {
  dbToLinear,
  degToRad,
  hzToPeriodMs,
  hzToRadPerSec,
  lbfftToNm,
  linearToDb,
  nmToLbfft,
  nmToOzin,
  ozinToNm,
  radPerSecToHz,
  radPerSecToRpm,
  radToDeg,
  rpmToRadPerSec,
} from '../units';

describe('Control System Unit Conversion Utilities', () => {
  it('converts frequency between Hz, rad/s, and period ms', () => {
    expect(hzToRadPerSec(1)).toBeCloseTo(2 * Math.PI, 10);
    expect(radPerSecToHz(2 * Math.PI)).toBeCloseTo(1, 10);
    expect(hzToPeriodMs(200)).toBeCloseTo(5, 10);
    expect(hzToPeriodMs(0)).toBe(Infinity);
  });

  it('converts torque round-trip between N·m, oz·in, and lbf·ft', () => {
    const nm = 2.5;
    const ozin = nmToOzin(nm);
    const lbfft = nmToLbfft(nm);
    expect(ozin).toBeCloseTo(354.0298, 3);
    expect(lbfft).toBeCloseTo(1.8439, 4);
    expect(ozinToNm(ozin)).toBeCloseTo(nm, 10);
    expect(lbfftToNm(lbfft)).toBeCloseTo(nm, 10);
  });

  it('converts angular velocity between RPM and rad/s', () => {
    const rads = rpmToRadPerSec(3000);
    expect(rads).toBeCloseTo(100 * Math.PI, 10);
    expect(radPerSecToRpm(rads)).toBeCloseTo(3000, 10);
  });

  it('converts angles between deg and rad', () => {
    expect(degToRad(180)).toBeCloseTo(Math.PI, 10);
    expect(radToDeg(Math.PI / 2)).toBeCloseTo(90, 10);
  });

  it('converts linear gain magnitude to dB and back', () => {
    expect(linearToDb(10)).toBeCloseTo(20, 10);
    expect(dbToLinear(20)).toBeCloseTo(10, 10);
    expect(linearToDb(0)).toBe(-Infinity);
  });
});
