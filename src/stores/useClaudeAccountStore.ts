import {
  ClaudeAccount,
  getClaudeAccountDisplayEmail,
  getClaudePlanBadge,
  getClaudeUsage,
} from '../types/claude';
import * as claudeService from '../services/claudeService';
import { getProviderCurrentAccountId } from '../services/providerCurrentAccountService';
import { createProviderAccountStore } from './createProviderAccountStore';

const CLAUDE_ACCOUNTS_CACHE_KEY = 'agtools.claude.accounts.cache';
const CLAUDE_CURRENT_ACCOUNT_ID_KEY = 'agtools.claude.current_account_id';

export const useClaudeAccountStore = createProviderAccountStore<ClaudeAccount>(
  CLAUDE_ACCOUNTS_CACHE_KEY,
  {
    listAccounts: claudeService.listClaudeAccounts,
    deleteAccount: claudeService.deleteClaudeAccount,
    deleteAccounts: claudeService.deleteClaudeAccounts,
    injectAccount: claudeService.injectClaudeAccount,
    refreshToken: claudeService.refreshClaudeToken,
    refreshAllTokens: claudeService.refreshAllClaudeTokens,
    importFromJson: claudeService.importClaudeFromJson,
    exportAccounts: claudeService.exportClaudeAccounts,
    updateAccountTags: claudeService.updateClaudeAccountTags,
  },
  {
    getDisplayEmail: getClaudeAccountDisplayEmail,
    getPlanBadge: getClaudePlanBadge,
    getUsage: getClaudeUsage,
  },
  {
    platformId: 'claude',
    currentAccountIdKey: CLAUDE_CURRENT_ACCOUNT_ID_KEY,
    resolveCurrentAccountId: () => getProviderCurrentAccountId('claude'),
  },
);
