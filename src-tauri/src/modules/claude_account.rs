use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::HashSet;
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

use crate::models::claude::{ClaudeAccount, ClaudeAccountIndex};
use crate::modules::{account, logger};

const ACCOUNTS_INDEX_FILE: &str = "claude_accounts.json";
const ACCOUNTS_DIR: &str = "claude_accounts";

static CLAUDE_ACCOUNT_INDEX_LOCK: std::sync::LazyLock<Mutex<()>> =
    std::sync::LazyLock::new(|| Mutex::new(()));

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ClaudeExportPayload {
    version: String,
    current_account_id: Option<String>,
    accounts: Vec<ClaudeAccount>,
}

fn now_ts() -> i64 {
    chrono::Utc::now().timestamp()
}

fn normalize_non_empty(value: Option<&str>) -> Option<String> {
    value.and_then(|raw| {
        let trimmed = raw.trim();
        (!trimmed.is_empty()).then_some(trimmed.to_string())
    })
}

fn sanitize_account_id_component(value: &str) -> String {
    value
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '_' || ch == '-' || ch == '.' {
                ch
            } else {
                '_'
            }
        })
        .collect()
}

fn generate_account_id(token: Option<&str>, base_url: Option<&str>, label: Option<&str>) -> String {
    if let Some(label) = normalize_non_empty(label) {
        let cleaned = sanitize_account_id_component(&label.to_lowercase());
        if !cleaned.is_empty() {
            return format!("claude_{}", cleaned);
        }
    }

    let basis = format!(
        "{}|{}",
        token.unwrap_or_default().trim(),
        base_url.unwrap_or_default().trim()
    );
    format!("claude_{:x}", md5::compute(basis.as_bytes()))
}

fn normalize_account_id(account_id: &str) -> Result<String, String> {
    let trimmed = account_id.trim();
    if trimmed.is_empty() {
        return Err("账号 ID 不能为空".to_string());
    }
    if trimmed.contains('/') || trimmed.contains('\\') || trimmed.contains("..") {
        return Err("账号 ID 非法，包含路径字符".to_string());
    }
    let valid = trimmed
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '-' || ch == '.');
    if !valid {
        return Err("账号 ID 非法，仅允许字母/数字/._-".to_string());
    }
    Ok(trimmed.to_string())
}

fn get_data_dir() -> Result<PathBuf, String> {
    account::get_data_dir()
}

fn get_accounts_dir() -> Result<PathBuf, String> {
    let dir = get_data_dir()?.join(ACCOUNTS_DIR);
    if !dir.exists() {
        fs::create_dir_all(&dir).map_err(|e| format!("创建 Claude 账号目录失败: {}", e))?;
    }
    Ok(dir)
}

fn get_accounts_index_path() -> Result<PathBuf, String> {
    Ok(get_data_dir()?.join(ACCOUNTS_INDEX_FILE))
}

pub fn accounts_index_path_string() -> Result<String, String> {
    Ok(get_accounts_index_path()?.to_string_lossy().to_string())
}

fn resolve_account_file_path(account_id: &str) -> Result<PathBuf, String> {
    Ok(get_accounts_dir()?.join(format!("{}.json", normalize_account_id(account_id)?)))
}

fn claude_settings_path() -> Result<PathBuf, String> {
    let home = std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
        .ok_or_else(|| "无法定位用户主目录".to_string())?;
    Ok(home.join(".claude").join("settings.json"))
}

pub fn load_account(account_id: &str) -> Option<ClaudeAccount> {
    let path = resolve_account_file_path(account_id).ok()?;
    let content = fs::read_to_string(&path).ok()?;
    crate::modules::atomic_write::parse_json_with_auto_restore(&path, &content).ok()
}

fn save_account_file(account: &ClaudeAccount) -> Result<(), String> {
    let path = resolve_account_file_path(&account.id)?;
    let content =
        serde_json::to_string_pretty(account).map_err(|e| format!("序列化账号失败: {}", e))?;
    crate::modules::atomic_write::write_string_atomic(&path, &content)
        .map_err(|e| format!("保存账号失败: {}", e))
}

