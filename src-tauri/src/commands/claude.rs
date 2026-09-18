use tauri::{AppHandle, Emitter};

use crate::models::claude::ClaudeAccount;
use crate::modules::{claude_account, logger};

#[tauri::command]
pub fn list_claude_accounts() -> Result<Vec<ClaudeAccount>, String> {
    claude_account::list_accounts_checked()
}

#[tauri::command]
pub fn delete_claude_account(account_id: String) -> Result<(), String> {
    claude_account::remove_account(&account_id)
}

#[tauri::command]
pub fn delete_claude_accounts(account_ids: Vec<String>) -> Result<(), String> {
    claude_account::remove_accounts(&account_ids)
}

#[tauri::command]
pub fn import_claude_from_json(json_content: String) -> Result<Vec<ClaudeAccount>, String> {
    claude_account::import_from_json(&json_content)
}

#[tauri::command]
pub fn import_claude_from_local(app: AppHandle) -> Result<Vec<ClaudeAccount>, String> {
    match claude_account::import_from_local()? {
        Some(account) => {
            let _ = crate::modules::tray::update_tray_menu(&app);
            Ok(vec![account])
        }
        None => Err("未找到本地 Claude Code 登录信息".to_string()),
    }
}

#[tauri::command]
pub fn add_claude_account_with_token(
    auth_token: String,
    base_url: Option<String>,
    label: Option<String>,
    model: Option<String>,
) -> Result<ClaudeAccount, String> {
    claude_account::add_account_with_token(&auth_token, base_url, label, model)
}

#[tauri::command]
pub fn export_claude_accounts(account_ids: Vec<String>) -> Result<String, String> {
    claude_account::export_accounts(&account_ids)
}

#[tauri::command]
pub fn refresh_claude_token(account_id: String) -> Result<ClaudeAccount, String> {
    claude_account::refresh_account(&account_id)
}

#[tauri::command]
pub fn refresh_all_claude_tokens() -> Result<i32, String> {
    claude_account::refresh_all_accounts()
}

#[tauri::command]
pub fn update_claude_account_tags(
    account_id: String,
    tags: Vec<String>,
) -> Result<ClaudeAccount, String> {
    claude_account::update_account_tags(&account_id, tags)
}

#[tauri::command]
pub fn get_claude_accounts_index_path() -> Result<String, String> {
    claude_account::accounts_index_path_string()
}

#[tauri::command]
pub fn inject_claude_account(app: AppHandle, account_id: String) -> Result<String, String> {
    logger::log_info(&format!(
        "[Claude Switch] 开始切换账号: account_id={}",
        account_id
    ));
    let account = claude_account::inject_account(&account_id)?;
    let _ = crate::modules::tray::update_tray_menu(&app);
    let _ = app.emit(
        "provider:current-account-changed",
        serde_json::json!({ "platformId": "claude", "accountId": account.id }),
    );
    Ok(format!("已切换 Claude 账号: {}", account.email))
}
