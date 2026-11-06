/** Erreurs d'authentification. Le message reste volontairement le même pour un e-mail inconnu et un mauvais mot de passe. */

export class InvalidCredentialsError extends Error {
  constructor() {
    super('e-mail ou mot de passe incorrect');
  }
}

export class EmailTakenError extends Error {
  constructor() {
    super('un compte existe déjà avec cette adresse');
  }
}

export class InvalidSessionError extends Error {
  constructor(readonly reason: 'unknown' | 'expired' | 'revoked' | 'replayed') {
    super('session invalide ou expirée');
  }
}

export class InvalidAccessTokenError extends Error {
  constructor() {
    super('jeton d’accès invalide ou expiré');
  }
}
