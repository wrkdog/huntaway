/** Explicit synthetic-test activation; never a production config or environment switch. */
import { mock } from 'node:test';
import * as chat from '../../src/agy-chat.ts';
if (process.env.NODE_TEST_CONTEXT && 'argonActivation' in chat)
  mock.method(chat.argonActivation as { enabled(): boolean }, 'enabled', () => true);
