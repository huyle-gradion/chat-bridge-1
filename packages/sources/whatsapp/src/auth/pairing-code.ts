import crypto from 'node:crypto';

/**
 * Formats an 8-character pairing code into XXXX-XXXX presentation format.
 */
export function formatPairingCode(rawCode: string): string {
  const alphanumeric = rawCode.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (alphanumeric.length >= 8) {
    return `${alphanumeric.slice(0, 4)}-${alphanumeric.slice(4, 8)}`;
  }
  return rawCode.toUpperCase();
}

/**
 * Generates an 8-character random alphanumeric pairing code.
 */
export function generatePairingCode(): string {
  // Construct unambiguous alphanumeric alphabet dynamically
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ'.split('').concat(['2', '3', '4', '5', '6', '7', '8', '9']);
  const bytes = crypto.randomBytes(8);
  let result = '';
  for (let i = 0; i < 8; i++) {
    const byte = bytes[i];
    if (byte !== undefined) {
      const selected = alphabet[byte % alphabet.length];
      if (selected !== undefined) {
        result += selected;
      }
    }
  }
  return formatPairingCode(result);
}
