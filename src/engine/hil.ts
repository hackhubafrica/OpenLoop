import { ControlModel, HilFramePacket, SimulationTrace } from '../types/control';

export function crc16Ccitt(bytes: Uint8Array): number {
  let crc = 0xffff;
  for (let i = 0; i < bytes.length; i++) {
    crc ^= bytes[i] << 8;
    for (let b = 0; b < 8; b++) {
      crc = (crc & 0x8000) !== 0 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc;
}

export function cobsEncode(input: Uint8Array): Uint8Array {
  const out: number[] = [0];
  let codeIdx = 0;
  let code = 1;

  for (let i = 0; i < input.length; i++) {
    const byte = input[i];
    if (byte === 0) {
      out[codeIdx] = code;
      codeIdx = out.length;
      out.push(0);
      code = 1;
    } else {
      out.push(byte);
      code++;
      if (code === 0xff) {
        out[codeIdx] = code;
        codeIdx = out.length;
        out.push(0);
        code = 1;
      }
    }
  }
  out[codeIdx] = code;
  out.push(0x00); // Delimiter
  return new Uint8Array(out);
}

export function isHilCobsEnabled(model: ControlModel): boolean {
  return model.hil.cobsEnabled ?? model.hil.transport === 'uart_cobs';
}

export function cobsDecode(encoded: Uint8Array): Uint8Array | null {
  if (encoded.length < 2) return null;
  const end = encoded[encoded.length - 1] === 0 ? encoded.length - 1 : encoded.length;
  const out: number[] = [];
  let idx = 0;
  while (idx < end) {
    const code = encoded[idx];
    if (code === 0) return null;
    idx += 1;
    for (let i = 1; i < code; i++) {
      if (idx >= end) return null;
      out.push(encoded[idx++]);
    }
    if (code < 0xff && idx < end) {
      out.push(0);
    }
  }
  return Uint8Array.from(out);
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).toUpperCase().padStart(2, '0'))
    .join(' ');
}

export interface HilSimulationConfig {
  jitterMs: number;
  packetDropPct: number;
  seed: number;
}

function pseudoRand(seed: number): number {
  const x = Math.sin(seed * 12.9898 + 78.233) * 43758.5453;
  return x - Math.floor(x);
}

export function createHilPacket(
  model: ControlModel,
  sample: SimulationTrace['samples'][number],
  seq: number,
  prevConsecutiveMisses: number,
  hilSim: HilSimulationConfig
): { packet: HilFramePacket; nextConsecutiveMisses: number } {
  const budgetMs = model.baseDt * 1000;
  const tickUs = Math.round(sample.t * 1_000_000);
  const payload = [
    sample.ref,
    sample.silOutputs[0] ?? 0,
    sample.silOutputs[1] ?? 0,
    sample.uSat,
  ];

  // Pack binary frame: [SOF 2B] [SEQ 4B] [TICK_US 4B] [4x f32 16B] = 26 bytes + CRC16 2B = 28 bytes
  const buf = new ArrayBuffer(28);
  const view = new DataView(buf);
  view.setUint16(0, 0xaa55, false);
  view.setUint32(2, seq, true);
  view.setUint32(6, tickUs, true);
  view.setFloat32(10, payload[0], true);
  view.setFloat32(14, payload[1], true);
  view.setFloat32(18, payload[2], true);
  view.setFloat32(22, payload[3], true);

  const crc = crc16Ccitt(new Uint8Array(buf, 0, 26));
  view.setUint16(26, crc, true);

  const rawBytes = new Uint8Array(buf);
  const cobsActive = isHilCobsEnabled(model);
  const wireBytes = cobsActive ? cobsEncode(rawBytes) : rawBytes;

  // Deterministic fault & jitter evaluation
  const rDrop = pseudoRand(hilSim.seed + seq * 17);
  const rJitter = pseudoRand(hilSim.seed + seq * 31);
  const dropped = rDrop * 100 < hilSim.packetDropPct;

  const baseRtt =
    model.hil.transport === 'udp'
      ? 0.22
      : model.hil.transport === 'socketcan'
      ? 0.38
      : cobsActive
      ? 0.48
      : 0.44;
  const rttMs = dropped
    ? budgetMs * 1.5
    : Number((baseRtt + rJitter * hilSim.jitterMs).toFixed(3));
  const deadlineMissed = dropped || rttMs > budgetMs;

  const nextConsecutiveMisses = deadlineMissed ? prevConsecutiveMisses + 1 : 0;

  const watchdogState: HilFramePacket['watchdogState'] =
    nextConsecutiveMisses >= model.hil.watchdogMissLimit
      ? 'SAFE_CLAMP'
      : nextConsecutiveMisses > 0
      ? 'WARN'
      : 'NOMINAL';

  return {
    packet: {
      seq,
      tickUs,
      simTime: sample.t,
      transport: model.hil.transport,
      payloadFloats: payload,
      crc16: crc,
      rawHex: toHex(rawBytes),
      wireHex: toHex(wireBytes),
      byteLength: wireBytes.length,
      rttMs,
      dropped,
      deadlineMissed,
      watchdogState,
    },
    nextConsecutiveMisses,
  };
}

