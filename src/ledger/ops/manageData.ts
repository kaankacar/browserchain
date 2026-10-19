// Ported from stellar-core (Apache-2.0): src/transactions/ManageDataOpFrame.cpp

import { toBase64 } from '../../lib/bytes';
import { createSubentry, removeSubentry } from '../balances';
import { dataKey } from '../keys';
import { opInner, opOuter } from '../results';
import type { DataEntry } from '../types';
import { isStringValid, opBody, xdrStringBytes, xdrStringToText } from '../xdrutil';
import type { OpFrame } from './types';

export const manageData: OpFrame = {
  threshold: () => 'MEDIUM',

  checkValid({ op }) {
    const name = xdrStringBytes(opBody(op, 'manageData').manageDataOp.dataName);
    if (name.length < 1 || !isStringValid(name)) return opInner('MANAGE_DATA_INVALID_NAME');
    return null;
  },

  apply({ op, sourceId, ltx }) {
    const o = opBody(op, 'manageData').manageDataOp;
    const name = xdrStringToText(o.dataName);
    const value = o.dataValue;
    const key = dataKey(sourceId, name);
    const header = ltx.header;
    const data = ltx.load(key) as DataEntry | undefined;

    if (value != null) {
      const encoded = toBase64(value.value);
      if (!data) {
        const acc = ltx.loadAccount(sourceId);
        if (!acc) throw new Error('source account missing');
        const r = createSubentry(header, acc, 1);
        if (r === 'LOW_RESERVE') return opInner('MANAGE_DATA_LOW_RESERVE');
        if (r === 'TOO_MANY_SUBENTRIES') return opOuter('opTOO_MANY_SUBENTRIES');
        if (r === 'TOO_MANY_SPONSORING') return opOuter('opTOO_MANY_SPONSORING');
        ltx.create<DataEntry>({
          kind: 'data',
          accountId: sourceId,
          name,
          value: encoded,
          lastModifiedLedgerSeq: ltx.ledgerSeq,
        });
      } else {
        data.value = encoded;
      }
    } else {
      if (!data) return opInner('MANAGE_DATA_NAME_NOT_FOUND');
      const acc = ltx.loadAccount(sourceId);
      if (!acc) throw new Error('source account missing');
      removeSubentry(acc, 1);
      ltx.erase(key);
    }
    return opInner('MANAGE_DATA_SUCCESS');
  },
};
