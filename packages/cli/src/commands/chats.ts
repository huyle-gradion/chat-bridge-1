import type { CliContext } from '../config.js';

export async function handleChats(
  ctx: CliContext,
  args: string[],
  isJson: boolean
): Promise<{ stdout: string; stderr?: string; exitCode: number }> {
  const subCommand = args[0] || 'list';
  const chatPicker = ctx.getChatPicker();
  const settings = ctx.getSettings();

  if (subCommand === 'list') {
    const chats = chatPicker.listChats({ limit: 1000 });
    if (isJson) {
      return {
        stdout: JSON.stringify(chats, null, 2),
        exitCode: 0,
      };
    }

    if (chats.length === 0) {
      return {
        stdout: 'No conversations discovered yet. Connect a chat account or run with a test fixture.',
        exitCode: 0,
      };
    }

    const lines: string[] = ['Conversations:'];
    for (const c of chats) {
      const mark = c.isTicked ? '[x]' : '[ ]';
      const lastMsg = c.lastMessageTime ? ` (last active: ${c.lastMessageTime})` : '';
      lines.push(`  ${mark} ${c.id}: ${c.name} [${c.network}]${lastMsg}`);
    }
    return {
      stdout: lines.join('\n'),
      exitCode: 0,
    };
  }

  if (subCommand === 'pick') {
    const threadId = args[1];
    if (!threadId) {
      return {
        stdout: '',
        stderr: 'Missing conversation identifier. Usage: chat-bridge chats pick <id>',
        exitCode: 1,
      };
    }

    // Ensure chat exists in roster, or register stub
    const existing = chatPicker.getChat(threadId);
    if (!existing) {
      chatPicker.upsertChat({
        id: threadId,
        network: 'fake',
        account: 'user',
        name: threadId,
        kind: threadId.startsWith('group') ? 'group' : 'dm',
        isTicked: true,
      });
    } else {
      chatPicker.tickChat(threadId);
    }

    const pickedSet = new Set(settings.chats.pickedChatIds);
    pickedSet.add(threadId);
    settings.chats.pickedChatIds = Array.from(pickedSet);
    ctx.saveSettings(settings);

    if (isJson) {
      return {
        stdout: JSON.stringify({ ok: true, id: threadId, isTicked: true }, null, 2),
        exitCode: 0,
      };
    }

    return {
      stdout: `Authorized conversation "${threadId}" to send messages.`,
      exitCode: 0,
    };
  }

  if (subCommand === 'unpick') {
    const threadId = args[1];
    if (!threadId) {
      return {
        stdout: '',
        stderr: 'Missing conversation identifier. Usage: chat-bridge chats unpick <id>',
        exitCode: 1,
      };
    }

    chatPicker.untickChat(threadId);

    settings.chats.pickedChatIds = settings.chats.pickedChatIds.filter(
      (id) => id !== threadId
    );
    ctx.saveSettings(settings);

    if (isJson) {
      return {
        stdout: JSON.stringify({ ok: true, id: threadId, isTicked: false }, null, 2),
        exitCode: 0,
      };
    }

    return {
      stdout: `Marked conversation "${threadId}" as private.`,
      exitCode: 0,
    };
  }

  return {
    stdout: '',
    stderr: `Unknown chats action: "${subCommand}". Supported actions: list, pick, unpick.`,
    exitCode: 1,
  };
}
