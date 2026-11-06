// Vérifie les licences des dépendances livrées en production, à partir du SBOM CycloneDX.
//   node scripts/verifier-licences.mjs sbom.cdx.json
// Refusées : copyleft fort (GPL, AGPL, SSPL…), qui imposerait de publier le code d'un service qui les utilise.
// Signalées sans bloquer : copyleft faible (MPL, EPL, LGPL), acceptable pour une dépendance non modifiée.
// Une dépendance tierce sans licence déclarée bloque : on ne sait pas si on a le droit de l'utiliser.
import { readFileSync } from 'node:fs';

const path = process.argv[2];
if (!path) {
  console.error('usage : node scripts/verifier-licences.mjs <sbom.cdx.json>');
  process.exit(2);
}
const sbom = JSON.parse(readFileSync(path, 'utf8'));

const DENIED = /\b(A?GPL|SSPL|EUPL|OSL|CPAL|RPL)\b/i;
const WEAK = /\b(LGPL|MPL|EPL|CDDL)\b/i;
const OWN_GROUP = '@stockpilot';

function licensesOf(component) {
  return (component.licenses ?? [])
    .map((l) => l.expression ?? l.license?.id ?? l.license?.name)
    .filter(Boolean);
}

const denied = [];
const weak = [];
const unknown = [];
for (const component of sbom.components ?? []) {
  if (component.group === OWN_GROUP) continue;
  const name = `${component.group ? `${component.group}/` : ''}${component.name}@${component.version}`;
  const licenses = licensesOf(component);
  const text = licenses.join(' ');
  // « MIT OR GPL-3.0 » : on peut choisir la licence permissive.
  const choosable =
    /\bOR\b/.test(text) &&
    licenses.some((l) => l.split(/\s+OR\s+/).some((p) => !DENIED.test(p)));
  if (licenses.length === 0) unknown.push(name);
  else if (DENIED.test(text) && !choosable) denied.push(`${name} (${text})`);
  else if (WEAK.test(text)) weak.push(`${name} (${text})`);
}

const total = (sbom.components ?? []).filter(
  (c) => c.group !== OWN_GROUP,
).length;
console.log(`${total} dépendances tierces livrées en production analysées.`);
for (const line of weak) console.log(`  copyleft faible, accepté : ${line}`);
for (const line of unknown) console.error(`  licence inconnue : ${line}`);
for (const line of denied) console.error(`  licence refusée : ${line}`);
if (denied.length > 0 || unknown.length > 0) {
  console.error(
    `${denied.length} licence(s) refusée(s), ${unknown.length} inconnue(s).`,
  );
  process.exit(1);
}
console.log('Aucune licence refusée.');