fn load_account_index() -> ClaudeAccountIndex {
    let path = match get_accounts_index_path() {
        Ok(path) => path,
        Err(_) => return ClaudeAccountIndex::new(),
    };
    if !path.exists() {
        return repair_account_index_from_details("索引文件不存在")
            .unwrap_or_else(ClaudeAccountIndex::new);
    }
    match fs::read_to_string(&path) {
        Ok(content) if content.trim().is_empty() => repair_account_index_from_details("索引文件为空")
            .unwrap_or_else(ClaudeAccountIndex::new),
        Ok(content) => crate::modules::atomic_write::parse_json_with_auto_restore::<
            ClaudeAccountIndex,
        >(&path, &content)
        .ok()
        .filter(|index| !index.accounts.is_empty())
        .or_else(|| repair_account_index_from_details("索引文件异常"))
        .unwrap_or_else(ClaudeAccountIndex::new),
        Err(_) => ClaudeAccountIndex::new(),
    }
}

fn load_account_index_checked() -> Result<ClaudeAccountIndex, String> {
    let path = get_accounts_index_path()?;
    if !path.exists() {
        return Ok(repair_account_index_from_details("索引文件不存在")
            .unwrap_or_else(ClaudeAccountIndex::new));
    }
    let content = fs::read_to_string(&path).map_err(|e| format!("读取账号索引失败: {}", e))?;
    if content.trim().is_empty() {
        return Ok(repair_account_index_from_details("索引文件为空")
            .unwrap_or_else(ClaudeAccountIndex::new));
    }
    match crate::modules::atomic_write::parse_json_with_auto_restore::<ClaudeAccountIndex>(
        &path, &content,
    ) {
        Ok(index) => Ok(index),
        Err(err) => {
            if let Some(index) = repair_account_index_from_details("索引文件损坏") {
                return Ok(index);
            }
            Err(crate::error::file_corrupted_error(
                ACCOUNTS_INDEX_FILE,
                &path.to_string_lossy(),
                &err.to_string(),
            ))
        }
    }
}

fn save_account_index(index: &ClaudeAccountIndex) -> Result<(), String> {
    let path = get_accounts_index_path()?;
    let content =
        serde_json::to_string_pretty(index).map_err(|e| format!("序列化账号索引失败: {}", e))?;
    crate::modules::atomic_write::write_string_atomic(&path, &content)
        .map_err(|e| format!("写入账号索引失败: {}", e))
}

fn repair_account_index_from_details(reason: &str) -> Option<ClaudeAccountIndex> {
    let accounts_dir = get_accounts_dir().ok()?;
    let mut accounts = crate::modules::account_index_repair::load_accounts_from_details(
        &accounts_dir,
        |account_id| load_account(account_id),
    )
    .ok()?;
    if accounts.is_empty() {
        return None;
    }
    crate::modules::account_index_repair::sort_accounts_by_recency(
        &mut accounts,
        |account| account.last_used,
        |account| account.created_at,
        |account| account.id.as_str(),
    );
    let mut index = ClaudeAccountIndex::new();
    index.accounts = accounts.iter().map(|account| account.summary()).collect();
    if let Err(err) = save_account_index(&index) {
        logger::log_warn(&format!(
            "[Claude Account] 自动修复索引保存失败: reason={}, error={}",
            reason, err
        ));
    }
    Some(index)
}

fn refresh_summary(index: &mut ClaudeAccountIndex, account: &ClaudeAccount) {
    if let Some(summary) = index.accounts.iter_mut().find(|item| item.id == account.id) {
        *summary = account.summary();
    } else {
        index.accounts.push(account.summary());
    }
}

fn upsert_account_record(account: ClaudeAccount) -> Result<ClaudeAccount, String> {
    let _lock = CLAUDE_ACCOUNT_INDEX_LOCK
        .lock()
        .map_err(|_| "获取 Claude 账号锁失败".to_string())?;
    let mut index = load_account_index();
    save_account_file(&account)?;
    refresh_summary(&mut index, &account);
    save_account_index(&index)?;
    Ok(account)
}