export function buildHilFrameStream(
  model: ControlModel,
  trace: SimulationTrace,
  hilSim: HilSimulationConfig
): HilFramePacket[] {
  const packets: HilFramePacket[] = [];
  const sampleCount = Math.min(48, trace.samples.length);
  const step = Math.max(1, Math.floor(trace.samples.length / sampleCount));
  let consecutiveMisses = 0;

  for (let idx = 0, seq = 1; idx < trace.samples.length && packets.length < 48; idx += step, seq++) {
    const res = createHilPacket(
      model,
      trace.samples[idx],
      seq,
      consecutiveMisses,
      hilSim
    );
    consecutiveMisses = res.nextConsecutiveMisses;
    packets.push(res.packet);
  }

  return packets;
}

export function generateEsp32HilDeserializationCpp(
  model: ControlModel,
  cobsEnabled: boolean
): string {
  const missLimit = Math.max(1, Math.round(model.hil.watchdogMissLimit));
  const dtUs = Math.max(200, Math.round(model.baseDt * 1e6));

  if (cobsEnabled) {
    return `/**
 * @file esp32_hil_rx.hpp
 * @brief ESP32 C++ COBS + CRC-16-CCITT Serial Deserializer for OpenLoop HIL
 *
 * Model    : ${model.name} (${model.id})
 * Protocol : UART Serial + Consistent Overhead Byte Stuffing (COBS, 0x00 delimiter)
 * Payload  : 28 B -> [SOF 0xAA 0x55][SEQ u32 LE][TICK_US u32 LE][4x f32 LE][CRC16 u16 LE]
 * Watchdog : ${missLimit} consecutive missed ticks -> safe clamp (${model.hil.safeClampValue})
 */
#pragma once

#include <Arduino.h>
#include <stdint.h>
#include <stddef.h>
#include <string.h>

extern "C" {
#include "ctrl_model.h"
#include "hil_frame.h"
}

struct HilDecodedFrame {
    uint32_t seq;
    uint32_t tick_us;
    float ref;
    float y0;
    float y1;
    float u_host;
    uint16_t crc16;
};

class HilCobsSerialReceiver {
public:
    static constexpr size_t RAW_FRAME_BYTES = 28U;
    static constexpr size_t MAX_COBS_BYTES  = 36U;

    bool pollFrame(Stream &serial, HilDecodedFrame &out_frame) {
        while (serial.available() > 0) {
            const int c = serial.read();
            if (c < 0) { break; }
            const uint8_t byte = static_cast<uint8_t>(c);

            if (byte == 0x00U) {
                const bool valid = (rx_len_ > 0U) && decodeAndVerify(rx_buf_, rx_len_, out_frame);
                rx_len_ = 0U;
                if (valid) { return true; }
            } else if (rx_len_ < MAX_COBS_BYTES) {
                rx_buf_[rx_len_++] = byte;
            } else {
                /* Overrun recovery: discard corrupt partial frame and wait for next 0x00 sync */
                rx_len_ = 0U;
            }
        }
        return false;
    }

    static bool decodeAndVerify(const uint8_t *encoded, size_t len, HilDecodedFrame &out) {
        uint8_t raw[RAW_FRAME_BYTES];
        const size_t decoded_len = hil_cobs_decode(encoded, len, raw, sizeof(raw));
        if (decoded_len != RAW_FRAME_BYTES) { return false; }

        /* Verify big-endian Start-of-Frame marker 0xAA 0x55 */
        if ((raw[0] != 0xAAU) || (raw[1] != 0x55U)) { return false; }

        uint16_t rx_crc = 0U;
        memcpy(&rx_crc, raw + 26U, sizeof(uint16_t));
        const uint16_t calc_crc = hil_crc16_ccitt(raw, 26U);
        if (rx_crc != calc_crc) { return false; }

        memcpy(&out.seq,     raw + 2U,  sizeof(uint32_t));
        memcpy(&out.tick_us, raw + 6U,  sizeof(uint32_t));
        memcpy(&out.ref,     raw + 10U, sizeof(float));
        memcpy(&out.y0,      raw + 14U, sizeof(float));
        memcpy(&out.y1,      raw + 18U, sizeof(float));
        memcpy(&out.u_host,  raw + 22U, sizeof(float));
        out.crc16 = rx_crc;
        return true;
    }

private:
    uint8_t rx_buf_[MAX_COBS_BYTES] = { 0 };
    size_t  rx_len_ = 0U;
};

/* Closed-loop tick integration (call every ${dtUs} us inside deterministic loop) */
inline void hil_closed_loop_cobs_tick(
    Stream &serial,
    HilCobsSerialReceiver &rx,
    CtrlState *ctrl,
    CtrlOutput *ctrl_out,
    uint32_t &consecutive_misses
) {
    static HilDecodedFrame last_frame = { 0U, 0U, 0.0f, 0.0f, 0.0f, 0.0f, 0U };
    HilDecodedFrame fresh;
    const bool got_packet = rx.pollFrame(serial, fresh);
    if (got_packet) {
        last_frame = fresh;
        consecutive_misses = 0U;
    } else if (consecutive_misses < 0xFFFFU) {
        consecutive_misses += 1U;
    }

    CtrlInput in;
    memset(&in, 0, sizeof(in));
    in.ref = last_frame.ref;
    in.meas_state[0] = last_frame.y0;
    if (CTRL_STATE_DIM > 1U) { in.meas_state[1] = last_frame.y1; }
    in.hil_rx_valid = (consecutive_misses < ${missLimit}U);

    ctrl_step(ctrl, &in, ctrl_out);
}
`;
  }

  return `/**
 * @file esp32_hil_rx.hpp
 * @brief ESP32 C++ Raw Binary Serial Deserializer for OpenLoop HIL (COBS Disabled)
 *
 * Model    : ${model.name} (${model.id})
 * Protocol : Raw Unstuffed Binary Serial (SOF 0xAA 0x55 sync, 28 B fixed frame)
 * Watchdog : ${missLimit} consecutive missed ticks -> safe clamp (${model.hil.safeClampValue})
 */
#pragma once

#include <Arduino.h>
#include <stdint.h>
#include <stddef.h>
#include <string.h>

extern "C" {
#include "ctrl_model.h"
#include "hil_frame.h"
}

struct HilDecodedFrame {
    uint32_t seq;
    uint32_t tick_us;
    float ref;
    float y0;
    float y1;
    float u_host;
    uint16_t crc16;
};

class HilRawSerialReceiver {
public:
    static constexpr size_t RAW_FRAME_BYTES = 28U;

    bool pollFrame(Stream &serial, HilDecodedFrame &out_frame) {
        while (serial.available() > 0) {
            const int c = serial.read();
            if (c < 0) { break; }
            const uint8_t byte = static_cast<uint8_t>(c);

            if (pos_ == 0U) {
                if (byte == 0xAAU) { buf_[pos_++] = byte; }
            } else if (pos_ == 1U) {
                if (byte == 0x55U) { buf_[pos_++] = byte; }
                else { pos_ = (byte == 0xAAU) ? 1U : 0U; }
            } else {
                buf_[pos_++] = byte;
                if (pos_ >= RAW_FRAME_BYTES) {
                    pos_ = 0U;
                    if (verifyRaw(buf_, out_frame)) { return true; }
                }
            }
        }
        return false;
    }

    static bool verifyRaw(const uint8_t *raw, HilDecodedFrame &out) {
        uint16_t rx_crc = 0U;
        memcpy(&rx_crc, raw + 26U, sizeof(uint16_t));
        if (rx_crc != hil_crc16_ccitt(raw, 26U)) { return false; }

        memcpy(&out.seq,     raw + 2U,  sizeof(uint32_t));
        memcpy(&out.tick_us, raw + 6U,  sizeof(uint32_t));
        memcpy(&out.ref,     raw + 10U, sizeof(float));
        memcpy(&out.y0,      raw + 14U, sizeof(float));
        memcpy(&out.y1,      raw + 18U, sizeof(float));
        memcpy(&out.u_host,  raw + 22U, sizeof(float));
        out.crc16 = rx_crc;
        return true;
    }

private:
    uint8_t buf_[RAW_FRAME_BYTES] = { 0 };
    size_t  pos_ = 0U;
};

/* Closed-loop tick integration (call every ${dtUs} us inside deterministic loop) */
inline void hil_closed_loop_raw_tick(
    Stream &serial,
    HilRawSerialReceiver &rx,
    CtrlState *ctrl,
    CtrlOutput *ctrl_out,
    uint32_t &consecutive_misses
) {
    static HilDecodedFrame last_frame = { 0U, 0U, 0.0f, 0.0f, 0.0f, 0.0f, 0U };
    HilDecodedFrame fresh;
    const bool got_packet = rx.pollFrame(serial, fresh);
    if (got_packet) {
        last_frame = fresh;
        consecutive_misses = 0U;
    } else if (consecutive_misses < 0xFFFFU) {
        consecutive_misses += 1U;
    }

    CtrlInput in;
    memset(&in, 0, sizeof(in));
    in.ref = last_frame.ref;
    in.meas_state[0] = last_frame.y0;
    if (CTRL_STATE_DIM > 1U) { in.meas_state[1] = last_frame.y1; }
    in.hil_rx_valid = (consecutive_misses < ${missLimit}U);

    ctrl_step(ctrl, &in, ctrl_out);
}
`;
}

