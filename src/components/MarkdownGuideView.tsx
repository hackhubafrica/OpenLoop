import React, { useMemo, useState } from 'react';
import { BookOpen, Check, Code2, Copy, FileText, Play, Search } from 'lucide-react';

export type MarkdownBlock =
  | { type: 'heading'; level: 1 | 2 | 3; text: string; id: string }
  | { type: 'paragraph'; text: string }
  | { type: 'code'; lang: string; code: string }
  | { type: 'blockquote'; lines: string[] }
  | { type: 'list'; ordered: boolean; items: string[] }
  | { type: 'table'; headers: string[]; rows: string[][] }
  | { type: 'hr' };

export function slugifyHeading(text: string): string {
  return text
    .toLowerCase()
    .replace(/[`*_~]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

function splitTableRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return trimmed.split('|').map((cell) => cell.trim());
}

function isTableSeparator(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed.includes('|')) return false;
  return /^\|?(\s*:?-{3,}:?\s*\|)+\s*:?-{3,}:?\s*\|?$/.test(trimmed);
}

/**
 * Deterministic, XSS-safe block Markdown parser for structured engineering docs.
 */
export function parseMarkdownBlocks(markdown: string): MarkdownBlock[] {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const blocks: MarkdownBlock[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    if (!trimmed) {
      i += 1;
      continue;
    }

    // Fenced code block
    if (trimmed.startsWith('```')) {
      const lang = trimmed.slice(3).trim();
      const codeLines: string[] = [];
      i += 1;
      while (i < lines.length && !lines[i].trim().startsWith('```')) {
        codeLines.push(lines[i]);
        i += 1;
      }
      if (i < lines.length && lines[i].trim().startsWith('```')) {
        i += 1;
      }
      blocks.push({
        type: 'code',
        lang: lang || 'text',
        code: codeLines.join('\n'),
      });
      continue;
    }

    // Horizontal rule
    if (/^---+$/.test(trimmed)) {
      blocks.push({ type: 'hr' });
      i += 1;
      continue;
    }

    // Headings (#, ##, ###)
    const headingMatch = trimmed.match(/^(#{1,3})\s+(.+)$/);
    if (headingMatch) {
      const level = headingMatch[1].length as 1 | 2 | 3;
      const text = headingMatch[2].trim();
      blocks.push({
        type: 'heading',
        level,
        text,
        id: slugifyHeading(text),
      });
      i += 1;
      continue;
    }

    // Markdown table
    if (
      trimmed.includes('|') &&
      i + 1 < lines.length &&
      isTableSeparator(lines[i + 1])
    ) {
      const headers = splitTableRow(trimmed);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].trim().includes('|')) {
        rows.push(splitTableRow(lines[i]));
        i += 1;
      }
      blocks.push({ type: 'table', headers, rows });
      continue;
    }

    // Blockquote
    if (trimmed.startsWith('>')) {
      const quoteLines: string[] = [];
      while (i < lines.length && lines[i].trim().startsWith('>')) {
        quoteLines.push(lines[i].trim().replace(/^>\s?/, ''));
        i += 1;
      }
      blocks.push({ type: 'blockquote', lines: quoteLines });
      continue;
    }

    // Ordered or unordered list
    const ulMatch = trimmed.match(/^[-*]\s+(.+)$/);
    const olMatch = trimmed.match(/^\d+\.\s+(.+)$/);
    if (ulMatch || olMatch) {
      const ordered = Boolean(olMatch);
      const items: string[] = [];
      while (i < lines.length) {
        const curTrimmed = lines[i].trim();
        const match = ordered
          ? curTrimmed.match(/^\d+\.\s+(.+)$/)
          : curTrimmed.match(/^[-*]\s+(.+)$/);
        if (match) {
          items.push(match[1]);
          i += 1;
          // Append indented sub-bullets / continuation lines cleanly
          while (
            i < lines.length &&
            /^\s{2,}[-*]\s+/.test(lines[i])
          ) {
            items[items.length - 1] += `\n${lines[i].trim()}`;
            i += 1;
          }
        } else {
          break;
        }
      }
      blocks.push({ type: 'list', ordered, items });
      continue;
    }

    // Paragraph (coalesce contiguous plain lines)
    const paraLines: string[] = [];
    while (i < lines.length) {
      const cur = lines[i];
      const curTrim = cur.trim();
      if (
        !curTrim ||
        curTrim.startsWith('```') ||
        curTrim.startsWith('#') ||
        curTrim.startsWith('>') ||
        /^---+$/.test(curTrim) ||
        /^[-*]\s+/.test(curTrim) ||
        /^\d+\.\s+/.test(curTrim) ||
        (curTrim.includes('|') &&
          i + 1 < lines.length &&
          isTableSeparator(lines[i + 1]))
      ) {
        break;
      }
      paraLines.push(curTrim);
      i += 1;
    }
    blocks.push({ type: 'paragraph', text: paraLines.join(' ') });
  }

  return blocks;
}

