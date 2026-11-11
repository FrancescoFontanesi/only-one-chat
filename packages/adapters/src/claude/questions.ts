// Claude Code's AskUserQuestion tool (ADR 0022), as the runtime takes it: its
// questions in, the user's answers back into the call's input, as the Agent
// SDK's hosts answer it (`answers`: by question text, choices joined by commas).

import type { AgentUserQuestion } from '../agent.js';

/** Claude Code's tool that asks the user. */
export const QUESTION_TOOL = 'AskUserQuestion';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The questions of a call: Claude names no ids, so each is its position; a free answer is always allowed. */
export function claudeQuestions(input: unknown): AgentUserQuestion[] {
  const list = isRecord(input) && Array.isArray(input['questions']) ? input['questions'] : [];
  return list.flatMap((q, index): AgentUserQuestion[] => {
    if (!isRecord(q) || typeof q['question'] !== 'string') return [];
    const options = Array.isArray(q['options'])
      ? q['options'].flatMap((o) =>
          isRecord(o) && typeof o['label'] === 'string'
            ? [
                {
                  label: o['label'],
                  description: typeof o['description'] === 'string' ? o['description'] : '',
                },
              ]
            : [],
        )
      : [];
    return [
      {
        id: String(index),
        header: typeof q['header'] === 'string' ? q['header'] : '',
        question: q['question'],
        options: options.length > 0 ? options : null,
        other: true,
        secret: false,
      },
    ];
  });
}

/** The answers as the tool takes them. */
export function claudeAnswers(
  questions: readonly AgentUserQuestion[],
  answers: Readonly<Record<string, readonly string[]>>,
): Record<string, string> {
  return Object.fromEntries(
    questions.flatMap((q) => {
      const values = answers[q.id];
      return values && values.length > 0 ? [[q.question, values.join(', ')]] : [];
    }),
  );
}
