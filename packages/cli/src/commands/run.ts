import { FakeSource } from '@chat-bridge/source-fake';
import { dropNoiseFilter } from '@chat-bridge/engine';
import type { Message } from '@chat-bridge/types';
import type { CliContext } from '../config.js';

export async function handleRun(
  ctx: CliContext,
  args: string[],
  isJson: boolean
): Promise<{ stdout: string; stderr?: string; exitCode: number }> {
  // Parse flags
  let isFake = false;
  let fixturePath: string | undefined;
  let timeoutMs = 1000;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--fake') {
      isFake = true;
      const nextArg = args[i + 1];
      if (nextArg && !nextArg.startsWith('-')) {
        fixturePath = nextArg;
        i++;
      }
    } else if (arg === '--timeout') {
      const nextArg = args[i + 1];
      if (nextArg && !nextArg.startsWith('-')) {
        timeoutMs = parseInt(nextArg, 10);
        i++;
      }
    }
  }

  const chatPicker = ctx.getChatPicker();
  const policyFilter = ctx.getPolicyFilter();
  const outbox = ctx.getOutbox();
  const feedStore = ctx.getFeedStore();
  const settings = ctx.getSettings();

  const sinkKeys = Object.keys(settings.sinks);
  const activeSinks = sinkKeys.length > 0 ? sinkKeys : ['default-sink'];

  let processedCount = 0;
  let enqueuedCount = 0;
  let droppedCount = 0;

  const onMessage = async (msg: Message) => {
    processedCount++;

    // 1. Noise Filter Check
    const noiseCheck = dropNoiseFilter(msg);
    if (noiseCheck.drop) {
      droppedCount++;
      feedStore.recordMessage(msg, 'filtered', 'noise_filter');
      return;
    }

    // 2. Chat Picker Authorization Check
    const pickerDecision = chatPicker.evaluateMessage(msg);
    if (!pickerDecision.authorized) {
      droppedCount++;
      feedStore.recordMessage(msg, 'unpicked', 'unticked_chat');
      return;
    }

    // 3. Policy Filter Check
    const policyDecision = policyFilter.evaluate(msg);
    if (policyDecision.drop) {
      droppedCount++;
      feedStore.recordMessage(msg, 'filtered', policyDecision.ruleTriggered);
      return;
    }

    // 4. Enqueue to Outbox
    await outbox.enqueue(msg, activeSinks);
    enqueuedCount++;
    feedStore.recordMessage(msg, 'sending');
  };

  const source = new FakeSource({
    delayMs: 0,
    fixturePath,
  });

  await source.start(onMessage);

  if (timeoutMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, Math.min(timeoutMs, 500)));
  }

  await source.stop();

  if (isJson) {
    return {
      stdout: JSON.stringify(
        {
          ok: true,
          fake: isFake,
          processedCount,
          enqueuedCount,
          droppedCount,
        },
        null,
        2
      ),
      exitCode: 0,
    };
  }

  return {
    stdout: `Pipeline run completed. Processed: ${processedCount}, Enqueued: ${enqueuedCount}, Dropped: ${droppedCount}.`,
    exitCode: 0,
  };
}
