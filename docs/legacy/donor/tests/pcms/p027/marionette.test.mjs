import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { Marionette } from '../../../tools/firefox/marionette.mjs';

class Socket extends EventEmitter {
  write(bytes) { this.sent = bytes; }
  destroy(error) { if (error) this.emit('error', error); this.emit('close'); }
}
const frame = value => {
  const bytes = Buffer.from(JSON.stringify(value));
  return Buffer.concat([Buffer.from(`${bytes.length}:`), bytes]);
};
test('A027-02 protocol handles fragmented/coalesced UTF-8 frames and correlates replies', async () => {
  const socket = new Socket(); const client = new Marionette(socket);
  const greeting = frame({marionetteProtocol:3});
  socket.emit('data', greeting.subarray(0, 2)); socket.emit('data', greeting.subarray(2));
  assert.equal((await client.greeting).marionetteProtocol, 3);
  const first = client.command('first', {text:'żółć'});
  const second = client.command('second');
  const responses = Buffer.concat([frame([1, 2, null, {value:2}]), frame([1, 1, null, {value:'żółć'}])]);
  for (let offset = 0; offset < responses.length; offset += 3) socket.emit('data', responses.subarray(offset, offset + 3));
  assert.deepEqual(await first, {value:'żółć'}); assert.deepEqual(await second, {value:2}); client.close();
});
test('A027-02 protocol errors, command deadlines and closed connections fail explicitly', async () => {
  const socket = new Socket(); const client = new Marionette(socket, 20);
  socket.emit('data', frame({marionetteProtocol:3})); await client.greeting;
  const failed = client.command('invalid'); socket.emit('data', frame([1, 1, {error:'invalid argument',message:'bad input'}, null]));
  await assert.rejects(failed, /invalid argument: bad input/);
  await assert.rejects(client.command('neverReplies'), /timeout: neverReplies/);
  const closed = client.command('closed'); client.close(); await assert.rejects(closed, /connection closed/);
});
