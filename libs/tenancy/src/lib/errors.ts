/** Erreurs du domaine entreprises et membres, traduites en réponses HTTP par l'API. */

/** La personne n'est pas membre de cette entreprise, ou l'entreprise n'existe pas : même réponse (404). */
export class TenantNotFoundError extends Error {
  constructor() {
    super('entreprise introuvable');
  }
}

export class MemberNotFoundError extends Error {
  constructor() {
    super('membre introuvable');
  }
}

/** Règle de rôle : un administrateur ne nomme pas de propriétaire et ne touche pas aux propriétaires. */
export class RoleChangeForbiddenError extends Error {}

export class LastOwnerError extends Error {
  constructor() {
    super('une entreprise garde au moins un propriétaire');
  }
}

export class InvitationInvalidError extends Error {
  constructor(reason: 'unknown' | 'expired' | 'used') {
    super(
      reason === 'unknown'
        ? 'invitation inconnue'
        : reason === 'expired'
          ? 'invitation expirée'
          : 'invitation déjà utilisée',
    );
  }
}

/** L'invitation a été envoyée à une autre adresse que celle du compte qui tente de l'accepter. */
export class InvitationEmailMismatchError extends Error {
  constructor() {
    super('cette invitation est destinée à une autre adresse');
  }
}

export class AlreadyMemberError extends Error {
  constructor() {
    super('déjà membre de cette entreprise');
  }
}