fn list_accounts_from_index(index: &ClaudeAccountIndex) -> Vec<ClaudeAccount> {
    let mut accounts: Vec<ClaudeAccount> = index
        .accounts
        .iter()
        .filter_map(|summary| load_account(&summary.id))
        .collect();
    accounts.sort_by(|a, b| {
        b.last_used
            .cmp(&a.last_used)
            .then_with(|| b.created_at.cmp(&a.created_at))
            .then_with(|| a.email.cmp(&b.email))
    });
    accounts
}

pub fn list_accounts() -> Vec<ClaudeAccount> {
    list_accounts_from_index(&load_account_index())
}

pub fn list_accounts_checked() -> Result<Vec<ClaudeAccount>, String> {
    Ok(list_accounts_from_index(&load_account_index_checked()?))
}

fn value_string(object: &Map<String, Value>, key: &str) -> Option<String> {
    object
        .get(key)
        .and_then(|value| value.as_str())
        .and_then(|value| normalize_non_empty(Some(value)))
}

fn account_from_settings(settings: &Value, fallback_label: Option<&str>) -> Result<ClaudeAccount, String> {
    let root = settings
        .as_object()
        .ok_or_else(|| "Claude settings.json 不是对象".to_string())?;
    let env = root
        .get("env")
        .and_then(|value| value.as_object())
        .ok_or_else(|| "Claude settings.json 缺少 env 配置".to_string())?;
    let auth_token = value_string(env, "ANTHROPIC_AUTH_TOKEN")
        .or_else(|| value_string(env, "ANTHROPIC_API_KEY"))
        .ok_or_else(|| "Claude settings.json 缺少 ANTHROPIC_AUTH_TOKEN 或 ANTHROPIC_API_KEY".to_string())?;
    let base_url = value_string(env, "ANTHROPIC_BASE_URL");
    let model = root
        .get("model")
        .and_then(|value| value.as_str())
        .and_then(|value| normalize_non_empty(Some(value)))
        .or_else(|| value_string(env, "ANTHROPIC_MODEL"));
    let label = normalize_non_empty(fallback_label)
        .or_else(|| value_string(env, "ANTHROPIC_ACCOUNT_LABEL"))
        .or_else(|| base_url.clone())
        .unwrap_or_else(|| "Claude".to_string());
    let now = now_ts();
    Ok(ClaudeAccount {
        id: generate_account_id(Some(&auth_token), base_url.as_deref(), Some(&label)),
        email: label.clone(),
        display_name: Some(label),
        auth_token: Some(auth_token),
        base_url,
        model,
        api_timeout_ms: value_string(env, "API_TIMEOUT_MS"),
        tags: None,
        settings_raw: Some(settings.clone()),
        created_at: now,
        last_used: now,
    })
}

fn normalize_imported_account(mut account: ClaudeAccount) -> Result<ClaudeAccount, String> {
    let now = now_ts();
    account.auth_token = normalize_non_empty(account.auth_token.as_deref());
    account.base_url = normalize_non_empty(account.base_url.as_deref());
    account.model = normalize_non_empty(account.model.as_deref());
    account.api_timeout_ms = normalize_non_empty(account.api_timeout_ms.as_deref());
    account.email = normalize_non_empty(Some(&account.email)).unwrap_or_else(|| {
        account
            .display_name
            .clone()
            .unwrap_or_else(|| account.base_url.clone().unwrap_or_else(|| "Claude".to_string()))
    });
    if account.auth_token.is_none() {
        return Err(format!("Claude 账号缺少 auth_token: {}", account.email));
    }
    account.id = if account.id.trim().is_empty() {
        generate_account_id(
            account.auth_token.as_deref(),
            account.base_url.as_deref(),
            Some(&account.email),
        )
    } else {
        normalize_account_id(&account.id)?
    };
    if account.created_at <= 0 {
        account.created_at = now;
    }
    if account.last_used <= 0 {
        account.last_used = account.created_at;
    }
    Ok(account)
}

