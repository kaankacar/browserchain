import type { OrderBookView } from '../../node/api';

export interface BookRow {
  /** Counter per base. */
  price: number;
  /** Amount in base units. */
  base: number;
  /** Amount in counter units. */
  counter: number;
  /** Running total of base units from the best price. */
  cum: number;
}

/**
 * Order book rows in base units for display. Asks carry base (selling)
 * amounts; bids carry counter (buying) amounts, as in Horizon.
 */
export function bookRows(book: OrderBookView | undefined): { asks: BookRow[]; bids: BookRow[] } {
  if (!book) return { asks: [], bids: [] };
  let cum = 0;
  const asks = book.asks.map((a) => {
    const price = Number(a.price);
    const base = Number(a.amount);
    cum += base;
    return { price, base, counter: base * price, cum };
  });
  cum = 0;
  const bids = book.bids.map((b) => {
    const price = Number(b.price);
    const counter = Number(b.amount);
    const base = price > 0 ? counter / price : 0;
    cum += base;
    return { price, base, counter, cum };
  });
  return { asks, bids };
}
