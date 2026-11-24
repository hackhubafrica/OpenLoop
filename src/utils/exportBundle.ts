import { ControlModel, DiscretizedMatrices } from '../types/control';
import { generateEmbeddedCode } from '../engine/codegen';
import {
  DEFAULT_ESP32_PIN_PROFILE,
  Esp32PinProfile,
  generateEsp32PlatformIoBundle,
} from '../engine/esp32Codegen';
import {
  generateEsp32HilDeserializationCpp,
  isHilCobsEnabled,
} from '../engine/hil';
import { serializeModelToToml } from '../engine/ir';

// CRC-32 lookup table for valid standard ZIP archives
const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc = CRC32_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export interface ZipEntry {
  name: string;
  content: string;
}

export function buildZipBytes(entries: ZipEntry[]): Uint8Array {
  const encoder = new TextEncoder();
  const localChunks: Uint8Array[] = [];
  const centralChunks: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = encoder.encode(entry.name);
    const dataBytes = encoder.encode(entry.content);
    const crc = crc32(dataBytes);

    // Local file header (30 bytes + name)
    const localHeader = new ArrayBuffer(30 + nameBytes.length);
    const lv = new DataView(localHeader);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0, true);
    lv.setUint16(8, 0, true); // Store (uncompressed)
    lv.setUint16(10, 0, true);
    lv.setUint16(12, 0, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, dataBytes.length, true);
    lv.setUint32(22, dataBytes.length, true);
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true);
    new Uint8Array(localHeader, 30).set(nameBytes);

    const localBytes = new Uint8Array(localHeader);
    localChunks.push(localBytes, dataBytes);

    // Central directory header (46 bytes + name)
    const centralHeader = new ArrayBuffer(46 + nameBytes.length);
    const cv = new DataView(centralHeader);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, 0, true);
    cv.setUint16(14, 0, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, dataBytes.length, true);
    cv.setUint32(24, dataBytes.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint16(30, 0, true);
    cv.setUint16(32, 0, true);
    cv.setUint16(34, 0, true);
    cv.setUint16(36, 0, true);
    cv.setUint32(38, 0, true);
    cv.setUint32(42, offset, true);
    new Uint8Array(centralHeader, 46).set(nameBytes);

    centralChunks.push(new Uint8Array(centralHeader));
    offset += localBytes.length + dataBytes.length;
  }

  const centralSize = centralChunks.reduce((acc, c) => acc + c.length, 0);
  const eocd = new ArrayBuffer(22);
  const ev = new DataView(eocd);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(4, 0, true);
  ev.setUint16(6, 0, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);
  ev.setUint16(20, 0, true);

  const allChunks = [...localChunks, ...centralChunks, new Uint8Array(eocd)];
  const totalLen = allChunks.reduce((sum, c) => sum + c.length, 0);
  const out = new Uint8Array(totalLen);
  let cursor = 0;
  for (const chunk of allChunks) {
    out.set(chunk, cursor);
    cursor += chunk.length;
  }
  return out;
}

function buildZipBlob(entries: ZipEntry[]): Blob {
  const bytes = buildZipBytes(entries);
  return new Blob([bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer], {
    type: 'application/zip',
  });
}

function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export function serializeModelToJson(model: ControlModel): string {
  const { injectAlgebraicLoopTest, ...persistedModel } = model;
  const payload = {
    schemaVersion: '1.0',
    ...(injectAlgebraicLoopTest ? { injectAlgebraicLoopTest: true } : {}),
    ...persistedModel,
  };
  return `${JSON.stringify(payload, null, 2)}\n`;
}