/**
 * Renders inline Markdown tokens (`code`, **bold**, *italic*) as pure React nodes.
 */
function renderInlineTokens(text: string): React.ReactNode[] {
  const tokens: React.ReactNode[] = [];
  const regex = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let keyIdx = 0;

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      tokens.push(text.slice(lastIndex, match.index));
    }
    const token = match[0];
    if (token.startsWith('`') && token.endsWith('`')) {
      tokens.push(
        <code
          key={`ic-${keyIdx++}`}
          className="px-1.5 py-0.5 mx-0.5 rounded bg-[#07090E] border border-slate-800 text-cyan-300 font-mono text-[11px]"
        >
          {token.slice(1, -1)}
        </code>
      );
    } else if (token.startsWith('**') && token.endsWith('**')) {
      tokens.push(
        <strong key={`ib-${keyIdx++}`} className="font-semibold text-slate-100">
          {token.slice(2, -2)}
        </strong>
      );
    } else if (token.startsWith('*') && token.endsWith('*')) {
      tokens.push(
        <em key={`ii-${keyIdx++}`} className="italic text-slate-200">
          {token.slice(1, -1)}
        </em>
      );
    }
    lastIndex = regex.lastIndex;
  }

  if (lastIndex < text.length) {
    tokens.push(text.slice(lastIndex));
  }
  return tokens;
}

interface MarkdownGuideViewProps {
  markdown: string;
  onLoadTomlExample?: (toml: string) => void;
}

