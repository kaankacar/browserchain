import { Keypair } from '@stellar/stellar-sdk/base';
import { describe, expect, it } from 'vitest';
import { parseRoute, routeHref, sectionOf, type Route } from './route';
import { classifySearch } from './search';

const ACCOUNT = Keypair.fromRawEd25519Seed(new Uint8Array(32).fill(3)).publicKey();
const HASH = 'ab'.repeat(32);

describe('parseRoute', () => {
  it('parses the main screens', () => {
    expect(parseRoute('')).toEqual({ name: 'overview' });
    expect(parseRoute('#')).toEqual({ name: 'overview' });
    expect(parseRoute('#/')).toEqual({ name: 'overview' });
    expect(parseRoute('#/validator')).toEqual({ name: 'validator', tab: 'node' });
    expect(parseRoute('#/validator/scp')).toEqual({ name: 'validator', tab: 'scp' });
    expect(parseRoute('#/wallet')).toEqual({ name: 'wallet', tab: 'send' });
    expect(parseRoute('#/wallet/trade')).toEqual({ name: 'wallet', tab: 'trade' });
    expect(parseRoute('#/lab/sign')).toEqual({ name: 'lab', tab: 'sign' });
    expect(parseRoute('#/about')).toEqual({ name: 'about' });
    expect(parseRoute('#/assets')).toEqual({ name: 'assets' });
  });

  it('parses explorer routes with arguments', () => {
    expect(parseRoute('#/ledger/12')).toEqual({ name: 'ledger', seq: 12 });
    expect(parseRoute(`#/tx/${HASH}`)).toEqual({ name: 'tx', hash: HASH });
    expect(parseRoute(`#/tx/${HASH.toUpperCase()}`)).toEqual({ name: 'tx', hash: HASH });
    expect(parseRoute(`#/account/${ACCOUNT}`)).toEqual({ name: 'account', id: ACCOUNT });
    expect(parseRoute('#/ledgers')).toEqual({ name: 'ledgers' });
    expect(parseRoute('#/ledgers?before=120')).toEqual({ name: 'ledgers', before: 120 });
    expect(parseRoute('#/explorer')).toEqual({ name: 'ledgers' });
    expect(parseRoute('#/txs?before=9')).toEqual({ name: 'txs', before: 9 });
    expect(parseRoute('#/search/hello%20world')).toEqual({ name: 'search', q: 'hello world' });
  });

  it('rejects malformed routes', () => {
    expect(parseRoute('#/ledger/abc').name).toBe('notFound');
    expect(parseRoute('#/ledger/0').name).toBe('notFound');
    expect(parseRoute('#/ledger/12/extra').name).toBe('notFound');
    expect(parseRoute('#/tx/1234').name).toBe('notFound');
    expect(parseRoute('#/account/nope').name).toBe('notFound');
    expect(parseRoute('#/validator/bogus').name).toBe('notFound');
    expect(parseRoute('#/nowhere')).toEqual({ name: 'notFound', path: '/nowhere' });
    expect(parseRoute('#/ledgers?before=-3')).toEqual({ name: 'ledgers' });
    expect(parseRoute('#/search/%E0%A4%A')).toEqual({ name: 'search', q: '%E0%A4%A' });
  });

  it('round-trips through routeHref', () => {
    const routes: Route[] = [
      { name: 'overview' },
      { name: 'validator', tab: 'node' },
      { name: 'validator', tab: 'logs' },
      { name: 'ledgers' },
      { name: 'ledgers', before: 77 },
      { name: 'ledger', seq: 5 },
      { name: 'txs', before: 3 },
      { name: 'tx', hash: HASH },
      { name: 'account', id: ACCOUNT },
      { name: 'assets' },
      { name: 'search', q: 'G?x y' },
      { name: 'wallet', tab: 'send' },
      { name: 'wallet', tab: 'claim' },
      { name: 'lab', tab: 'decode' },
      { name: 'lab', tab: 'submit' },
      { name: 'about' },
    ];
    for (const r of routes) expect(parseRoute(routeHref(r))).toEqual(r);
  });

  it('maps routes to nav sections', () => {
    expect(sectionOf({ name: 'tx', hash: HASH })).toBe('explorer');
    expect(sectionOf({ name: 'wallet', tab: 'issue' })).toBe('wallet');
    expect(sectionOf({ name: 'notFound', path: '/x' })).toBe('none');
  });
});

describe('classifySearch', () => {
  it('finds accounts, transactions and ledgers', () => {
    expect(classifySearch(ACCOUNT)).toEqual({ kind: 'account', id: ACCOUNT });
    expect(classifySearch(`  ${ACCOUNT.toLowerCase()} `)).toEqual({ kind: 'account', id: ACCOUNT });
    expect(classifySearch(HASH.toUpperCase())).toEqual({ kind: 'tx', hash: HASH });
    expect(classifySearch('1234')).toEqual({ kind: 'ledger', seq: 1234 });
    expect(classifySearch('#1,234')).toEqual({ kind: 'ledger', seq: 1234 });
  });

  it('explains invalid input', () => {
    expect(classifySearch('').kind).toBe('invalid');
    expect(classifySearch('0').kind).toBe('invalid');
    expect(classifySearch('GABC').kind).toBe('invalid');
    expect(classifySearch('abc123').kind).toBe('invalid');
    expect(classifySearch('hello').kind).toBe('invalid');
    const secret = Keypair.fromRawEd25519Seed(new Uint8Array(32).fill(4)).secret();
    const r = classifySearch(secret);
    expect(r.kind).toBe('invalid');
    if (r.kind === 'invalid') expect(r.reason).toMatch(/secret/i);
  });
});
