import { availableParallelism } from 'node:os';
import * as argon2 from 'argon2';

/**
 * Argon2id : coûteux par construction (64 Mio et plusieurs passes par calcul). Le calcul a lieu dans le pool de
 * fils de Node, jamais dans la boucle d'événements, et au plus `maxConcurrent` à la fois : une rafale de
 * connexions attend son tour au lieu de réclamer 64 Mio par requête simultanée.
 */
export class PasswordHasher {
  private running = 0;
  private readonly waiting: (() => void)[] = [];
  private readonly dummy: Promise<string>;

  constructor(
    private readonly maxConcurrent = Math.max(
      2,
      Math.floor(availableParallelism() / 2),
    ),
  ) {
    // Comparée quand l'e-mail est inconnu : la réponse prend le même temps qu'un mauvais mot de passe.
    this.dummy = argon2.hash('mot-de-passe-factice-pour-temps-constant', {
      type: argon2.argon2id,
    });
  }

  hash(password: string): Promise<string> {
    return this.limited(() => argon2.hash(password, { type: argon2.argon2id }));
  }

  async verify(hash: string | null, password: string): Promise<boolean> {
    const target = hash ?? (await this.dummy);
    const valid = await this.limited(() =>
      argon2.verify(target, password).catch(() => false),
    );
    return valid && hash !== null;
  }

  private async limited<T>(work: () => Promise<T>): Promise<T> {
    if (this.running >= this.maxConcurrent) {
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
    this.running++;
    try {
      return await work();
    } finally {
      this.running--;
      this.waiting.shift()?.();
    }
  }
}