export function exportProjectBundle(
  model: ControlModel,
  discrete: DiscretizedMatrices
): void {
  const code = generateEmbeddedCode(model, discrete);
  const toml = serializeModelToToml(model);

  const pio = generateEsp32PlatformIoBundle(
    model,
    discrete,
    DEFAULT_ESP32_PIN_PROFILE
  );

  const readme = `# OpenLoop Export Bundle — ${model.name}

License: ${model.license}
Fixed Step (dt): ${model.baseDt} s (${Math.round(1 / model.baseDt)} Hz)
Discretization: ${discrete.method.toUpperCase()}

## Included Files
- model.ctrl.toml                : Declarative Git-friendly control model IR
- ctrl_model.h                   : Zero-allocation C99 public API & state struct
- ctrl_model.c                   : Deterministic C99 fixed-step implementation
- lib.rs                         : Standalone #![no_std] Rust controller crate
- hil_frame.h                    : COBS + CRC-16-CCITT HIL binary framing helpers
- esp32_platformio/              : Ready-to-flash PlatformIO ESP32 Arduino workspace

## Quick Build (C99 Host SIL Check)
cc -std=c99 -Wall -Wextra -Werror -c ctrl_model.c -o ctrl_model.o

## Quick Build (PlatformIO ESP32)
cd esp32_platformio && pio run -t upload

## Quick Build (no_std Rust)
rustc --crate-type lib --edition 2021 lib.rs -O
`;

  const esp32HilRxHeader = generateEsp32HilDeserializationCpp(
    model,
    isHilCobsEnabled(model)
  );

  const blob = buildZipBlob([
    { name: 'model.ctrl.toml', content: toml },
    { name: 'c99/ctrl_model.h', content: code.cHeader },
    { name: 'c99/ctrl_model.c', content: code.cSource },
    { name: 'c99/hil_frame.h', content: code.hilHeader },
    { name: 'rust_nostd/src/lib.rs', content: code.rustLib },
    { name: 'esp32_platformio/platformio.ini', content: pio.platformioIni },
    { name: 'esp32_platformio/include/ctrl_model.h', content: code.cHeader },
    { name: 'esp32_platformio/include/hil_frame.h', content: code.hilHeader },
    { name: 'esp32_platformio/include/esp32_hil_rx.hpp', content: esp32HilRxHeader },
    { name: 'esp32_platformio/src/ctrl_model.c', content: code.cSource },
    { name: 'esp32_platformio/src/main.cpp', content: pio.mainCpp },
    { name: 'esp32_platformio/WIRING.md', content: pio.wiringMarkdown },
    { name: 'README.md', content: readme },
  ]);

  triggerDownload(blob, `openloop-${model.id}-bundle.zip`);
}

export function buildPresetZipEntries(
  model: ControlModel,
  discrete: DiscretizedMatrices
): ZipEntry[] {
  const code = generateEmbeddedCode(model, discrete);
  const toml = serializeModelToToml(model);
  const json = serializeModelToJson(model);
  const root = `openloop-${model.id}`;
  const crateName = `openloop_${model.id.replace(/[^a-zA-Z0-9_]/g, '_')}`;

  const cmakeLists = `cmake_minimum_required(VERSION 3.16)
project(openloop_${model.id} LANGUAGES C)

set(CMAKE_C_STANDARD 99)
set(CMAKE_C_STANDARD_REQUIRED ON)
set(CMAKE_C_EXTENSIONS OFF)

add_library(openloop_ctrl STATIC
  ../src/ctrl_model.c
)

target_include_directories(openloop_ctrl PUBLIC
  ../include
)

if(MSVC)
  target_compile_options(openloop_ctrl PRIVATE /W4)
else()
  target_compile_options(openloop_ctrl PRIVATE -Wall -Wextra -Werror -pedantic)
endif()
`;

  const cargoToml = `[package]
name = "${crateName}"
version = "0.1.0"
edition = "2021"
license = "${model.license}"
description = "OpenLoop #![no_std] fixed-step controller for ${model.name}"

[lib]
crate-type = ["rlib", "staticlib"]

[profile.release]
opt-level = 3
lto = true
panic = "abort"
`;

  const presetReadme = `# OpenLoop Embedded Preset Package — ${model.name}

- Preset ID: \`${model.id}\`
- License: \`${model.license}\`
- Sample Period (dt): \`${model.baseDt} s\` (${Math.round(1 / model.baseDt)} Hz)
- Discretization: \`${discrete.method.toUpperCase()}\`
- Discrete Spectral Radius ρ(Ad): \`${discrete.spectralRadius.toFixed(6)}\`
- Plant Dimensions: ${model.plant.n} states × ${model.plant.m} input × ${model.plant.p} outputs

## Archive Layout
- \`model.ctrl.json\`         : Version-controlled JSON configuration snapshot
- \`model.ctrl.toml\`         : Declarative TOML control IR
- \`include/ctrl_model.h\`    : C99 public controller API & state struct
- \`include/hil_frame.h\`     : COBS + CRC-16-CCITT HIL binary telemetry header
- \`src/ctrl_model.c\`        : Zero-allocation C99 fixed-step kernel
- \`c99/CMakeLists.txt\`      : Drop-in CMake static library target
- \`rust/Cargo.toml\`         : Standalone \`#![no_std]\` Cargo manifest
- \`rust/src/lib.rs\`         : \`#![no_std]\` \`#[repr(C)]\` Rust controller crate

## CMake / Embedded GCC Build
\`\`\`sh
cmake -S c99 -B build && cmake --build build
# Or direct bare-metal compilation:
arm-none-eabi-gcc -std=c99 -O2 -Wall -Wextra -Iinclude -c src/ctrl_model.c -o ctrl_model.o
\`\`\`

## Rust #![no_std] Cross-Compile
\`\`\`sh
cd rust && cargo build --release --target thumbv7em-none-eabihf
\`\`\`
`;

  return [
    { name: `${root}/model.ctrl.json`, content: json },
    { name: `${root}/model.ctrl.toml`, content: toml },
    { name: `${root}/include/ctrl_model.h`, content: code.cHeader },
    { name: `${root}/include/hil_frame.h`, content: code.hilHeader },
    { name: `${root}/src/ctrl_model.c`, content: code.cSource },
    { name: `${root}/c99/CMakeLists.txt`, content: cmakeLists },
    { name: `${root}/rust/Cargo.toml`, content: cargoToml },
    { name: `${root}/rust/src/lib.rs`, content: code.rustLib },
    { name: `${root}/README.md`, content: presetReadme },
  ];
}

