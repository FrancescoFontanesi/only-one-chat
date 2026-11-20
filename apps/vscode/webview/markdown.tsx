// The agents' Markdown, drawn as Preact elements and never as HTML (threat T6
// in docs/security.md): HTML a model writes stays visible text, so there is
// nothing to sanitize. The subset the CLIs write: headings, paragraphs, lists,
// quotes, fenced code, tables, rules; inline code, bold, italic, links. A link
// to a file the host found in the folder, or inline code naming one, opens it
// in the editor (ADR 0018); any other link shows its text, with the address
// as its title: the webview has no network and opens nothing. Text still
// streaming is drawn as it stands (an unclosed fence is code to the end).

import { createContext, Fragment, type ComponentChildren } from 'preact';
import { useContext } from 'preact/hooks';
import katex from 'katex';
import { linkPath } from '../src/webview/refs.js';
import { parseBlocks, parseInline, type Inline } from './markdownModel.js';
import { post } from './ui.js';

type Leaf = (text: string) => ComponentChildren;

/** Formulas already drawn: a streaming turn draws the same text many times. */
const drawn = new Map<string, string>();

/**
 * LaTeX as MathML (ADR 0024): KaTeX writes the markup, not the model. No HTML
 * or links from the formula (`trust: false`), bounded sizes and macro
 * expansion; an error shows the formula as written.
 */
function Formula({ tex, display }: { tex: string; display: boolean }) {
  const key = `${display ? 'D' : 'I'}${tex}`;
  let markup = drawn.get(key);
  if (markup === undefined) {
    markup = katex.renderToString(tex, {
      output: 'mathml',
      displayMode: display,
      throwOnError: false,
      trust: false,
      strict: 'ignore',
      maxSize: 50,
      maxExpand: 500,
    });
    if (drawn.size > 500) drawn.clear();
    drawn.set(key, markup);
  }
  // KaTeX's own MathML, never the model's HTML (ADR 0024).
  return (
    <span
      class={display ? 'md-math md-math--block' : 'md-math'}
      dangerouslySetInnerHTML={{ __html: markup }}
    />
  );
}

/** The links and inline paths the host found in the folder, as written. */
const Refs = createContext<readonly string[]>([]);

/** A file of the folder an agent named: a click opens it at its lines. */
/**
 * A file of the folder an agent named, as a chip (as Copilot Chat and Claude
 * Code show them): its name, the lines muted after it, the whole path as the
 * title; a click opens it at its lines.
 */
function FileRef({ raw, label }: { raw: string; label: string }) {
  const target = linkPath(raw);
  if (!target) return <>{label}</>;
  const { path, lines } = target;
  // The name as the agent wrote it, without the line range it may carry.
  const name = linkPath(label)?.path ?? label;
  const range = lines
    ? lines.from === lines.to
      ? `:${String(lines.from)}`
      : `:${String(lines.from)}-${String(lines.to)}`
    : '';
  return (
    <button
      class="ref"
      type="button"
      title={`Open ${path}${range}`}
      onClick={() => {
        post({ type: 'openFile', path, ...(lines ? { from: lines.from, to: lines.to } : {}) });
      }}
    >
      {name}
      {range && <span class="ref__l">{range}</span>}
    </button>
  );
}

function Inlines({ parts, leaf }: { parts: readonly Inline[]; leaf: Leaf }) {
  const refs = useContext(Refs);
  return (
    <>
      {parts.map((part, index) => {
        switch (part.kind) {
          case 'text':
            return <Fragment key={index}>{leaf(part.text)}</Fragment>;
          case 'code':
            return refs.includes(part.text) ? (
              <FileRef key={index} raw={part.text} label={part.text} />
            ) : (
              <code key={index} class="md-code">
                {leaf(part.text)}
              </code>
            );
          case 'strong':
            return (
              <strong key={index}>
                <Inlines parts={part.children} leaf={leaf} />
              </strong>
            );
          case 'em':
            return (
              <em key={index}>
                <Inlines parts={part.children} leaf={leaf} />
              </em>
            );
          case 'math':
            return <Formula key={index} tex={part.tex} display={part.display} />;
          case 'link':
            return refs.includes(part.url) ? (
              <FileRef key={index} raw={part.url} label={part.text} />
            ) : (
              <span key={index} title={part.url}>
                {part.text}
              </span>
            );
        }
      })}
    </>
  );
}

const line = (text: string, leaf: Leaf) => <Inlines parts={parseInline(text)} leaf={leaf} />;

/** A text of an agent, as Markdown; `leaf` draws plain text (the `@` paths as links). */
export function Markdown({
  text,
  leaf = (t) => t,
  refs = [],
  class: cls,
}: {
  text: string;
  leaf?: Leaf;
  /** The host's `refs` of the turn: which links and inline paths name files of the folder. */
  refs?: readonly string[] | undefined;
  class?: string;
}) {
  return (
    <Refs.Provider value={refs}>
      <div class={cls ? `md ${cls}` : 'md'}>
        {parseBlocks(text).map((block, index) => {
          switch (block.kind) {
            case 'heading':
              return (
                <p key={index} class={`md-h md-h${String(Math.min(block.level, 3))}`}>
                  {line(block.text, leaf)}
                </p>
              );
            case 'p':
              return <p key={index}>{line(block.text, leaf)}</p>;
            case 'code':
              return (
                <pre key={index} class="md-pre" data-lang={block.lang || undefined}>
                  <code>{block.text}</code>
                </pre>
              );
            case 'quote':
              return (
                <blockquote key={index} class="md-quote">
                  {line(block.text, leaf)}
                </blockquote>
              );
            case 'list':
              return (
                <ul key={index} class="md-list">
                  {block.items.map((item, at) => (
                    <li
                      key={at}
                      class={item.depth > 0 ? `md-d${String(Math.min(item.depth, 3))}` : undefined}
                    >
                      <span class="md-mark" aria-hidden="true">
                        {item.marker}
                      </span>
                      <span>{line(item.text, leaf)}</span>
                    </li>
                  ))}
                </ul>
              );
            case 'table':
              return (
                <div key={index} class="md-table">
                  <table>
                    <thead>
                      <tr>
                        {block.head.map((cell, at) => (
                          <th key={at}>{line(cell, leaf)}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {block.rows.map((row, r) => (
                        <tr key={r}>
                          {row.map((cell, at) => (
                            <td key={at}>{line(cell, leaf)}</td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              );
            case 'rule':
              return <hr key={index} class="md-rule" />;
            case 'math':
              return <Formula key={index} tex={block.tex} display />;
          }
        })}
      </div>
    </Refs.Provider>
  );
}
