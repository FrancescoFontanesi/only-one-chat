// What the extension verified, shown in the thread: the facts after an
// implementer's turn and the runtime verification's evidence. Apart from the
// agents' own words (ADR 0010, 0030).

import type { ThreadItem } from './state.js';
import { readFacts } from './threadModel.js';
import { post } from './ui.js';

type Item<K extends ThreadItem['kind']> = Extract<ThreadItem, { kind: K }>;

const fileList = (files: readonly string[]) =>
  files.length > 0
    ? files.map((f) => f.replace(/^(added|modified|deleted) /, '')).join(' · ')
    : 'none';

export function FactsTurn({ text, number }: { text: string; number: string | undefined }) {
  const facts = readFacts(text);
  // The last turn's files, when they say more than the request's.
  const turn = facts.turn && facts.turn.join('\n') !== facts.files.join('\n') ? facts.turn : null;
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
            {facts.unavailable
              ? '▲ Not compared: the workspace has over 5,000 files or could not be read'
              : fileList(facts.files)}
          </dd>
          {turn && (
            <>
              <dt>LAST TURN</dt>
              <dd class="t-data">{fileList(turn)}</dd>
            </>
          )}
          {(facts.flags || facts.checksUnavailable) && (
            <>
              <dt>DIFF CHECKS</dt>
              <dd class="t-data facts__list">
                {facts.checksUnavailable
                  ? 'Not run: no workspace checkpoint'
                  : facts.flags?.length
                    ? facts.flags.map((flag) => <div key={flag}>▲ {flag}</div>)
                    : 'No flags'}
                {facts.skipped && <div>Not checked, over 2 MB: {facts.skipped}</div>}
              </dd>
            </>
          )}
          {facts.risk && (
            <>
              <dt>RISK</dt>
              <dd class="t-data">
                {facts.risk.level.toUpperCase()} · {facts.risk.score}
                {facts.risk.reasons.length > 0 && ` — ${facts.risk.reasons.join(' · ')}`}
              </dd>
            </>
          )}
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

/** The runtime's checks of a report or a review against the brief: not a reviewer's findings. */
export function ContractTurn({ title, items }: { title: string; items: readonly string[] }) {
  return (
    <section class="turn">
      <div class="who">
        <b>EXTENSION</b>
        <span>RUNTIME CHECKS</span>
        <span>{title.toUpperCase()}</span>
      </div>
      <div class="tb">
        {items.map((issue) => (
          <div key={issue} class="t-data">
            ▲ {issue}
          </div>
        ))}
      </div>
    </section>
  );
}

/** The check before the review failed and the work went back by itself (ADR 0041). */
export function GateTurn({ result }: { result: string }) {
  return (
    <section class="turn">
      <div class="who">
        <b>EXTENSION</b>
        <span>CHECK BEFORE REVIEW</span>
        <span>SENT BACK · NOT A REVIEW</span>
      </div>
      <div class="tb">
        <p>
          The runtime's verification failed before the review. The work went back to the implementer
          automatically; the reviewer has not judged it yet.
        </p>
        {result && <span class="t-data">{result}</span>}
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
