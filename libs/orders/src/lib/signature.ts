import { createHmac, timingSafeEqual } from 'node:crypto';
import { InvalidSignatureError } from './errors.js';

/** En-tête porté par les notifications du prestataire de paiement : `t=<secondes>,v1=<hmac hex>`. */
export const SIGNATURE_HEADER = 'stockpilot-signature';

/** Écart accepté entre l'horodatage signé et l'horloge du serveur : au-delà, un rejeu est refusé. */
export const SIGNATURE_TOLERANCE_SECONDS = 300;

/**
 * Signe un corps de notification : HMAC-SHA256 de `<horodatage>.<corps brut>`. L'horodatage est signé avec le
 * corps : on ne peut pas rejouer une ancienne notification en changeant seulement sa date.
 */
export function signPayload(
  secret: string,
  rawBody: string | Buffer,
  timestamp: number = Math.floor(Date.now() / 1000),
): string {
  const mac = createHmac('sha256', secret)
    .update(`${timestamp}.`)
    .update(rawBody)
    .digest('hex');
  return `t=${timestamp},v1=${mac}`;
}

export function verifySignature(
  secret: string,
  rawBody: Buffer | undefined,
  header: string | undefined,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): void {
  if (!rawBody || !header) throw new InvalidSignatureError('absente');
  const parts = new Map(
    header.split(',').map((part) => {
      const [key, ...rest] = part.trim().split('=');
      return [key, rest.join('=')] as const;
    }),
  );
  const timestamp = Number(parts.get('t'));
  const received = parts.get('v1') ?? '';
  if (!Number.isInteger(timestamp) || !/^[0-9a-f]{64}$/.test(received)) {
    throw new InvalidSignatureError('mal formée');
  }
  if (Math.abs(nowSeconds - timestamp) > SIGNATURE_TOLERANCE_SECONDS) {
    throw new InvalidSignatureError('horodatage hors délai');
  }
  const expected = signPayload(secret, rawBody, timestamp).split('v1=')[1];
  // Comparaison en temps constant : le temps de réponse ne révèle pas combien de caractères étaient justes.
  if (
    !timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(received, 'hex'))
  ) {
    throw new InvalidSignatureError('ne correspond pas');
  }
}
