// Provider-derived lookup tables for the dialog.
import { accountsFor } from "./format.js";
import { PROVIDERS } from "./providers.js";

export const LOGOS = {};
export const SHORT_NAMES = {};
export const HELPERS = {};
export const CCUSAGE_AGENTS = {};
export const CREDENTIAL_BASES = [];

for (const provider of PROVIDERS) {
  if (provider.logo) LOGOS[provider.id] = provider.logo;
  for (const [id, file] of Object.entries(provider.logos ?? {})) {
    LOGOS[id] = file;
  }
  if (provider.short) SHORT_NAMES[provider.id] = provider.short;
  if (provider.helper) HELPERS[provider.id] = provider.helper;
  if (provider.ccusageAgent) {
    CCUSAGE_AGENTS[provider.id] = provider.ccusageAgent;
  }
  if (provider.credential) {
    CREDENTIAL_BASES.push({ base: provider.id, ...provider.credential });
  }
  for (const child of provider.providers ?? []) {
    if (child.short) SHORT_NAMES[child.id] = child.short;
    if (child.ccusageAgent) CCUSAGE_AGENTS[child.id] = child.ccusageAgent;
  }
}

export function credentialInstances() {
  return CREDENTIAL_BASES.flatMap((base) =>
    accountsFor(base.base, base.name).map((account) => ({
      ...base,
      id: account.id,
      label: account.label,
      extra: account.id !== base.base,
    }))
  );
}