/**
 * Packages the current preset model configuration (JSON + TOML) alongside
 * generated C99/Rust headers, sources, and toolchain manifests into a ZIP archive.
 */
export function exportPresetZip(
  model: ControlModel,
  discrete: DiscretizedMatrices
): void {
  const entries = buildPresetZipEntries(model, discrete);
  const blob = buildZipBlob(entries);
  triggerDownload(blob, `openloop-${model.id}-preset.zip`);
}

/**
 * Downloads the current ControlModel state as a formatted, trailing-newline
 * JSON file tailored for clean Git diffs and version control.
 */
export function saveModelAsJson(model: ControlModel): void {
  const json = serializeModelToJson(model);
  const blob = new Blob([json], { type: 'application/json;charset=utf-8' });
  triggerDownload(blob, `openloop-${model.id}.ctrl.json`);
}

export function buildEsp32PlatformIoZipEntries(
  model: ControlModel,
  discrete: DiscretizedMatrices,
  profile: Esp32PinProfile = DEFAULT_ESP32_PIN_PROFILE
): ZipEntry[] {
  const code = generateEmbeddedCode(model, discrete);
  const pio = generateEsp32PlatformIoBundle(model, discrete, profile);
  const cobsActive = isHilCobsEnabled(model);
  const esp32HilRxHeader = generateEsp32HilDeserializationCpp(model, cobsActive);
  const toml = serializeModelToToml(model);
  const root = `openloop-${model.id}-esp32-pio`;

  const pioReadme = `# OpenLoop PlatformIO ESP32 Project — ${model.name}

- Target Board Environment: \`${pio.boardSpec.label}\` (\`${pio.boardSpec.id}\`)
- Control Loop Period: \`dt = ${model.baseDt} s\` (${Math.round(1 / model.baseDt)} Hz) · ${discrete.method.toUpperCase()}
- HIL Serial Framing: \`${cobsActive ? 'COBS (0x00 delimiter) + CRC-16-CCITT' : 'Raw 28B Binary + CRC-16-CCITT'}\`

## Included Files
- \`platformio.ini\`            : Pre-configured PlatformIO build flags, baud rate & sensor dependencies
- \`include/ctrl_model.h\`      : Zero-allocation C99 public controller API & state struct
- \`include/hil_frame.h\`       : Binary HIL frame struct, CRC-16-CCITT & COBS codec
- \`include/esp32_hil_rx.hpp\`  : C++ ESP32 closed-loop HIL serial deserializer header
- \`src/ctrl_model.c\`          : Discretized C99 fixed-step control loop kernel
- \`src/main.cpp\`              : Arduino framework firmware entrypoint & sensor/PWM loop
- \`WIRING.md\`                 : GPIO hardware mapping & electrical protection guide

## Build & Upload (PlatformIO CLI)
\`\`\`sh
pio run -e ${pio.boardSpec.id}
pio run -e ${pio.boardSpec.id} -t upload
pio device monitor -b ${profile.baudRate}
\`\`\`
`;

  return [
    { name: `${root}/platformio.ini`, content: pio.platformioIni },
    { name: `${root}/include/ctrl_model.h`, content: code.cHeader },
    { name: `${root}/include/hil_frame.h`, content: code.hilHeader },
    { name: `${root}/include/esp32_hil_rx.hpp`, content: esp32HilRxHeader },
    { name: `${root}/src/ctrl_model.c`, content: code.cSource },
    { name: `${root}/src/main.cpp`, content: pio.mainCpp },
    { name: `${root}/model.ctrl.toml`, content: toml },
    { name: `${root}/WIRING.md`, content: pio.wiringMarkdown },
    { name: `${root}/README.md`, content: pioReadme },
  ];
}

export function exportEsp32PlatformIoZip(
  model: ControlModel,
  discrete: DiscretizedMatrices,
  profile: Esp32PinProfile = DEFAULT_ESP32_PIN_PROFILE
): void {
  const entries = buildEsp32PlatformIoZipEntries(model, discrete, profile);
  const blob = buildZipBlob(entries);
  triggerDownload(blob, `openloop-${model.id}-${profile.boardEnv}-pio.zip`);
}

export function exportTextFile(
  filename: string,
  content: string,
  mimeType: string = 'text/plain;charset=utf-8'
): void {
  const blob = new Blob([content], { type: mimeType });
  triggerDownload(blob, filename);
}
