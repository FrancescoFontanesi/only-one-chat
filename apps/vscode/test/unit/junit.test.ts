import { describe, expect, it } from 'vitest';
import { readJUnit } from '../../src/session/junit.js';

describe('JUnit evidence', () => {
  it('distinguishes assertion failures, errors, skipped tests, and success', () => {
    const result = readJUnit(
      '<testsuites><testsuite><testcase classname="calc" name="sum"/><testcase name="negative"><failure message="expected rejection">actual 2</failure></testcase><testcase name="setup"><error>missing dependency</error></testcase><testcase name="later"><skipped/></testcase></testsuite></testsuites>',
    );
    expect(result.map(({ name, status }) => [name, status])).toEqual([
      ['sum', 'passed'],
      ['negative', 'failed'],
      ['setup', 'error'],
      ['later', 'skipped'],
    ]);
    expect(result[1]?.detail).toContain('expected rejection');
  });

  it.each([
    '<!DOCTYPE x [<!ENTITY payload SYSTEM "file:///synthetic-secret">]><testsuite/>',
    '<testsuite><testcase name="x"></testsuite>',
    '<html><testcase name="x"/></html>',
    '<testsuite><testcase/></testsuite>',
    'x'.repeat(2 * 1024 * 1024 + 1),
  ])('rejects invalid or unsafe XML', (xml) => {
    expect(() => readJUnit(xml)).toThrow();
  });
});
