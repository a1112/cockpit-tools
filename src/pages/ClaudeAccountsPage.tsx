import { ChangeEvent, useEffect, useMemo, useRef, useState } from 'react';
import {
  Check,
  Database,
  Download,
  Eye,
  EyeOff,
  KeyRound,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  Upload,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useClaudeAccountStore } from '../stores/useClaudeAccountStore';
import * as claudeService from '../services/claudeService';
import type { ClaudeAccount } from '../types/claude';
import { getClaudeAccountDisplayEmail, getClaudePlanBadge } from '../types/claude';
import { maskSensitiveValue, isPrivacyModeEnabledByDefault } from '../utils/privacy';
import { PlatformOverviewTabsHeader } from '../components/platform/PlatformOverviewTabsHeader';
import '../styles/pages/accounts.css';

function formatDateTime(value: number): string {
  if (!value) return '--';
  return new Date(value * 1000).toLocaleString();
}

function downloadJson(filename: string, content: string) {
  const blob = new Blob([content], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

export function ClaudeAccountsPage() {
  const { t } = useTranslation();
  const store = useClaudeAccountStore();
  const importInputRef = useRef<HTMLInputElement | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [authToken, setAuthToken] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [label, setLabel] = useState('');
  const [model, setModel] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [privacyModeEnabled, setPrivacyModeEnabled] = useState(() => isPrivacyModeEnabledByDefault());

  useEffect(() => {
    void store.fetchAccounts();
    void store.fetchCurrentAccountId?.();
  }, []);

  const accounts = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) return store.accounts;
    return store.accounts.filter((account) =>
      [
        account.email,
        account.display_name,
        account.base_url,
        account.model,
        ...(account.tags ?? []),
      ]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(query)),
    );
  }, [searchQuery, store.accounts]);

  const setResult = (nextMessage: string) => {
    setMessage(nextMessage);
    setError(null);
  };

  const setFailure = (err: unknown) => {
    setError(err instanceof Error ? err.message : String(err));
    setMessage(null);
  };

  const handleImportLocal = async () => {
    setBusy('import-local');
    try {
      const imported = await claudeService.importClaudeFromLocal();
      await store.fetchAccounts();
      setResult(t('claude.importLocalSuccess', { count: imported.length, defaultValue: '已导入本地 Claude 配置' }));
    } catch (err) {
      setFailure(err);
    } finally {
      setBusy(null);
    }
  };

  const handleAddToken = async () => {
    if (!authToken.trim()) {
      setFailure(new Error(t('claude.tokenRequired', '请输入 Claude token')));
      return;
    }
    setBusy('add-token');
    try {
      await claudeService.addClaudeAccountWithToken(
        authToken,
        baseUrl.trim() || null,
        label.trim() || null,
        model.trim() || null,
      );
      setAuthToken('');
      setBaseUrl('');
      setLabel('');
      setModel('');
      await store.fetchAccounts();
      setResult(t('claude.addSuccess', 'Claude 账号已添加'));
    } catch (err) {
      setFailure(err);
    } finally {
      setBusy(null);
    }
  };

  const handleImportJson = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setBusy('import-json');
    try {
      const content = await file.text();
      const imported = await claudeService.importClaudeFromJson(content);
      await store.fetchAccounts();
      setResult(t('claude.importJsonSuccess', { count: imported.length, defaultValue: `已导入 ${imported.length} 个 Claude 账号` }));
    } catch (err) {
      setFailure(err);
    } finally {
      setBusy(null);
    }
  };

  const handleExport = async () => {
    setBusy('export');
    try {
      const content = await claudeService.exportClaudeAccounts(accounts.map((account) => account.id));
      downloadJson(`claude_accounts_${Date.now()}.json`, content);
      setResult(t('claude.exportSuccess', 'Claude 账号已导出'));
    } catch (err) {
      setFailure(err);
    } finally {
      setBusy(null);
    }
  };

  const handleSwitch = async (account: ClaudeAccount) => {
    setBusy(`switch:${account.id}`);
    try {
      await store.switchAccount(account.id);
      await store.fetchCurrentAccountId?.();
      await store.fetchAccounts();
      setResult(t('claude.switchSuccess', { account: getClaudeAccountDisplayEmail(account), defaultValue: 'Claude 账号已切换' }));
    } catch (err) {
      setFailure(err);
    } finally {
      setBusy(null);
    }
  };

  const handleDelete = async (account: ClaudeAccount) => {
    if (!window.confirm(t('claude.deleteConfirm', { account: getClaudeAccountDisplayEmail(account), defaultValue: '确定删除这个 Claude 账号？' }))) {
      return;
    }
    setBusy(`delete:${account.id}`);
    try {
      await store.deleteAccounts([account.id]);
      await store.fetchAccounts();
      setResult(t('claude.deleteSuccess', 'Claude 账号已删除'));
    } catch (err) {
      setFailure(err);
    } finally {
      setBusy(null);
    }
  };

  const handleRefresh = async (account: ClaudeAccount) => {
    setBusy(`refresh:${account.id}`);
    try {
      await store.refreshToken(account.id);
      await store.fetchAccounts();
      setResult(t('claude.refreshSuccess', 'Claude 账号状态已刷新'));
    } catch (err) {
      setFailure(err);
    } finally {
      setBusy(null);
    }
  };

  const mask = (value?: string | null) => maskSensitiveValue(value, privacyModeEnabled);

  return (
    <div className="accounts-page provider-accounts-page">
      <PlatformOverviewTabsHeader platform="claude" active="overview" tabs={['overview']} />

      <div className="accounts-toolbar">
        <div className="accounts-search">
          <Search size={16} />
          <input
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            placeholder={t('common.search', '搜索')}
          />
        </div>
        <button className="btn secondary" onClick={() => setPrivacyModeEnabled((value) => !value)}>
          {privacyModeEnabled ? <EyeOff size={16} /> : <Eye size={16} />}
          {privacyModeEnabled ? t('common.privacyOn', '隐私模式') : t('common.privacyOff', '显示明文')}
        </button>
        <button className="btn secondary" disabled={busy === 'import-local'} onClick={handleImportLocal}>
          <Database size={16} />
          {t('claude.importLocal', '导入本机 Claude')}
        </button>
        <button className="btn secondary" onClick={() => importInputRef.current?.click()}>
          <Upload size={16} />
          {t('common.import', '导入')}
        </button>
        <button className="btn secondary" disabled={accounts.length === 0 || busy === 'export'} onClick={handleExport}>
          <Download size={16} />
          {t('common.export', '导出')}
        </button>
        <input ref={importInputRef} type="file" accept="application/json,.json" hidden onChange={handleImportJson} />
      </div>

      <div className="accounts-add-panel">
        <div className="accounts-add-panel-title">
          <KeyRound size={16} />
          <span>{t('claude.addTokenTitle', '添加 Claude Code Token')}</span>
        </div>
        <div className="accounts-add-grid">
          <input value={label} onChange={(event) => setLabel(event.target.value)} placeholder={t('claude.labelPlaceholder', '账号备注，例如主账号')} />
          <input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder="ANTHROPIC_BASE_URL" />
          <input value={model} onChange={(event) => setModel(event.target.value)} placeholder={t('claude.modelPlaceholder', 'model，例如 opus[1m]')} />
          <input value={authToken} onChange={(event) => setAuthToken(event.target.value)} placeholder="ANTHROPIC_AUTH_TOKEN" type="password" />
          <button className="btn primary" disabled={busy === 'add-token'} onClick={handleAddToken}>
            <Plus size={16} />
            {t('common.add', '添加')}
          </button>
        </div>
      </div>

      {message && <div className="modal-success-message">{message}</div>}
      {(error || store.error) && <div className="modal-error-message">{error || store.error}</div>}

      <div className="accounts-grid">
        {accounts.map((account) => {
          const isCurrent = store.currentAccountId === account.id;
          return (
            <div className={`account-card ${isCurrent ? 'current' : ''}`} key={account.id}>
              <div className="account-card-header">
                <div>
                  <h3>{mask(getClaudeAccountDisplayEmail(account))}</h3>
                  <p>{mask(account.base_url || 'https://api.anthropic.com')}</p>
                </div>
                <span className="plan-badge">{getClaudePlanBadge(account)}</span>
              </div>
              <div className="account-meta">
                <span>{t('claude.model', '模型')}: {account.model || '--'}</span>
                <span>{t('common.createdAt', '创建')}: {formatDateTime(account.created_at)}</span>
                <span>{t('common.lastUsed', '最近使用')}: {formatDateTime(account.last_used)}</span>
              </div>
              <div className="account-actions">
                <button className="btn primary" disabled={isCurrent || busy === `switch:${account.id}`} onClick={() => handleSwitch(account)}>
                  <Check size={16} />
                  {isCurrent ? t('common.current', '当前') : t('common.switch', '切换')}
                </button>
                <button className="btn secondary" disabled={busy === `refresh:${account.id}`} onClick={() => handleRefresh(account)}>
                  <RefreshCw size={16} />
                  {t('common.refresh', '刷新')}
                </button>
                <button className="btn danger" disabled={busy === `delete:${account.id}`} onClick={() => handleDelete(account)}>
                  <Trash2 size={16} />
                  {t('common.delete', '删除')}
                </button>
              </div>
            </div>
          );
        })}
        {!store.loading && accounts.length === 0 && (
          <div className="empty-state">{t('claude.empty', '暂无 Claude 账号')}</div>
        )}
      </div>
    </div>
  );
}