export const MarkdownGuideView: React.FC<MarkdownGuideViewProps> = ({
  markdown,
  onLoadTomlExample,
}) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [viewMode, setViewMode] = useState<'rendered' | 'raw'>('rendered');
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  const blocks = useMemo(() => parseMarkdownBlocks(markdown), [markdown]);

  const headings = useMemo(
    () =>
      blocks.filter(
        (b): b is Extract<MarkdownBlock, { type: 'heading' }> =>
          b.type === 'heading' && b.level <= 2
      ),
    [blocks]
  );

  const filteredBlocks = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return blocks;
    return blocks.filter((b) => {
      if (b.type === 'heading' || b.type === 'paragraph') {
        return b.text.toLowerCase().includes(q);
      }
      if (b.type === 'code') return b.code.toLowerCase().includes(q);
      if (b.type === 'blockquote') {
        return b.lines.some((l) => l.toLowerCase().includes(q));
      }
      if (b.type === 'list') {
        return b.items.some((it) => it.toLowerCase().includes(q));
      }
      if (b.type === 'table') {
        return (
          b.headers.some((h) => h.toLowerCase().includes(q)) ||
          b.rows.some((r) => r.some((c) => c.toLowerCase().includes(q)))
        );
      }
      return false;
    });
  }, [blocks, searchQuery]);

  const handleCopy = async (key: string, value: string) => {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(value);
      } catch {
        // Fallback silently if clipboard permissions are restricted
      }
    }
    setCopiedKey(key);
    window.setTimeout(() => setCopiedKey(null), 1600);
  };

  const jumpToHeading = (id: string) => {
    setViewMode('rendered');
    setSearchQuery('');
    window.requestAnimationFrame(() => {
      const el = document.getElementById(`docs-sec-${id}`);
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  };

  return (
    <div className="flex-1 flex flex-col min-h-0 bg-[#07090E]">
      {/* Documentation Sub-Toolbar */}
      <div className="px-5 py-2.5 border-b border-slate-800 bg-[#0B0E17] flex flex-wrap items-center justify-between gap-3 shrink-0">
        <div className="flex items-center gap-2">
          <BookOpen className="w-3.5 h-3.5 text-cyan-400" />
          <span className="text-xs font-semibold text-slate-200">
            Templating Engine &amp; Block Schema Reference
          </span>
          <span className="text-slate-600" aria-hidden="true">
            ·
          </span>
          <span className="text-[11px] font-mono text-slate-400">
            Markdown Spec (v1.0)
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="relative">
            <Search className="w-3.5 h-3.5 text-slate-500 absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Filter guide..."
              aria-label="Filter templating documentation"
              className="w-44 bg-[#07090E] border border-slate-800 rounded pl-8 pr-2.5 py-1 text-xs text-slate-200 placeholder:text-slate-500 focus:outline-none focus:border-cyan-400"
            />
          </div>

          <div
            className="flex items-center gap-0.5 p-0.5 bg-[#07090E] border border-slate-800 rounded"
            role="group"
            aria-label="Markdown view mode"
          >
            <button
              type="button"
              onClick={() => setViewMode('rendered')}
              className={`inline-flex items-center gap-1 px-2 py-1 text-[11px] font-mono rounded transition-colors cursor-pointer whitespace-nowrap ${
                viewMode === 'rendered'
                  ? 'bg-slate-800 text-cyan-300'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <FileText className="w-3 h-3" />
              Guide
            </button>
            <button
              type="button"
              onClick={() => setViewMode('raw')}
              className={`inline-flex items-center gap-1 px-2 py-1 text-[11px] font-mono rounded transition-colors cursor-pointer whitespace-nowrap ${
                viewMode === 'raw'
                  ? 'bg-slate-800 text-cyan-300'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <Code2 className="w-3 h-3" />
              Raw .md
            </button>
          </div>
        </div>
      </div>

      {/* Section Jump Strip */}
      {viewMode === 'rendered' && (
        <div className="px-5 py-2 border-b border-slate-800/80 bg-[#0B0E17]/60 flex flex-wrap items-center gap-2 shrink-0">
          <span className="text-[10px] font-mono uppercase tracking-wider text-slate-500 mr-1">
            Sections:
          </span>
          {headings
            .filter((h) => h.level === 2)
            .map((h) => (
              <button
                key={h.id}
                type="button"
                onClick={() => jumpToHeading(h.id)}
                className="px-2 py-0.5 text-[11px] font-mono text-slate-300 hover:text-cyan-300 bg-[#0F141E] border border-slate-800 hover:border-cyan-500/40 rounded transition-colors cursor-pointer whitespace-nowrap"
              >
                {h.text}
              </button>
            ))}
        </div>
      )}

      {/* Body Content */}
      <div className="flex-1 overflow-y-auto px-6 py-5">
        {viewMode === 'raw' ? (
          <div className="max-w-4xl space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-xs font-mono text-slate-400">
                templating_engine_guide.md
              </span>
              <button
                type="button"
                onClick={() => handleCopy('raw-md', markdown)}
                className="inline-flex items-center gap-1.5 px-2.5 py-1 text-[11px] font-mono border border-slate-700 bg-[#0F141E] hover:bg-slate-800 text-slate-200 rounded transition-colors cursor-pointer"
              >
                {copiedKey === 'raw-md' ? (
                  <>
                    <Check className="w-3 h-3 text-emerald-400" />
                    Copied
                  </>
                ) : (
                  <>
                    <Copy className="w-3 h-3 text-cyan-400" />
                    Copy Markdown
                  </>
                )}
              </button>
            </div>
            <pre className="p-4 rounded border border-slate-800 bg-[#0B0E17] text-xs font-mono text-slate-300 leading-relaxed overflow-x-auto whitespace-pre-wrap">
              {markdown}
            </pre>
          </div>
        ) : (
          <article className="max-w-4xl space-y-4 text-sm text-slate-300 leading-relaxed">
            {filteredBlocks.length === 0 ? (
              <div className="p-6 rounded border border-slate-800 bg-[#0B0E17] text-xs font-mono text-slate-400">
                No documentation sections match "{searchQuery}".
              </div>
            ) : (
              filteredBlocks.map((block, idx) => {
                if (block.type === 'heading') {
                  if (block.level === 1) {
                    return (
                      <h2
                        key={`h-${idx}`}
                        id={`docs-sec-${block.id}`}
                        className="text-lg font-semibold text-slate-100 tracking-tight"
                      >
                        {renderInlineTokens(block.text)}
                      </h2>
                    );
                  }
                  if (block.level === 2) {
                    return (
                      <h3
                        key={`h-${idx}`}
                        id={`docs-sec-${block.id}`}
                        className="text-sm font-semibold text-cyan-300 pt-2 border-b border-slate-800/80 pb-1.5"
                      >
                        {renderInlineTokens(block.text)}
                      </h3>
                    );
                  }
                  return (
                    <h4
                      key={`h-${idx}`}
                      id={`docs-sec-${block.id}`}
                      className="text-xs font-mono uppercase tracking-wider text-slate-200 pt-1"
                    >
                      {renderInlineTokens(block.text)}
                    </h4>
                  );
                }

                if (block.type === 'hr') {
                  return <hr key={`hr-${idx}`} className="border-slate-800/80 my-2" />;
                }

                if (block.type === 'paragraph') {
                  return (
                    <p key={`p-${idx}`} className="text-[13px] text-slate-300 leading-6">
                      {renderInlineTokens(block.text)}
                    </p>
                  );
                }

                if (block.type === 'blockquote') {
                  return (
                    <blockquote
                      key={`bq-${idx}`}
                      className="border-l-2 border-cyan-500/60 bg-[#0F141E] px-4 py-2.5 rounded-r text-xs text-slate-300 space-y-1"
                    >
                      {block.lines.map((line, lIdx) => (
                        <p key={lIdx}>{renderInlineTokens(line)}</p>
                      ))}
                    </blockquote>
                  );
                }

                if (block.type === 'list') {
                  const ListTag = block.ordered ? 'ol' : 'ul';
                  return (
                    <ListTag
                      key={`list-${idx}`}
                      className={`space-y-1.5 pl-5 text-[13px] text-slate-300 ${
                        block.ordered ? 'list-decimal' : 'list-disc'
                      }`}
                    >
                      {block.items.map((item, itemIdx) => {
                        const subLines = item.split('\n');
                        return (
                          <li key={itemIdx} className="leading-6">
                            <span>{renderInlineTokens(subLines[0])}</span>
                            {subLines.length > 1 && (
                              <ul className="list-disc pl-5 mt-1 space-y-1 text-slate-400">
                                {subLines.slice(1).map((sub, sIdx) => (
                                  <li key={sIdx}>
                                    {renderInlineTokens(sub.replace(/^[-*]\s+/, ''))}
                                  </li>
                                ))}
                              </ul>
                            )}
                          </li>
                        );
                      })}
                    </ListTag>
                  );
                }

                if (block.type === 'table') {
                  return (
                    <div
                      key={`tbl-${idx}`}
                      className="overflow-x-auto rounded border border-slate-800 bg-[#0B0E17]"
                    >
                      <table className="w-full text-left border-collapse text-xs">
                        <thead>
                          <tr className="bg-[#0F141E] border-b border-slate-800">
                            {block.headers.map((head, hIdx) => (
                              <th
                                key={hIdx}
                                className="px-3 py-2 font-semibold text-slate-200 whitespace-nowrap"
                              >
                                {renderInlineTokens(head)}
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-800/70">
                          {block.rows.map((row, rIdx) => (
                            <tr key={rIdx} className="hover:bg-[#0F141E]/50">
                              {row.map((cell, cIdx) => (
                                <td
                                  key={cIdx}
                                  className="px-3 py-2 text-slate-300 align-top"
                                >
                                  {renderInlineTokens(cell)}
                                </td>
                              ))}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  );
                }

                if (block.type === 'code') {
                  const codeKey = `code-${idx}`;
                  const isFullTomlModel =
                    block.lang.toLowerCase() === 'toml' &&
                    block.code.includes('[model]') &&
                    block.code.includes('[plant.state_space]');
                  return (
                    <div
                      key={codeKey}
                      className="rounded border border-slate-800 bg-[#0B0E17] overflow-hidden"
                    >
                      <div className="px-3 py-1.5 border-b border-slate-800 bg-[#0F141E] flex items-center justify-between gap-2">
                        <span className="text-[10px] font-mono uppercase tracking-wider text-slate-400">
                          {block.lang}
                        </span>
                        <div className="flex items-center gap-2">
                          {isFullTomlModel && onLoadTomlExample && (
                            <button
                              type="button"
                              onClick={() => onLoadTomlExample(block.code)}
                              className="inline-flex items-center gap-1 px-2 py-0.5 text-[10px] font-mono text-cyan-300 bg-cyan-500/10 hover:bg-cyan-500/20 border border-cyan-500/30 rounded transition-colors cursor-pointer"
                            >
                              <Play className="w-2.5 h-2.5" />
                              Load into IR Editor
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() => handleCopy(codeKey, block.code)}
                            className="inline-flex items-center gap-1 px-2 py-0.5 text-[10px] font-mono text-slate-300 hover:text-slate-100 bg-[#07090E] border border-slate-800 rounded transition-colors cursor-pointer"
                          >
                            {copiedKey === codeKey ? (
                              <>
                                <Check className="w-2.5 h-2.5 text-emerald-400" />
                                Copied
                              </>
                            ) : (
                              <>
                                <Copy className="w-2.5 h-2.5 text-slate-400" />
                                Copy
                              </>
                            )}
                          </button>
                        </div>
                      </div>
                      <pre className="p-3.5 text-xs font-mono text-slate-200 leading-5 overflow-x-auto">
                        <code>{block.code}</code>
                      </pre>
                    </div>
                  );
                }

                return null;
              })
            )}
          </article>
        )}
      </div>
    </div>
  );
};