pub fn add_account_with_token(
    auth_token: &str,
    base_url: Option<String>,
    label: Option<String>,
    model: Option<String>,
) -> Result<ClaudeAccount, String> {
    let token = normalize_non_empty(Some(auth_token)).ok_or_else(|| "Claude token 不能为空".to_string())?;
    let label = normalize_non_empty(label.as_deref())
        .or_else(|| normalize_non_empty(base_url.as_deref()))
        .unwrap_or_else(|| "Claude".to_string());
    let now = now_ts();
    upsert_account_record(ClaudeAccount {
        id: generate_account_id(Some(&token), base_url.as_deref(), Some(&label)),
        email: label.clone(),
        display_name: Some(label),
        auth_token: Some(token),
        base_url: normalize_non_empty(base_url.as_deref()),
        model: normalize_non_empty(model.as_deref()),
        api_timeout_ms: None,
        tags: None,
        settings_raw: None,
        created_at: now,
        last_used: now,
    })
}

pub fn import_from_local() -> Result<Option<ClaudeAccount>, String> {
    let path = claude_settings_path()?;
    if !path.exists() {
        return Ok(None);
    }
    let content = fs::read_to_string(&path)
        .map_err(|e| format!("读取 Claude settings.json 失败: {}", e))?;
    let settings: Value =
        serde_json::from_str(&content).map_err(|e| format!("解析 Claude settings.json 失败: {}", e))?;
    upsert_account_record(account_from_settings(&settings, None)?).map(Some)
}

pub fn import_from_json(json_content: &str) -> Result<Vec<ClaudeAccount>, String> {
    let value: Value =
        serde_json::from_str(json_content).map_err(|e| format!("解析 JSON 失败: {}", e))?;
    let raw_accounts = if value.get("accounts").is_some() {
        value
            .get("accounts")
            .and_then(|accounts| accounts.as_array())
            .cloned()
            .ok_or_else(|| "JSON accounts 字段不是数组".to_string())?
    } else if let Some(items) = value.as_array() {
        items.clone()
    } else {
        vec![value]
    };
    raw_accounts
        .into_iter()
        .map(|raw| {
            let account = if raw.get("env").is_some() {
                account_from_settings(&raw, None)?
            } else {
                normalize_imported_account(
                    serde_json::from_value(raw)
                        .map_err(|e| format!("解析 Claude 账号失败: {}", e))?,
                )?
            };
            upsert_account_record(account)
        })
        .collect()
}

pub fn export_accounts(account_ids: &[String]) -> Result<String, String> {
    let selected: HashSet<&str> = account_ids.iter().map(|id| id.as_str()).collect();
    let accounts: Vec<ClaudeAccount> = list_accounts()
        .into_iter()
        .filter(|account| selected.is_empty() || selected.contains(account.id.as_str()))
        .collect();
    serde_json::to_string_pretty(&ClaudeExportPayload {
        version: "1.0".to_string(),
        current_account_id: resolve_current_account_id(),
        accounts,
    })
    .map_err(|e| format!("导出 Claude 账号失败: {}", e))
}

pub fn update_account_tags(account_id: &str, tags: Vec<String>) -> Result<ClaudeAccount, String> {
    let mut account =
        load_account(account_id).ok_or_else(|| format!("Claude 账号不存在: {}", account_id))?;
    let clean_tags: Vec<String> = tags
        .into_iter()
        .map(|tag| tag.trim().to_string())
        .filter(|tag| !tag.is_empty())
        .collect();
    account.tags = (!clean_tags.is_empty()).then_some(clean_tags);
    upsert_account_record(account)
}

