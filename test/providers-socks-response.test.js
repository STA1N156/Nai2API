import assert from 'node:assert/strict';
import test from 'node:test';
import { __providerInternals } from '../server/providers.js';

function streamFromChunks(chunks) {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(Buffer.from(chunk));
      controller.close();
    },
  });
}

test('SOCKS HTTP response consumes body from the stream without a retained body chunk cache', async () => {
  const response = __providerInternals.openHttpResponseFromHeader(
    Buffer.from('HTTP/1.1 200 OK\r\ncontent-type: text/plain\r\n\r\n', 'latin1'),
    streamFromChunks(['hel', 'lo'])
  );

  assert.equal(await response.text(), 'hello');
});
