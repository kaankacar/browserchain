import { describe, expect, it } from 'vitest';
import { discoverSectionPaths, runSectionPath, type SectionBody } from './testkit';

describe('Catch2-style section runner', () => {
  it('finds every leaf and re-runs shared code like Catch2', () => {
    const log: string[] = [];
    const body: SectionBody = (section) => {
      log.push('top');
      section('A', () => {
        log.push('A');
        section('A1', () => log.push('A1'));
        section('A2', () => {
          log.push('A2');
          section('A2a', () => log.push('A2a'));
          section('A2b', () => log.push('A2b'));
        });
        log.push('A-tail');
      });
      section('B', () => log.push('B'));
    };
    const paths = discoverSectionPaths(body);
    expect(paths.map((p) => p.join('/'))).toEqual(['A/A1', 'A/A2/A2a', 'A/A2/A2b', 'B']);

    log.length = 0;
    runSectionPath(body, ['A', 'A2', 'A2b']);
    expect(log).toEqual(['top', 'A', 'A2', 'A2b', 'A-tail']);
  });

  it('keeps going after a failing leaf and reports it as a path', () => {
    const body: SectionBody = (section) => {
      section('ok1', () => {});
      section('bad', () => {
        throw new Error('boom');
      });
      section('ok2', () => {});
    };
    const paths = discoverSectionPaths(body);
    expect(paths.map((p) => p.join('/'))).toEqual(['ok1', 'bad', 'ok2']);
    expect(() => runSectionPath(body, ['bad'])).toThrow('boom');
    expect(() => runSectionPath(body, ['missing'])).toThrow('section path not found');
  });

  it('handles a body without sections', () => {
    let runs = 0;
    const paths = discoverSectionPaths(() => {
      runs++;
    });
    expect(paths).toEqual([[]]);
    expect(runs).toBe(1);
  });

  it('values set in sibling sections reach the shared tail', () => {
    const seen: number[] = [];
    const body: SectionBody = (section) => {
      section('outer', () => {
        let v = 0;
        section('one', () => {
          v = 1;
        });
        section('two', () => {
          v = 2;
        });
        seen.push(v);
      });
    };
    for (const p of discoverSectionPaths(body)) runSectionPath(body, p);
    // discovery ran each path once, then the explicit runs once more
    expect(seen).toEqual([1, 2, 1, 2]);
  });
});
