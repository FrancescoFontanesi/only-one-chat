// Markdown files are imported as their text (see prompts.ts).
declare module '*.md' {
  const text: string;
  export default text;
}
