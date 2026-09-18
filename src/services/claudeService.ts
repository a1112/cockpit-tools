import { invoke } from '@tauri-apps/api/core';
import type { ClaudeAccount } from '../types/claude';

export async function listClaudeAccounts(): Promise<ClaudeAccount[]> {
  return await invoke('list_claude_accounts');
}

export async function deleteClaudeAccount(accountId: string): Promise<void> {
  return await invoke('delete_claude_account', { accountId });
}

export async function deleteClaudeAccounts(accountIds: string[]): Promise<void> {
  return await invoke('delete_claude_accounts', { accountIds });
}

export async function importClaudeFromJson(jsonContent: string): Promise<ClaudeAccount[]> {
  return await invoke('import_claude_from_json', { jsonContent });
}

export async function importClaudeFromLocal(): Promise<ClaudeAccount[]> {
  return await invoke('import_claude_from_local');
}

export async function addClaudeAccountWithToken(
  authToken: string,
  baseUrl?: string | null,
  label?: string | null,
  model?: string | null,
): Promise<ClaudeAccount> {
  return await invoke('add_claude_account_with_token', {
    authToken,
    baseUrl: baseUrl || null,
    label: label || null,
    model: model || null,
  });
}

export async function exportClaudeAccounts(accountIds: string[]): Promise<string> {
  return await invoke('export_claude_accounts', { accountIds });
}

export async function refreshClaudeToken(accountId: string): Promise<ClaudeAccount> {
  return await invoke('refresh_claude_token', { accountId });
}

export async function refreshAllClaudeTokens(): Promise<number> {
  return await invoke('refresh_all_claude_tokens');
}

export async function injectClaudeAccount(accountId: string): Promise<string> {
  return await invoke('inject_claude_account', { accountId });
}

export async function updateClaudeAccountTags(accountId: string, tags: string[]): Promise<ClaudeAccount> {
  return await invoke('update_claude_account_tags', { accountId, tags });
}

export async function getClaudeAccountsIndexPath(): Promise<string> {
  return await invoke('get_claude_accounts_index_path');
}
