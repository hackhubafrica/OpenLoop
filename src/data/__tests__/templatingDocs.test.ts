import { describe, expect, it } from 'vitest';
import { TEMPLATING_ENGINE_DOCS_MD } from '../templatingDocs';
import { parseMarkdownBlocks } from '../../components/MarkdownGuideView';
import { PRESET_MODELS } from '../presets';
import { parseTomlToModel } from '../../engine/ir';
import { validateControlModel } from '../../engine/validator';
import { importModelFromText } from '../../utils/modelHelpers';

describe('templatingDocs & MarkdownGuideView parser', () => {
  it('parses structured Markdown sections, tables, blockquotes, lists, and code snippets', () => {
    const blocks = parseMarkdownBlocks(TEMPLATING_ENGINE_DOCS_MD);

    const headings = blocks.filter((b) => b.type === 'heading');
    const tables = blocks.filter((b) => b.type === 'table');
    const quotes = blocks.filter((b) => b.type === 'blockquote');
    const lists = blocks.filter((b) => b.type === 'list');
    const codeBlocks = blocks.filter((b) => b.type === 'code');

    expect(headings.length).toBeGreaterThanOrEqual(5);
    expect(tables.length).toBeGreaterThanOrEqual(2);
    expect(quotes.length).toBeGreaterThanOrEqual(2);
    expect(lists.length).toBeGreaterThanOrEqual(2);
    expect(codeBlocks.length).toBeGreaterThanOrEqual(4);

    // Ensure all BlockKind primitives are documented
    const blockKinds = [
      'step_ref',
      'sum',
      'lqr_gain',
      'pid',
      'rate_limiter',
      'saturation',
      'rate_transition',
      'state_space',
      'hil_io',
    ];
    for (const kind of blockKinds) {
      expect(TEMPLATING_ENGINE_DOCS_MD).toContain(kind);
    }
  });

  it('includes a complete TOML starter template that parses and validates cleanly', () => {
    const blocks = parseMarkdownBlocks(TEMPLATING_ENGINE_DOCS_MD);
    const fullTomlBlock = blocks.find(
      (b): b is Extract<typeof b, { type: 'code' }> =>
        b.type === 'code' &&
        b.lang === 'toml' &&
        b.code.includes('[model]') &&
        b.code.includes('[plant.state_space]')
    );

    expect(fullTomlBlock).toBeDefined();
    const tomlCode = fullTomlBlock!.code;

    const { model: parsed, parseError } = parseTomlToModel(
      tomlCode,
      PRESET_MODELS.pendulum
    );
    expect(parseError).toBeNull();
    expect(parsed.id).toBe('dual_zone_thermal');
    expect(parsed.plant.n).toBe(2);
    expect(parsed.plant.m).toBe(2);
    expect(parsed.plant.p).toBe(2);

    const validation = validateControlModel(parsed);
    expect(validation.valid).toBe(true);
    expect(validation.issues).toHaveLength(0);

    const imported = importModelFromText(
      'starter.ctrl.toml',
      tomlCode,
      PRESET_MODELS.pendulum
    );
    expect(imported.error).toBeNull();
    expect(imported.model.id).toBe('dual_zone_thermal');
  });
});
