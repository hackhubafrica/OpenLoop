import React, { useState } from 'react';
import { RotateCcw, Waves, Wind, Droplets, AlertTriangle, CheckCircle2 } from 'lucide-react';
import {
  Esp32BoardSpec,
  Esp32PinIssue,
  Esp32PinProfile,
  Esp32SensorSelection,
  Esp32WiringRow,
} from '../engine/esp32Codegen';
import { ControlModel } from '../types/control';

interface Esp32HardwareMapProps {
  model: ControlModel;
  pinProfile: Esp32PinProfile;
  sensors: Esp32SensorSelection;
  boardSpec: Esp32BoardSpec;
  issues: Esp32PinIssue[];
  wiringRows: Esp32WiringRow[];
  onToggleSensor: (sensor: keyof Esp32SensorSelection) => void;
  onChangePin: (field: keyof Esp32PinProfile, value: number) => void;
  onAutoMapPins: () => void;
}

type HighlightGroup = 'ultrasonic' | 'gas' | 'humidity' | 'actuator' | null;

export const Esp32HardwareMap: React.FC<Esp32HardwareMapProps> = ({
  model,
  pinProfile,
  sensors,
  boardSpec,
  issues,
  wiringRows,
  onToggleSensor,
  onChangePin,
  onAutoMapPins,
}) => {
  const [focusedGroup, setFocusedGroup] = useState<HighlightGroup>(null);

  const issueForField = (field: keyof Esp32PinProfile) =>
    issues.find((i) => i.field === field);

  const pinStroke = (fields: (keyof Esp32PinProfile)[], enabled: boolean, defaultHex: string) => {
    if (!enabled) return '#334155';
    const hasErr = fields.some((f) => issueForField(f)?.severity === 'error');
    if (hasErr) return '#F43F5E';
    const hasWarn = fields.some((f) => issueForField(f)?.severity === 'warning');
    if (hasWarn) return '#F59E0B';
    return defaultHex;
  };

  const sensorCards: {
    key: keyof Esp32SensorSelection;
    title: string;
    hardwareName: string;
    pinSummary: string;
    icon: React.ReactNode;
    note: string;
  }[] = [
    {
      key: 'ultrasonic',
      title: 'Ultrasonic',
      hardwareName: 'HC-SR04 (5V)',
      pinSummary: `TRIG GPIO ${pinProfile.trigPin} · ECHO GPIO ${pinProfile.echoPin}`,
      icon: <Waves className="w-3.5 h-3.5" />,
      note: '1kΩ / 2kΩ voltage divider on ECHO',
    },
    {
      key: 'gas',
      title: 'Gas Sensor',
      hardwareName: 'MQ-x Analog (ADC1)',
      pinSummary: `AO GPIO ${pinProfile.gasAdcPin}`,
      icon: <Wind className="w-3.5 h-3.5" />,
      note: `ADC1 safe (${boardSpec.adc1Pins.slice(0, 4).join(', ')}…)`,
    },
    {
      key: 'humidity',
      title: 'Humidity',
      hardwareName: 'DHT22 (3.3V)',
      pinSummary: `DATA GPIO ${pinProfile.humidityPin}`,
      icon: <Droplets className="w-3.5 h-3.5" />,
      note: 'Links Adafruit DHT library in platformio.ini',
    },
  ];

  const isGroupHighlighted = (group: HighlightGroup) =>
    focusedGroup === null || focusedGroup === group;

  return (
    <div className="flex-1 p-5 bg-[#07090E] overflow-auto space-y-5">
      {/* Header & Interactive Sensor Matrix */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h3 className="text-xs font-semibold text-slate-100">
            ESP32 Hardware Map &amp; Visual Wiring Guide
          </h3>
          <p className="text-[11px] text-slate-400 mt-0.5 font-mono">
            {boardSpec.label} · {boardSpec.mcuSummary}
          </p>
        </div>

        <button
          type="button"
          onClick={onAutoMapPins}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-mono rounded border border-slate-700 bg-[#0B0E17] hover:bg-slate-800 text-cyan-300 transition-colors cursor-pointer whitespace-nowrap shrink-0"
        >
          <RotateCcw className="w-3 h-3" />
          Auto-Map Safe GPIOs
        </button>
      </div>

      {/* Sensor Enable/Disable Selector */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        {sensorCards.map((card) => {
          const active = sensors[card.key];
          return (
            <button
              key={card.key}
              type="button"
              onClick={() => onToggleSensor(card.key)}
              onMouseEnter={() => setFocusedGroup(card.key)}
              onMouseLeave={() => setFocusedGroup(null)}
              className={`text-left p-3 rounded border transition-colors cursor-pointer ${
                active
                  ? 'border-cyan-500/60 bg-cyan-500/10'
                  : 'border-slate-800 bg-[#0B0E17] hover:border-slate-700 opacity-75'
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-slate-100">
                  <span className={active ? 'text-cyan-300' : 'text-slate-500'}>
                    {card.icon}
                  </span>
                  {card.title} ({card.hardwareName})
                </span>
                <span
                  className={`text-[10px] font-mono ${
                    active ? 'text-emerald-400' : 'text-slate-500'
                  }`}
                >
                  {active ? 'ENABLED' : 'BYPASSED'}
                </span>
              </div>
              <div className="mt-1.5 text-[11px] font-mono tabular-nums text-cyan-300">
                {active ? card.pinSummary : 'Unmapped in generated firmware'}
              </div>
              <div className="mt-1 text-[10px] text-slate-400">{card.note}</div>
            </button>
          );
        })}
      </div>

      {/* Dynamic SVG Visual Wiring Guide */}
      <div className="border border-slate-800 rounded bg-[#0B0E17] p-4">
        <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
          <span className="text-[11px] font-semibold text-slate-200">
            Interactive Schematic Wiring Diagram
          </span>
          <span className="text-[10px] font-mono text-slate-400">
            Hover peripheral nodes to isolate signal paths · Amber indicates 5V→3.3V resistor divider
          </span>
        </div>

        <svg
          viewBox="0 0 840 350"
          className="w-full h-auto max-h-[340px] bg-[#07090E] border border-slate-800/80 rounded"
          role="img"
          aria-label="ESP32 hardware pin map and breadboard wiring diagram"
        >
          <defs>
            <pattern id="pcb-grid" width="20" height="20" patternUnits="userSpaceOnUse">
              <path
                d="M 20 0 L 0 0 0 20"
                fill="none"
                stroke="#0F172A"
                strokeWidth="1"
              />
            </pattern>
          </defs>
          <rect width="840" height="350" fill="url(#pcb-grid)" />

          {/* LEFT SENSORS */}
          {/* 1. HC-SR04 Ultrasonic */}
          <g
            opacity={sensors.ultrasonic ? (isGroupHighlighted('ultrasonic') ? 1 : 0.35) : 0.32}
            onMouseEnter={() => setFocusedGroup('ultrasonic')}
            onMouseLeave={() => setFocusedGroup(null)}
            className="cursor-pointer"
          >
            <rect
              x="22"
              y="24"
              width="175"
              height="94"
              rx="6"
              fill="#0B0E17"
              stroke={sensors.ultrasonic ? '#06B6D4' : '#334155'}
              strokeWidth={sensors.ultrasonic ? 1.5 : 1}
              strokeDasharray={sensors.ultrasonic ? undefined : '4 3'}
            />
            <text x="34" y="44" fill="#F1F5F9" fontSize="12" fontWeight="600">
              HC-SR04 Ultrasonic
            </text>
            <text x="34" y="60" fill="#94A3B8" fontSize="10" fontFamily="monospace">
              VCC: 5V VIN · GND: GND
            </text>
            <text x="34" y="82" fill="#22D3EE" fontSize="10" fontFamily="monospace">
              TRIG ────────▶ 3.3V OK
            </text>
            <text x="34" y="102" fill="#FBBF24" fontSize="10" fontFamily="monospace">
              ECHO (5V) ───▶ Divider
            </text>

            {/* TRIG wire */}
            <path
              d="M 197 78 H 322"
              fill="none"
              stroke={pinStroke(['trigPin'], sensors.ultrasonic, '#06B6D4')}
              strokeWidth={sensors.ultrasonic ? 2 : 1}
              strokeDasharray={sensors.ultrasonic ? undefined : '4 4'}
            />

            {/* ECHO wire + 1k / 2k Voltage Divider */}
            <path
              d="M 197 100 H 235"
              fill="none"
              stroke={pinStroke(['echoPin'], sensors.ultrasonic, '#F59E0B')}
              strokeWidth={sensors.ultrasonic ? 2 : 1}
              strokeDasharray={sensors.ultrasonic ? undefined : '4 4'}
            />
            <rect
              x="235"
              y="88"
              width="58"
              height="24"
              rx="3"
              fill="#0B0E17"
              stroke={sensors.ultrasonic ? '#F59E0B' : '#334155'}
              strokeWidth="1"
            />
            <text
              x="264"
              y="103"
              textAnchor="middle"
              fill="#FCD34D"
              fontSize="9"
              fontFamily="monospace"
            >
              1kΩ / 2kΩ
            </text>
            <path
              d="M 293 100 H 322"
              fill="none"
              stroke={pinStroke(['echoPin'], sensors.ultrasonic, '#22D3EE')}
              strokeWidth={sensors.ultrasonic ? 2 : 1}
              strokeDasharray={sensors.ultrasonic ? undefined : '4 4'}
            />
          </g>

          {/* 2. MQ-x Gas Sensor */}
          <g
            opacity={sensors.gas ? (isGroupHighlighted('gas') ? 1 : 0.35) : 0.32}
            onMouseEnter={() => setFocusedGroup('gas')}
            onMouseLeave={() => setFocusedGroup(null)}
            className="cursor-pointer"
          >
            <rect
              x="22"
              y="134"
              width="175"
              height="82"
              rx="6"
              fill="#0B0E17"
              stroke={sensors.gas ? '#06B6D4' : '#334155'}
              strokeWidth={sensors.gas ? 1.5 : 1}
              strokeDasharray={sensors.gas ? undefined : '4 3'}
            />
            <text x="34" y="155" fill="#F1F5F9" fontSize="12" fontWeight="600">
              MQ-x Gas Sensor
            </text>
            <text x="34" y="171" fill="#94A3B8" fontSize="10" fontFamily="monospace">
              Heater: 5V VIN · ADC1
            </text>
            <text x="34" y="196" fill="#FBBF24" fontSize="10" fontFamily="monospace">
              AO Analog ───▶ 3.3V Clamp
            </text>

            <path
              d="M 197 190 H 235"
              fill="none"
              stroke={pinStroke(['gasAdcPin'], sensors.gas, '#F59E0B')}
              strokeWidth={sensors.gas ? 2 : 1}
              strokeDasharray={sensors.gas ? undefined : '4 4'}
            />
            <rect
              x="235"
              y="178"
              width="58"
              height="24"
              rx="3"
              fill="#0B0E17"
              stroke={sensors.gas ? '#F59E0B' : '#334155'}
              strokeWidth="1"
            />
            <text
              x="264"
              y="193"
              textAnchor="middle"
              fill="#FCD34D"
              fontSize="9"
              fontFamily="monospace"
            >
              1kΩ / 2kΩ
            </text>
            <path
              d="M 293 190 H 322"
              fill="none"
              stroke={pinStroke(['gasAdcPin'], sensors.gas, '#22D3EE')}
              strokeWidth={sensors.gas ? 2 : 1}
              strokeDasharray={sensors.gas ? undefined : '4 4'}
            />
          </g>

          {/* 3. DHT22 Humidity & Temp */}
          <g
            opacity={sensors.humidity ? (isGroupHighlighted('humidity') ? 1 : 0.35) : 0.32}
            onMouseEnter={() => setFocusedGroup('humidity')}
            onMouseLeave={() => setFocusedGroup(null)}
            className="cursor-pointer"
          >
            <rect
              x="22"
              y="232"
              width="175"
              height="86"
              rx="6"
              fill="#0B0E17"
              stroke={sensors.humidity ? '#10B981' : '#334155'}
              strokeWidth={sensors.humidity ? 1.5 : 1}
              strokeDasharray={sensors.humidity ? undefined : '4 3'}
            />
            <text x="34" y="253" fill="#F1F5F9" fontSize="12" fontWeight="600">
              DHT22 Humidity/Temp
            </text>
            <text x="34" y="269" fill="#94A3B8" fontSize="10" fontFamily="monospace">
              VCC: 3.3V · 10kΩ Pull-up
            </text>
            <text x="34" y="295" fill="#34D399" fontSize="10" fontFamily="monospace">
              DATA ───────▶ Open-Drain
            </text>

            <path
              d="M 197 290 H 235"
              fill="none"
              stroke={pinStroke(['humidityPin'], sensors.humidity, '#10B981')}
              strokeWidth={sensors.humidity ? 2 : 1}
              strokeDasharray={sensors.humidity ? undefined : '4 4'}
            />
            <rect
              x="235"
              y="278"
              width="58"
              height="24"
              rx="3"
              fill="#0B0E17"
              stroke={sensors.humidity ? '#10B981' : '#334155'}
              strokeWidth="1"
            />
            <text
              x="264"
              y="293"
              textAnchor="middle"
              fill="#6EE7B7"
              fontSize="9"
              fontFamily="monospace"
            >
              10kΩ PU
            </text>
            <path
              d="M 293 290 H 322"
              fill="none"
              stroke={pinStroke(['humidityPin'], sensors.humidity, '#10B981')}
              strokeWidth={sensors.humidity ? 2 : 1}
              strokeDasharray={sensors.humidity ? undefined : '4 4'}
            />
          </g>

          {/* CENTER: ESP32 DEVKIT IC */}
          <g>
            <rect
              x="322"
              y="24"
              width="206"
              height="294"
              rx="8"
              fill="#0B0E17"
              stroke="#334155"
              strokeWidth="1.5"
            />
            <rect
              x="362"
              y="34"
              width="126"
              height="38"
              rx="4"
              fill="#111827"
              stroke="#475569"
              strokeWidth="1"
            />
            <text
              x="425"
              y="52"
              textAnchor="middle"
              fill="#E2E8F0"
              fontSize="11"
              fontWeight="600"
              fontFamily="monospace"
            >
              {boardSpec.id}
            </text>
            <text
              x="425"
              y="66"
              textAnchor="middle"
              fill="#22D3EE"
              fontSize="9"
              fontFamily="monospace"
            >
              dt = {model.baseDt}s ({Math.round(1 / model.baseDt)}Hz)
            </text>

            {/* Left Pin Terminals */}
            {[
              { label: `GPIO ${pinProfile.trigPin}`, y: 78, field: 'trigPin' as const, active: sensors.ultrasonic },
              { label: `GPIO ${pinProfile.echoPin}`, y: 100, field: 'echoPin' as const, active: sensors.ultrasonic },
              { label: `GPIO ${pinProfile.gasAdcPin}`, y: 190, field: 'gasAdcPin' as const, active: sensors.gas },
              { label: `GPIO ${pinProfile.humidityPin}`, y: 290, field: 'humidityPin' as const, active: sensors.humidity },
            ].map((pin) => {
              const issue = issueForField(pin.field);
              const badgeColor =
                !pin.active
                  ? '#475569'
                  : issue?.severity === 'error'
                  ? '#F43F5E'
                  : issue?.severity === 'warning'
                  ? '#F59E0B'
                  : '#22D3EE';
              return (
                <g key={pin.field}>
                  <circle cx="322" cy={pin.y} r="4.5" fill={badgeColor} />
                  <text
                    x="333"
                    y={pin.y + 3.5}
                    fill={pin.active ? '#E2E8F0' : '#64748B'}
                    fontSize="10"
                    fontFamily="monospace"
                  >
                    {pin.label}
                  </text>
                </g>
              );
            })}

            {/* Right Pin Terminals */}
            {[
              { label: `GPIO ${pinProfile.pwmLedPin}`, y: 96, field: 'pwmLedPin' as const },
              { label: `GPIO ${pinProfile.buzzerPin}`, y: 186, field: 'buzzerPin' as const },
              { label: `GPIO ${pinProfile.relayPin}`, y: 276, field: 'relayPin' as const },
            ].map((pin) => {
              const issue = issueForField(pin.field);
              const badgeColor =
                issue?.severity === 'error'
                  ? '#F43F5E'
                  : issue?.severity === 'warning'
                  ? '#F59E0B'
                  : '#10B981';
              return (
                <g key={pin.field}>
                  <circle cx="528" cy={pin.y} r="4.5" fill={badgeColor} />
                  <text
                    x="517"
                    y={pin.y + 3.5}
                    textAnchor="end"
                    fill="#E2E8F0"
                    fontSize="10"
                    fontFamily="monospace"
                  >
                    {pin.label}
                  </text>
                </g>
              );
            })}

            {/* USB UART bridge bottom */}
            <rect
              x="388"
              y="296"
              width="74"
              height="22"
              rx="3"
              fill="#1E293B"
              stroke="#475569"
            />
            <text
              x="425"
              y="310"
              textAnchor="middle"
              fill="#CBD5E1"
              fontSize="9"
              fontFamily="monospace"
            >
              USB / COBS
            </text>
          </g>

          {/* RIGHT ACTUATORS */}
          <g
            opacity={isGroupHighlighted('actuator') ? 1 : 0.35}
            onMouseEnter={() => setFocusedGroup('actuator')}
            onMouseLeave={() => setFocusedGroup(null)}
            className="cursor-pointer"
          >
            {/* PWM Status LED / Driver */}
            <path
              d="M 528 96 H 572"
              fill="none"
              stroke={pinStroke(['pwmLedPin'], true, '#22D3EE')}
              strokeWidth="2"
            />
            <rect x="572" y="84" width="44" height="24" rx="3" fill="#0B0E17" stroke="#22D3EE" />
            <text x="594" y="99" textAnchor="middle" fill="#67E8F9" fontSize="9" fontFamily="monospace">
              220 Ω
            </text>
            <path d="M 616 96 H 646" fill="none" stroke="#22D3EE" strokeWidth="2" />
            <rect x="646" y="64" width="172" height="64" rx="6" fill="#0B0E17" stroke="#1E293B" strokeWidth="1.5" />
            <text x="658" y="85" fill="#F1F5F9" fontSize="12" fontWeight="600">
              LEDC PWM Out
            </text>
            <text x="658" y="102" fill="#94A3B8" fontSize="10" fontFamily="monospace">
              5 kHz 8-bit · LED / FET
            </text>
            <text x="658" y="117" fill="#22D3EE" fontSize="10" fontFamily="monospace">
              Duty ∝ |u_cmd|
            </text>

            {/* Passive Buzzer */}
            <path
              d="M 528 186 H 572"
              fill="none"
              stroke={pinStroke(['buzzerPin'], true, '#F59E0B')}
              strokeWidth="2"
            />
            <rect x="572" y="174" width="44" height="24" rx="3" fill="#0B0E17" stroke="#F59E0B" />
            <text x="594" y="189" textAnchor="middle" fill="#FCD34D" fontSize="9" fontFamily="monospace">
              100 Ω
            </text>
            <path d="M 616 186 H 646" fill="none" stroke="#F59E0B" strokeWidth="2" />
            <rect x="646" y="154" width="172" height="64" rx="6" fill="#0B0E17" stroke="#1E293B" strokeWidth="1.5" />
            <text x="658" y="175" fill="#F1F5F9" fontSize="12" fontWeight="600">
              Passive Buzzer
            </text>
            <text x="658" y="192" fill="#94A3B8" fontSize="10" fontFamily="monospace">
              1.8 kHz Fault Tone
            </text>
            <text x="658" y="207" fill="#FBBF24" fontSize="10" fontFamily="monospace">
              Trigger: Sat / Gas Alarm
            </text>

            {/* Relay Module */}
            <path
              d="M 528 276 H 646"
              fill="none"
              stroke={pinStroke(['relayPin'], true, '#10B981')}
              strokeWidth="2"
            />
            <rect x="646" y="244" width="172" height="68" rx="6" fill="#0B0E17" stroke="#1E293B" strokeWidth="1.5" />
            <text x="658" y="265" fill="#F1F5F9" fontSize="12" fontWeight="600">
              Opto Relay Module
            </text>
            <text x="658" y="282" fill="#94A3B8" fontSize="10" fontFamily="monospace">
              Coil: 5V VIN · IN: 3.3V
            </text>
            <text x="658" y="298" fill="#34D399" fontSize="10" fontFamily="monospace">
              Trip |u| ≥ {pinProfile.relayThreshold.toFixed(0)} (±4 Hyst)
            </text>
          </g>
        </svg>
      </div>

      {/* Validation Status Line */}
      {issues.length > 0 ? (
        <div className="space-y-1.5">
          {issues.map((issue, idx) => (
            <div
              key={idx}
              className={`p-2.5 rounded border text-[11px] font-mono flex items-start gap-2 ${
                issue.severity === 'error'
                  ? 'border-rose-500/40 bg-rose-500/10 text-rose-200'
                  : 'border-amber-500/40 bg-amber-500/10 text-amber-200'
              }`}
            >
              <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
              <span>{issue.message}</span>
            </div>
          ))}
        </div>
      ) : (
        <div className="p-2.5 rounded border border-emerald-500/30 bg-emerald-500/10 text-[11px] font-mono text-emerald-300 flex items-center gap-2">
          <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
          <span>Active GPIO map verified clear of SPI flash, boot-strap &amp; ADC2 conflicts</span>
        </div>
      )}

      {/* Active Peripheral Pin Mapping Table */}
      <div className="border border-slate-800 rounded overflow-hidden">
        <table className="w-full text-left border-collapse text-xs font-mono tabular-nums">
          <thead className="bg-[#0B0E17] text-slate-400 border-b border-slate-800">
            <tr>
              <th className="py-2 px-3 font-medium">Peripheral</th>
              <th className="py-2 px-3 font-medium">Signal</th>
              <th className="py-2 px-3 font-medium">ESP32 GPIO</th>
              <th className="py-2 px-3 font-medium">Direction</th>
              <th className="py-2 px-3 font-medium">Wiring &amp; Resistor Note</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800/80 bg-[#07090E]">
            {wiringRows.map((row) => {
              const fieldMap: Record<string, keyof Esp32PinProfile> = {
                TRIG: 'trigPin',
                ECHO: 'echoPin',
                'AO (ADC1)': 'gasAdcPin',
                DATA: 'humidityPin',
                'PWM (LEDC)': 'pwmLedPin',
                'SIG (Tone)': 'buzzerPin',
                'IN (Control)': 'relayPin',
              };
              const mappedField = fieldMap[row.signal];
              const rowHighlighted = isGroupHighlighted(row.sensorGroup);
              return (
                <tr
                  key={`${row.peripheral}-${row.signal}`}
                  className={`transition-opacity ${rowHighlighted ? 'opacity-100' : 'opacity-40'}`}
                >
                  <td className="py-2.5 px-3 text-slate-200">{row.peripheral}</td>
                  <td className="py-2.5 px-3 text-cyan-300">{row.signal}</td>
                  <td className="py-2.5 px-3">
                    {mappedField ? (
                      <div className="inline-flex items-center gap-1.5">
                        <span className="text-slate-400">GPIO</span>
                        <input
                          aria-label={`${row.peripheral} ${row.signal} GPIO`}
                          type="number"
                          min={0}
                          max={boardSpec.maxGpio}
                          value={row.gpio}
                          onChange={(e) => onChangePin(mappedField, Number(e.target.value))}
                          className="w-16 bg-[#0B0E17] border border-slate-700 rounded px-1.5 py-0.5 text-xs tabular-nums text-cyan-300 focus:outline-none focus:border-cyan-400"
                        />
                      </div>
                    ) : (
                      <span className="text-slate-100 font-semibold">GPIO {row.gpio}</span>
                    )}
                  </td>
                  <td className="py-2.5 px-3 text-slate-400">{row.direction}</td>
                  <td
                    className={`py-2.5 px-3 ${
                      row.warningLevel === 'divider' ? 'text-amber-300' : 'text-slate-300'
                    }`}
                  >
                    {row.protectionNote}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
};
