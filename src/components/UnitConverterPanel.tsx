import React, { useState } from 'react';
import { ArrowLeftRight } from 'lucide-react';
import {
  UnitCategory,
  dbToLinear,
  degToRad,
  formatConvertedNumber,
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
} from '../utils/units';

interface UnitConverterPanelProps {
  currentBaseDt: number;
  onApplyBaseDt: (nextDt: number) => void;
}

const CATEGORIES: { id: UnitCategory; label: string }[] = [
  { id: 'frequency', label: 'Freq' },
  { id: 'torque', label: 'Torque' },
  { id: 'angularVelocity', label: 'Vel' },
  { id: 'angle', label: 'Angle' },
  { id: 'gain', label: 'Gain' },
];

export const UnitConverterPanel: React.FC<UnitConverterPanelProps> = ({
  currentBaseDt,
  onApplyBaseDt,
}) => {
  const [category, setCategory] = useState<UnitCategory>('frequency');

  const [hzStr, setHzStr] = useState<string>(() =>
    formatConvertedNumber(1 / Math.max(currentBaseDt, 1e-6), 2),
  );
  const [radStr, setRadStr] = useState<string>(() =>
    formatConvertedNumber(hzToRadPerSec(1 / Math.max(currentBaseDt, 1e-6)), 3),
  );

  const [nmStr, setNmStr] = useState<string>('1');
  const [ozinStr, setOzinStr] = useState<string>(() => formatConvertedNumber(nmToOzin(1), 3));
  const [lbfftStr, setLbfftStr] = useState<string>(() => formatConvertedNumber(nmToLbfft(1), 4));

  const [rpmStr, setRpmStr] = useState<string>('1500');
  const [velRadStr, setVelRadStr] = useState<string>(() =>
    formatConvertedNumber(rpmToRadPerSec(1500), 3),
  );

  const [degStr, setDegStr] = useState<string>('15');
  const [angRadStr, setAngRadStr] = useState<string>(() =>
    formatConvertedNumber(degToRad(15), 4),
  );

  const [linGainStr, setLinGainStr] = useState<string>('10');
  const [dbGainStr, setDbGainStr] = useState<string>(() =>
    formatConvertedNumber(linearToDb(10), 3),
  );

  const handleHzChange = (val: string) => {
    setHzStr(val);
    const n = Number(val);
    if (val.trim() !== '' && Number.isFinite(n)) {
      setRadStr(formatConvertedNumber(hzToRadPerSec(n), 4));
    } else {
      setRadStr('');
    }
  };

  const handleRadFreqChange = (val: string) => {
    setRadStr(val);
    const n = Number(val);
    if (val.trim() !== '' && Number.isFinite(n)) {
      setHzStr(formatConvertedNumber(radPerSecToHz(n), 4));
    } else {
      setHzStr('');
    }
  };

  const handleNmChange = (val: string) => {
    setNmStr(val);
    const n = Number(val);
    if (val.trim() !== '' && Number.isFinite(n)) {
      setOzinStr(formatConvertedNumber(nmToOzin(n), 3));
      setLbfftStr(formatConvertedNumber(nmToLbfft(n), 4));
    } else {
      setOzinStr('');
      setLbfftStr('');
    }
  };

  const handleOzinChange = (val: string) => {
    setOzinStr(val);
    const n = Number(val);
    if (val.trim() !== '' && Number.isFinite(n)) {
      const nm = ozinToNm(n);
      setNmStr(formatConvertedNumber(nm, 4));
      setLbfftStr(formatConvertedNumber(nmToLbfft(nm), 4));
    } else {
      setNmStr('');
      setLbfftStr('');
    }
  };

  const handleLbfftChange = (val: string) => {
    setLbfftStr(val);
    const n = Number(val);
    if (val.trim() !== '' && Number.isFinite(n)) {
      const nm = lbfftToNm(n);
      setNmStr(formatConvertedNumber(nm, 4));
      setOzinStr(formatConvertedNumber(nmToOzin(nm), 3));
    } else {
      setNmStr('');
      setOzinStr('');
    }
  };

  const handleRpmChange = (val: string) => {
    setRpmStr(val);
    const n = Number(val);
    if (val.trim() !== '' && Number.isFinite(n)) {
      setVelRadStr(formatConvertedNumber(rpmToRadPerSec(n), 4));
    } else {
      setVelRadStr('');
    }
  };

  const handleVelRadChange = (val: string) => {
    setVelRadStr(val);
    const n = Number(val);
    if (val.trim() !== '' && Number.isFinite(n)) {
      setRpmStr(formatConvertedNumber(radPerSecToRpm(n), 3));
    } else {
      setRpmStr('');
    }
  };

  const handleDegChange = (val: string) => {
    setDegStr(val);
    const n = Number(val);
    if (val.trim() !== '' && Number.isFinite(n)) {
      setAngRadStr(formatConvertedNumber(degToRad(n), 5));
    } else {
      setAngRadStr('');
    }
  };

  const handleAngRadChange = (val: string) => {
    setAngRadStr(val);
    const n = Number(val);
    if (val.trim() !== '' && Number.isFinite(n)) {
      setDegStr(formatConvertedNumber(radToDeg(n), 4));
    } else {
      setDegStr('');
    }
  };

  const handleLinGainChange = (val: string) => {
    setLinGainStr(val);
    const n = Number(val);
    if (val.trim() !== '' && Number.isFinite(n) && n !== 0) {
      setDbGainStr(formatConvertedNumber(linearToDb(n), 3));
    } else {
      setDbGainStr('');
    }
  };

  const handleDbGainChange = (val: string) => {
    setDbGainStr(val);
    const n = Number(val);
    if (val.trim() !== '' && Number.isFinite(n)) {
      setLinGainStr(formatConvertedNumber(dbToLinear(n), 4));
    } else {
      setLinGainStr('');
    }
  };

  const parsedHz = Number(hzStr);
  const periodMs = hzToPeriodMs(parsedHz);
  const canApplyDt =
    hzStr.trim() !== '' &&
    Number.isFinite(parsedHz) &&
    parsedHz >= 5 &&
    parsedHz <= 100000;

  return (
    <div className="px-4 pb-4 space-y-3">
      <div className="grid grid-cols-5 border border-slate-800 rounded overflow-hidden bg-[#07090E]">
        {CATEGORIES.map((item) => {
          const active = category === item.id;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => setCategory(item.id)}
              className={`py-1.5 text-[10px] font-mono font-medium transition-colors cursor-pointer border-r last:border-r-0 border-slate-800 ${
                active
                  ? 'bg-slate-800 text-cyan-300'
                  : 'text-slate-400 hover:text-slate-200 hover:bg-slate-900'
              }`}
            >
              {item.label}
            </button>
          );
        })}
      </div>

      {category === 'frequency' && (
        <div className="space-y-2.5">
          <div className="grid grid-cols-[1fr_auto_1fr] items-end gap-1.5">
            <div>
              <label className="block text-[11px] text-slate-400 mb-1">
                Frequency (Hz)
              </label>
              <input
                type="number"
                step="any"
                value={hzStr}
                onChange={(e) => handleHzChange(e.target.value)}
                aria-label="Frequency in Hz"
                className="w-full bg-[#07090E] border border-slate-800 rounded px-2 py-1.5 text-xs font-mono tabular-nums text-cyan-300 focus:outline-none focus:border-cyan-400"
              />
            </div>
            <ArrowLeftRight className="w-3.5 h-3.5 text-slate-500 mb-2" />
            <div>
              <label className="block text-[11px] text-slate-400 mb-1">
                Angular (rad/s)
              </label>
              <input
                type="number"
                step="any"
                value={radStr}
                onChange={(e) => handleRadFreqChange(e.target.value)}
                aria-label="Frequency in rad/s"
                className="w-full bg-[#07090E] border border-slate-800 rounded px-2 py-1.5 text-xs font-mono tabular-nums text-slate-100 focus:outline-none focus:border-cyan-400"
              />
            </div>
          </div>

          <div className="flex items-center justify-between pt-1 border-t border-slate-800/80 text-[11px] font-mono tabular-nums">
            <span className="text-slate-400">
              Period:{' '}
              <span className="text-slate-200">
                {Number.isFinite(periodMs) ? `${periodMs.toFixed(3)} ms` : '—'}
              </span>
            </span>
            <button
              type="button"
              disabled={!canApplyDt}
              onClick={() => {
                if (canApplyDt) {
                  onApplyBaseDt(Number((1 / parsedHz).toFixed(6)));
                }
              }}
              className="px-2 py-1 rounded border border-slate-700 bg-slate-900 hover:bg-slate-800 text-cyan-300 disabled:opacity-40 disabled:cursor-not-allowed transition-colors cursor-pointer text-[10px]"
            >
              Apply as Base dt
            </button>
          </div>
        </div>
      )}

      {category === 'torque' && (
        <div className="space-y-2">
          <div>
            <label className="block text-[11px] text-slate-400 mb-1">
              Newton-meters (N·m)
            </label>
            <input
              type="number"
              step="any"
              value={nmStr}
              onChange={(e) => handleNmChange(e.target.value)}
              aria-label="Torque in N·m"
              className="w-full bg-[#07090E] border border-slate-800 rounded px-2.5 py-1.5 text-xs font-mono tabular-nums text-amber-300 focus:outline-none focus:border-cyan-400"
            />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="block text-[11px] text-slate-400 mb-1">
                Ounce-inch (oz·in)
              </label>
              <input
                type="number"
                step="any"
                value={ozinStr}
                onChange={(e) => handleOzinChange(e.target.value)}
                aria-label="Torque in oz·in"
                className="w-full bg-[#07090E] border border-slate-800 rounded px-2 py-1.5 text-xs font-mono tabular-nums text-slate-100 focus:outline-none focus:border-cyan-400"
              />
            </div>
            <div>
              <label className="block text-[11px] text-slate-400 mb-1">
                Pound-foot (lbf·ft)
              </label>
              <input
                type="number"
                step="any"
                value={lbfftStr}
                onChange={(e) => handleLbfftChange(e.target.value)}
                aria-label="Torque in lbf·ft"
                className="w-full bg-[#07090E] border border-slate-800 rounded px-2 py-1.5 text-xs font-mono tabular-nums text-slate-100 focus:outline-none focus:border-cyan-400"
              />
            </div>
          </div>
        </div>
      )}

      {category === 'angularVelocity' && (
        <div className="grid grid-cols-[1fr_auto_1fr] items-end gap-1.5">
          <div>
            <label className="block text-[11px] text-slate-400 mb-1">
              Speed (RPM)
            </label>
            <input
              type="number"
              step="any"
              value={rpmStr}
              onChange={(e) => handleRpmChange(e.target.value)}
              aria-label="Speed in RPM"
              className="w-full bg-[#07090E] border border-slate-800 rounded px-2 py-1.5 text-xs font-mono tabular-nums text-cyan-300 focus:outline-none focus:border-cyan-400"
            />
          </div>
          <ArrowLeftRight className="w-3.5 h-3.5 text-slate-500 mb-2" />
          <div>
            <label className="block text-[11px] text-slate-400 mb-1">
              Angular (rad/s)
            </label>
            <input
              type="number"
              step="any"
              value={velRadStr}
              onChange={(e) => handleVelRadChange(e.target.value)}
              aria-label="Angular velocity in rad/s"
              className="w-full bg-[#07090E] border border-slate-800 rounded px-2 py-1.5 text-xs font-mono tabular-nums text-slate-100 focus:outline-none focus:border-cyan-400"
            />
          </div>
        </div>
      )}

      {category === 'angle' && (
        <div className="grid grid-cols-[1fr_auto_1fr] items-end gap-1.5">
          <div>
            <label className="block text-[11px] text-slate-400 mb-1">
              Degrees (deg)
            </label>
            <input
              type="number"
              step="any"
              value={degStr}
              onChange={(e) => handleDegChange(e.target.value)}
              aria-label="Angle in degrees"
              className="w-full bg-[#07090E] border border-slate-800 rounded px-2 py-1.5 text-xs font-mono tabular-nums text-cyan-300 focus:outline-none focus:border-cyan-400"
            />
          </div>
          <ArrowLeftRight className="w-3.5 h-3.5 text-slate-500 mb-2" />
          <div>
            <label className="block text-[11px] text-slate-400 mb-1">
              Radians (rad)
            </label>
            <input
              type="number"
              step="any"
              value={angRadStr}
              onChange={(e) => handleAngRadChange(e.target.value)}
              aria-label="Angle in radians"
              className="w-full bg-[#07090E] border border-slate-800 rounded px-2 py-1.5 text-xs font-mono tabular-nums text-slate-100 focus:outline-none focus:border-cyan-400"
            />
          </div>
        </div>
      )}

      {category === 'gain' && (
        <div className="grid grid-cols-[1fr_auto_1fr] items-end gap-1.5">
          <div>
            <label className="block text-[11px] text-slate-400 mb-1">
              Magnitude |K|
            </label>
            <input
              type="number"
              step="any"
              value={linGainStr}
              onChange={(e) => handleLinGainChange(e.target.value)}
              aria-label="Linear gain magnitude"
              className="w-full bg-[#07090E] border border-slate-800 rounded px-2 py-1.5 text-xs font-mono tabular-nums text-emerald-300 focus:outline-none focus:border-cyan-400"
            />
          </div>
          <ArrowLeftRight className="w-3.5 h-3.5 text-slate-500 mb-2" />
          <div>
            <label className="block text-[11px] text-slate-400 mb-1">
              Decibels (dB)
            </label>
            <input
              type="number"
              step="any"
              value={dbGainStr}
              onChange={(e) => handleDbGainChange(e.target.value)}
              aria-label="Gain in decibels"
              className="w-full bg-[#07090E] border border-slate-800 rounded px-2 py-1.5 text-xs font-mono tabular-nums text-slate-100 focus:outline-none focus:border-cyan-400"
            />
          </div>
        </div>
      )}
    </div>
  );
};
