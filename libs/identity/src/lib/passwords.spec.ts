import * as argon2 from 'argon2';
import { PasswordHasher } from './passwords';

it('vérifie un mot de passe, refuse le mauvais, et traite un compte inconnu comme un échec', async () => {
  const hasher = new PasswordHasher(2);
  const hash = await hasher.hash('mot-de-passe-correct');

  expect(hash).toMatch(/^\$argon2id\$/);
  expect(await hasher.verify(hash, 'mot-de-passe-correct')).toBe(true);
  expect(await hasher.verify(hash, 'autre')).toBe(false);
  expect(await hasher.verify(null, 'mot-de-passe-correct')).toBe(false);
});

it('jamais plus de calculs simultanés que la limite, et la boucle d’événements continue de tourner', async () => {
  const hasher = new PasswordHasher(2);
  let running = 0;
  let peak = 0;
  const real = argon2.hash;
  const spy = jest
    .spyOn(argon2, 'hash')
    .mockImplementation(async (...args: Parameters<typeof argon2.hash>) => {
      running++;
      peak = Math.max(peak, running);
      try {
        return await real(...args);
      } finally {
        running--;
      }
    });
  let ticks = 0;
  const timer = setInterval(() => ticks++, 5);

  try {
    await Promise.all(
      Array.from({ length: 6 }, (_, i) => hasher.hash(`mot-de-passe-${i}`)),
    );
  } finally {
    clearInterval(timer);
    spy.mockRestore();
  }

  expect(peak).toBe(2);
  expect(ticks).toBeGreaterThan(5);
});