pub fn remove_account(account_id: &str) -> Result<(), String> {
    let _lock = CLAUDE_ACCOUNT_INDEX_LOCK
        .lock()
        .map_err(|_| "获取 Claude 账号锁失败".to_string())?;
    let normalized = normalize_account_id(account_id)?;
    let mut index = load_account_index();
    index.accounts.retain(|account| account.id != normalized);
    let path = resolve_account_file_path(&normalized)?;
    if path.exists() {
        fs::remove_file(path).map_err(|e| format!("删除账号文件失败: {}", e))?;
    }
    save_account_index(&index)?;
    if resolve_current_account_id().as_deref() == Some(normalized.as_str()) {
        let _ = crate::modules::provider_current_state::set_current_account_id("claude", None);
    }
    Ok(())
}

pub fn remove_accounts(account_ids: &[String]) -> Result<(), String> {
    for account_id in account_ids {
        remove_account(account_id)?;
    }
    Ok(())
}

pub fn resolve_current_account_id() -> Option<String> {
    let accounts = list_accounts();
    crate::modules::provider_current_state::resolve_existing_current_account_id(
        "claude",
        accounts.iter().map(|account| account.id.as_str()),
    )
}

pub fn refresh_account(account_id: &str) -> Result<ClaudeAccount, String> {
    let mut account =
        load_account(account_id).ok_or_else(|| format!("Claude 账号不存在: {}", account_id))?;
    account.last_used = now_ts();
    upsert_account_record(account)
}

pub fn refresh_all_accounts() -> Result<i32, String> {
    let accounts = list_accounts();
    for account in &accounts {
        let _ = refresh_account(&account.id);
    }
    Ok(accounts.len() as i32)
}

pub fn inject_account(account_id: &str) -> Result<ClaudeAccount, String> {
    let mut account =
        load_account(account_id).ok_or_else(|| format!("Claude 账号不存在: {}", account_id))?;
    let auth_token = account
        .auth_token
        .clone()
        .ok_or_else(|| format!("Claude 账号缺少 token: {}", account_id))?;
    let path = claude_settings_path()?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建 Claude 配置目录失败: {}", e))?;
    }
    let mut settings = if path.exists() {
        let content = fs::read_to_string(&path)
            .map_err(|e| format!("读取 Claude settings.json 失败: {}", e))?;
        if content.trim().is_empty() {
            Value::Object(Map::new())
        } else {
            serde_json::from_str::<Value>(&content)
                .map_err(|e| format!("解析 Claude settings.json 失败: {}", e))?
        }
    } else {
        Value::Object(Map::new())
    };
    if !settings.is_object() {
        settings = Value::Object(Map::new());
    }
    let root = settings.as_object_mut().expect("settings object");
    let env_value = root
        .entry("env".to_string())
        .or_insert_with(|| Value::Object(Map::new()));
    if !env_value.is_object() {
        *env_value = Value::Object(Map::new());
    }
    let env = env_value.as_object_mut().expect("env object");
    env.insert("ANTHROPIC_AUTH_TOKEN".to_string(), Value::String(auth_token));
    if let Some(base_url) = normalize_non_empty(account.base_url.as_deref()) {
        env.insert("ANTHROPIC_BASE_URL".to_string(), Value::String(base_url));
    } else {
        env.remove("ANTHROPIC_BASE_URL");
    }
    if let Some(timeout) = normalize_non_empty(account.api_timeout_ms.as_deref()) {
        env.insert("API_TIMEOUT_MS".to_string(), Value::String(timeout));
    }
    if let Some(model) = normalize_non_empty(account.model.as_deref()) {
        root.insert("model".to_string(), Value::String(model));
    }
    let content = serde_json::to_string_pretty(&settings)
        .map_err(|e| format!("序列化 Claude settings.json 失败: {}", e))?;
    crate::modules::atomic_write::write_string_atomic(&path, &content)
        .map_err(|e| format!("写入 Claude settings.json 失败: {}", e))?;
    account.last_used = now_ts();
    let account = upsert_account_record(account)?;
    crate::modules::provider_current_state::set_current_account_id("claude", Some(&account.id))?;
    Ok(account)
}
