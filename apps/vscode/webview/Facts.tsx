// What the extension verified, shown in the thread: the facts after an
// implementer's turn and the runtime verification's evidence. Apart from the
// agents' own words (ADR 0010, 0030).

import type { ThreadItem } from './state.js';
import { readFacts } from './threadModel.js';
import { post } from './ui.js';

type Item<K extends ThreadItem['kind']> = Extract<ThreadItem, { kind: K }>;

export function FactsTurn({ text, number }: { text: string; number: string | undefined }) {
  const facts = readFacts(text);
  return (
    <section class="turn">
      <div class="who">
        <b>EXTENSION</b>
        <span>VERIFIED FACTS</span>
        {number && <span>D{number}</span>}
      </div>
      <div class="tb">
        <dl class="cn-spec facts">
          <dt>FILES CHANGED</dt>
          <dd class="t-data">
            {facts.files.length > 0
              ? facts.files.map((f) => f.replace(/^(added|modified|deleted) /, '')).join(' · ')
              : 'none'}
          </dd>
          {facts.verify && (
            <>
              <dt>VERIFICATION</dt>
              <dd class="t-data">{facts.verify}</dd>
            </>
          )}
          {facts.failed.length > 0 && (
            <>
              <dt>FAILED TESTS</dt>
              <dd class="t-data">{facts.failed.join(' · ')}</dd>
            </>
          )}
        </dl>
        {facts.output && <pre class="outp">{facts.output}</pre>}
      </div>
    </section>
  );
}

export function Verification({ item }: { item: Item<'verification'> }) {
  return (
    <section class="turn">
      <div class="who">
        <b>EXTENSION</b>
        <span>VERIFICATION</span>
      </div>
      <div class="tb">
        <span class="t-data">
          {item.evidence.comparison === 'pending' && item.evidence.budget !== undefined
            ? `Corrections ${String(item.evidence.round ?? 0)}/${String(item.evidence.budget)} · `
            : ''}
          {item.evidence.status} · Red-green {item.evidence.comparison.replaceAll('_', ' ')}
        </span>{' '}
        <button
          type="button"
          class="cn-btn cn-btn--sm"
          onClick={() => {
            post({ type: 'openVerification', id: item.id });
          }}
        >
          Open evidence
        </button>
        {item.evidence.selection?.files[0] && (
          <button
            type="button"
            class="cn-btn cn-btn--sm"
            onClick={() => {
              const path = item.evidence.selection?.files[0];
              if (path) post({ type: 'openFile', path });
            }}
          >
            Open test
          </button>
        )}
      </div>
    </section>
  );
}
