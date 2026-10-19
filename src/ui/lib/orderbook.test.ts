import { describe, expect, it } from 'vitest';
import type { OrderBookView } from '../../node/api';
import { bookRows } from './orderbook';

const XLM = { type: 'native' as const, code: 'XLM' };
const USD = { type: 'credit_alphanum4' as const, code: 'USDB', issuer: 'GX' };

describe('bookRows', () => {
  it('converts both sides to base units with running totals', () => {
    const book: OrderBookView = {
      selling: USD,
      buying: XLM,
      asks: [
        { price: '8.5', amount: '10.0000000', priceR: { n: 17, d: 2 } },
        { price: '9', amount: '5.0000000', priceR: { n: 9, d: 1 } },
      ],
      bids: [{ price: '8', amount: '80.0000000', priceR: { n: 8, d: 1 } }],
    };
    const { asks, bids } = bookRows(book);
    expect(asks).toEqual([
      { price: 8.5, base: 10, counter: 85, cum: 10 },
      { price: 9, base: 5, counter: 45, cum: 15 },
    ]);
    expect(bids).toEqual([{ price: 8, base: 10, counter: 80, cum: 10 }]);
  });
  it('handles an empty book', () => {
    expect(bookRows(undefined)).toEqual({ asks: [], bids: [] });
  });
});
