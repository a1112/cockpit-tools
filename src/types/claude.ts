export interface ClaudeAccount {
  id: string;
  email: string;
  display_name?: string | null;
  auth_token?: string | null;
  base_url?: string | null;
  model?: string | null;
  api_timeout_ms?: string | null;
  tags?: string[] | null;
  settings_raw?: unknown;
  created_at: number;
  last_used: number;
  plan_type?: string | null;
}

export function getClaudeAccountDisplayEmail(account: ClaudeAccount): string {
  return account.display_name?.trim() || account.email?.trim() || account.base_url?.trim() || account.id;
}

export function getClaudePlanBadge(account: ClaudeAccount): string {
  const baseUrl = account.base_url?.trim();
  if (!baseUrl) return 'OFFICIAL';
  try {
    const host = new URL(baseUrl).host.replace(/^api\./, '');
    return host.toUpperCase();
  } catch {
    return 'CUSTOM';
  }
}

export function getClaudeUsage() {
  return {
    inlineSuggestionsUsedPercent: null,
    chatMessagesUsedPercent: null,
  };
}
