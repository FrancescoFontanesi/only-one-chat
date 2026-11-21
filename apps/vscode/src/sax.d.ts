declare module 'sax' {
  interface Parser {
    onopentag: (tag: { name: string; attributes: Record<string, string> }) => void;
    onclosetag: (name: string) => void;
    ontext: (text: string) => void;
    oncdata: (text: string) => void;
    ondoctype: () => void;
    write(text: string): Parser;
    close(): void;
  }
  const sax: { parser(strict: boolean, options: { strictEntities: boolean }): Parser };
  export default sax;
}
