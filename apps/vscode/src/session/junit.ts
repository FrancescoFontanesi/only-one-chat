import sax from 'sax';

export interface TestResult {
  readonly className: string;
  readonly name: string;
  status: 'passed' | 'failed' | 'error' | 'skipped';
  detail: string;
}

export const MAX_REPORT_BYTES = 2 * 1024 * 1024;

/** A bounded JUnit subset. DTDs, custom entities, and unsupported roots are refused. */
export function readJUnit(xml: string): TestResult[] {
  if (Buffer.byteLength(xml) > MAX_REPORT_BYTES) throw new Error('JUnit report exceeds 2 MiB');
  const reader = sax.parser(true, { strictEntities: true });
  const results: TestResult[] = [];
  const stack: string[] = [];
  let current: TestResult | undefined;
  let detail = false;
  reader.ondoctype = () => {
    throw new Error('JUnit DTDs are forbidden');
  };
  reader.onopentag = ({ name, attributes }) => {
    if (stack.length === 0 && name !== 'testsuite' && name !== 'testsuites') {
      throw new Error('Unsupported JUnit root');
    }
    if (stack.length >= 64) throw new Error('JUnit nesting exceeds 64 elements');
    if (name === 'testcase') {
      if (current || stack.at(-1) !== 'testsuite' || !attributes['name']) {
        throw new Error('Invalid JUnit testcase');
      }
      if (results.length >= 10_000) throw new Error('Too many JUnit testcases');
      current = {
        className: attributes['classname'] ?? '',
        name: attributes['name'],
        status: 'passed',
        detail: '',
      };
    }
    if (current && ['failure', 'error', 'skipped'].includes(name)) {
      if (stack.at(-1) !== 'testcase' || current.status !== 'passed') {
        throw new Error('Ambiguous JUnit testcase outcome');
      }
      current.status = name === 'failure' ? 'failed' : name === 'error' ? 'error' : 'skipped';
      current.detail = attributes['message'] ?? '';
      detail = true;
    }
    stack.push(name);
  };
  reader.onclosetag = (name) => {
    stack.pop();
    if (name === 'testcase' && current) {
      results.push(current);
      current = undefined;
    }
    if (['failure', 'error', 'skipped'].includes(name)) detail = false;
  };
  reader.ontext = reader.oncdata = (text) => {
    if (detail && current) current.detail = (current.detail + text).slice(0, 8192);
  };
  reader.write(xml).close();
  if (results.length === 0) throw new Error('JUnit report contains no tests');
  return results;
}
