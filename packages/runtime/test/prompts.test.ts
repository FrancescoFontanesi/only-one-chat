// Guards against the role prompts growing back (ADR 0045): a character budget
// for each role's instructions, and the rare modules only on their trigger.

import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  PROMPT_MODULES,
  directMessagePrompt,
  findingsPrompt,
  implementerInstructions,
  leaderFirstPrompt,
  leaderInstructions,
  reviewFollowUpPrompt,
  reviewerInstructions,
} from '../src/prompts.js';

// Measured on 2026-11-23 (characters, as built, with the shared sub-agent rules):
// leader 5804, implementer 5344 (5632 with JUnit), reviewer 7674 (8070 with JUnit).
// Each cap is that figure plus about 10%. A prompt that needs more must say why in
// its ADR and raise the cap here; one that gets shorter may lower it.
const BUDGETS = {
  leader: 6350,
  implementer: 5900,
  implementerJunit: 6200,
  reviewer: 8450,
  reviewerJunit: 8900,
};

describe('the role instructions budget (ADR 0045)', () => {
  it.each([
    ['leader', leaderInstructions('claude'), BUDGETS.leader],
    [
      'leader, no questions tool',
      leaderInstructions('claude', { questions: false }),
      BUDGETS.leader,
    ],
    ['implementer', implementerInstructions(), BUDGETS.implementer],
    ['implementer with JUnit', implementerInstructions({ junit: true }), BUDGETS.implementerJunit],
    ['reviewer', reviewerInstructions(), BUDGETS.reviewer],
    ['reviewer with JUnit', reviewerInstructions({ junit: true }), BUDGETS.reviewerJunit],
  ])('%s stays within its cap', (_name, text, cap) => {
    expect(text.length).toBeLessThanOrEqual(cap);
  });

  it('carries the JUnit selection only when the workspace has a {junit} command', () => {
    for (const build of [implementerInstructions, reviewerInstructions]) {
      expect(build()).not.toContain('JUnit');
      expect(build({ junit: false })).not.toContain('JUnit');
      expect(build({ junit: true })).toContain('`test` selection');
    }
  });
});

describe('the prompt modules (ADR 0045)', () => {
  const instructions = [
    leaderInstructions('claude'),
    leaderInstructions('claude', { questions: false }),
    implementerInstructions(),
    implementerInstructions({ junit: true }),
    reviewerInstructions(),
    reviewerInstructions({ junit: true }),
  ];
  const brief = '<<<OOC-BRIEF v1 project=calc track=ans\n## Goal\nans.\nOOC-BRIEF>>>';

  it('are every file of the modules folder, each loaded once', () => {
    const folder = fileURLToPath(new URL('../prompts/modules/', import.meta.url));
    expect(readdirSync(folder)).toHaveLength(Object.keys(PROMPT_MODULES).length);
  });

  it('appear on their trigger turn', () => {
    expect(leaderFirstPrompt(brief)).toContain(PROMPT_MODULES.webAppBrief);
    expect(leaderFirstPrompt(brief, 'Notes.')).toContain(PROMPT_MODULES.webAppBrief);
    expect(directMessagePrompt('Fix it.')).toContain(PROMPT_MODULES.directMessage);
    expect(findingsPrompt('Reviewer', 'R1 [blocking] — x', true)).toContain(
      PROMPT_MODULES.answeringFindings,
    );
    expect(reviewFollowUpPrompt('Implementer', 'report', '', 1)).toContain(
      PROMPT_MODULES.followUpRound,
    );
  });

  it('stay out of a turn without their trigger', () => {
    expect(leaderFirstPrompt('A plain question.', 'Notes.')).not.toContain(
      PROMPT_MODULES.webAppBrief,
    );
    expect(findingsPrompt('Reviewer', 'R2 [blocking] — x', false)).not.toContain(
      PROMPT_MODULES.answeringFindings,
    );
  });

  it('never appear in the instructions of any role', () => {
    for (const [name, module] of Object.entries(PROMPT_MODULES)) {
      for (const text of instructions) {
        expect(text, name).not.toContain(module);
        // A module is not paraphrased there either: its first sentence is not in the instructions.
        expect(text, name).not.toContain(module.split('\n')[0] ?? module);
      }
    }
  });
});
