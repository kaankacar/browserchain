// Runtime lens (opt-in: E2E_WEBRTC=1, needs the internet and public Nostr
// relays): over real WebRTC, each node binds the other only on a hello that
// signs their DTLS channel (both certificate fingerprints). A third party that
// relays hellos between two of its own connections cannot bind; the unit
// tests cover that. This spec checks that real Chromium gives both ends the
// same channel id, so honest peers bind with the protection on.
import { expect, test } from '@playwright/test';
import { attachDiagnostics, nodeLog, openNode, since, uniqueNetwork, type NodePage } from './helpers';

test.skip(!process.env.E2E_WEBRTC, 'set E2E_WEBRTC=1 to run (needs the internet and public Nostr relays)');

test('two browsers bind over WebRTC on hellos bound to their DTLS channel', async ({ browser }, testInfo) => {
  test.setTimeout(300_000);
  const t0 = Date.now();
  const network = uniqueNetwork('chan');
  const query = `transport=webrtc&network=${network}&fresh=1`;
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const nodes: NodePage[] = [];
  try {
    nodes.push(await openNode(ctxA, query, 'A'));
    nodes.push(await openNode(ctxB, query, 'B'));
    const [A, B] = nodes;
    // the browser exposes the certificate the remote proved in the DTLS handshake
    const api = await A.page.evaluate(() => typeof RTCDtlsTransport !== 'undefined' && 'getRemoteCertificates' in RTCDtlsTransport.prototype);
    expect(api).toBe(true);

    await expect
      .poll(
        async () => {
          const [pa, pb] = await Promise.all([
            A.page.evaluate(() => window.__browserchain!.getPeers()),
            B.page.evaluate(() => window.__browserchain!.getPeers()),
          ]);
          return pa.some((p) => p.nodeId === B.info.nodeId) && pb.some((p) => p.nodeId === A.info.nodeId);
        },
        { timeout: 180_000, intervals: [1000, 2000] },
      )
      .toBe(true);
    testInfo.annotations.push({ type: 'timing', description: `bound both ways after ${since(t0)}` });

    for (const [self, other] of [
      [A, B],
      [B, A],
    ] as const) {
      const log = await nodeLog(self.page, 1000);
      expect(log, `${self.label} log`).toContain(`connected via webrtc (hello bound to the channel)`);
      expect(log, `${self.label} log`).not.toContain('made for another channel');
      testInfo.annotations.push({
        type: 'result',
        description: `${self.label}: ${log.split('\n').find((l) => l.includes('hello bound to the channel'))?.trim()} (peer ${other.label})`,
      });
    }
  } catch (err) {
    await attachDiagnostics(testInfo, nodes);
    throw err;
  } finally {
    await ctxA.close();
    await ctxB.close();
  }
});
