import type { CliContext } from '../config.js';

export async function handleFilters(
  ctx: CliContext,
  args: string[],
  isJson: boolean
): Promise<{ stdout: string; stderr?: string; exitCode: number }> {
  const subCommand = args[0] || 'show';
  const settings = ctx.getSettings();

  function normalize(contact: string): string {
    return contact.trim().replace(/^\+/, '').replace(/[\s\-()]/g, '');
  }

  if (subCommand === 'show') {
    const filters = settings.filters;
    if (isJson) {
      return {
        stdout: JSON.stringify(filters, null, 2),
        exitCode: 0,
      };
    }

    const lines: string[] = [
      'Filter Settings:',
      `  - Group messages allowed: ${filters.allowGroups ? 'Yes' : 'No (disabled by default)'}`,
      `  - Security code filter active: ${filters.otpFilterEnabled ? 'Yes' : 'No'}`,
      `  - Blocked contacts (${filters.blockedContacts.length}): ${filters.blockedContacts.join(', ') || 'None'}`,
      `  - Custom patterns (${filters.customBlockedPatterns.length}): ${filters.customBlockedPatterns.join(', ') || 'None'}`,
    ];
    return {
      stdout: lines.join('\n'),
      exitCode: 0,
    };
  }

  if (subCommand === 'set') {
    const key = args[1];
    const val = args[2];
    if (!key || val === undefined) {
      return {
        stdout: '',
        stderr: 'Missing key or value. Usage: chat-bridge filters set <key> <value>',
        exitCode: 1,
      };
    }

    const lowerKey = key.toLowerCase();
    const boolVal = val.toLowerCase() === 'true' || val === '1';

    if (lowerKey === 'allowgroups' || lowerKey === 'groupsenabled') {
      settings.filters.allowGroups = boolVal;
    } else if (lowerKey === 'otpfilter' || lowerKey === 'otpfilterenabled') {
      settings.filters.otpFilterEnabled = boolVal;
    } else {
      return {
        stdout: '',
        stderr: `Unsupported filter key: "${key}". Supported keys: allowGroups, otpFilterEnabled.`,
        exitCode: 1,
      };
    }

    ctx.saveSettings(settings);

    if (isJson) {
      return {
        stdout: JSON.stringify(settings.filters, null, 2),
        exitCode: 0,
      };
    }

    return {
      stdout: `Updated filter "${key}" to ${val}.`,
      exitCode: 0,
    };
  }

  if (subCommand === 'block') {
    const contact = args[1];
    if (!contact) {
      return {
        stdout: '',
        stderr: 'Missing contact to block. Usage: chat-bridge filters block <id>',
        exitCode: 1,
      };
    }

    const norm = normalize(contact);
    const blockedSet = new Set(settings.filters.blockedContacts.map((c) => normalize(c)));
    blockedSet.add(norm);
    settings.filters.blockedContacts = Array.from(blockedSet);
    ctx.saveSettings(settings);

    if (isJson) {
      return {
        stdout: JSON.stringify(settings.filters, null, 2),
        exitCode: 0,
      };
    }

    return {
      stdout: `Blocked contact "${contact}".`,
      exitCode: 0,
    };
  }

  if (subCommand === 'unblock') {
    const contact = args[1];
    if (!contact) {
      return {
        stdout: '',
        stderr: 'Missing contact to unblock. Usage: chat-bridge filters unblock <id>',
        exitCode: 1,
      };
    }

    const norm = normalize(contact);
    settings.filters.blockedContacts = settings.filters.blockedContacts.filter(
      (c) => normalize(c) !== norm
    );
    ctx.saveSettings(settings);

    if (isJson) {
      return {
        stdout: JSON.stringify(settings.filters, null, 2),
        exitCode: 0,
      };
    }

    return {
      stdout: `Unblocked contact "${contact}".`,
      exitCode: 0,
    };
  }

  return {
    stdout: '',
    stderr: `Unknown filters action: "${subCommand}". Supported actions: show, set, block, unblock.`,
    exitCode: 1,
  };
}
