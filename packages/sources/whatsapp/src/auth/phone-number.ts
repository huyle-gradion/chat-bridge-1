/**
 * Phone number validation and normalization for WhatsApp authentication.
 * Conforms to E.164 requirements with default fallback for Vietnam (+84).
 */
export function validateAndCleanPhoneNumber(rawNumber: string): string {
  if (!rawNumber || typeof rawNumber !== 'string') {
    throw new Error('Please enter a valid phone number with country code (e.g. +84...)');
  }

  // Remove common formatting characters: spaces, dashes, dots, parens
  let cleaned = rawNumber.trim().replace(/[\s\-\.\(\)]/g, '');

  if (cleaned.startsWith('+')) {
    cleaned = cleaned.slice(1);
  } else if (cleaned.startsWith('0')) {
    // Domestic Vietnam number starting with 0 -> replace with 84
    cleaned = '84' + cleaned.slice(1);
  }

  // Only digits allowed
  if (!/^\d+$/.test(cleaned)) {
    throw new Error('Please enter a valid phone number with country code (e.g. +84...)');
  }

  // E.164 standard: between 7 and 15 digits
  if (cleaned.length < 7 || cleaned.length > 15) {
    throw new Error('Please enter a valid phone number with country code (e.g. +84...)');
  }

  return cleaned;
}
