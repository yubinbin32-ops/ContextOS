use std::path::{Path, PathBuf};
use std::fs;
use std::process::Command;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

fn find_repo_root(custom_path: Option<&str>) -> PathBuf {
    if let Some(p) = custom_path {
        let pb = PathBuf::from(p);
        if pb.exists() {
            return pb;
        }
    }
    let mut current = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    loop {
        if current.join(".contextos").exists() {
            return current;
        }
        if let Some(parent) = current.parent() {
            current = parent.to_path_buf();
        } else {
            break;
        }
    }
    std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
}

#[tauri::command]
fn get_project_root() -> String {
    find_repo_root(None).to_string_lossy().to_string()
}

fn config_map(value: Option<&Value>) -> Map<String, Value> {
    match value {
        Some(Value::Object(map)) => map.clone(),
        Some(Value::String(command)) if !command.trim().is_empty() => {
            Map::from_iter([("command".to_string(), Value::String(command.trim().to_string()))])
        }
        _ => Map::new(),
    }
}

fn nonempty_config_string(value: Option<&Value>) -> Option<String> {
    value.and_then(Value::as_str).map(str::trim).filter(|value| !value.is_empty()).map(str::to_string)
}

fn summarize_adapter(value: &Value) -> Value {
    let config = config_map(Some(value));
    let command = config.get("command").and_then(|value| match value {
        Value::String(command) => command.split_whitespace().next().map(str::to_string),
        Value::Array(args) => args.first().and_then(Value::as_str).map(str::to_string),
        _ => None,
    }).map(|value| value.rsplit(|character| character == '/' || character == '\\').next().unwrap_or(&value).to_string());
    json!({
        "configured": !config.is_empty(),
        "command": command,
        "installed": Value::Null,
        "authenticated": Value::Null,
        "model": Value::Null,
        "thinking": Value::Null,
        "taskReady": { "analyze": Value::Null, "implement": Value::Null }
    })
}

fn read_optional_profile(path: &Path) -> Result<Option<Value>, String> {
    if !path.exists() { return Ok(None); }
    let value: Value = serde_json::from_str(&fs::read_to_string(path).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    if !value.is_object() { return Err(format!("Invalid profile JSON at {}", path.display())); }
    Ok(Some(value))
}

fn merged_object(base: Option<&Value>, override_value: Option<&Value>) -> Value {
    let Some(override_value) = override_value else { return base.cloned().unwrap_or(Value::Null); };
    if override_value.is_null() { return Value::Null; }
    let Some(override_map) = override_value.as_object() else { return override_value.clone(); };
    let mut merged = base.and_then(Value::as_object).cloned().unwrap_or_default();
    merged.extend(override_map.iter().map(|(key, value)| (key.clone(), value.clone())));
    Value::Object(merged)
}

fn merged_agents(base: Option<&Value>, override_value: Option<&Value>) -> Value {
    let mut merged = merged_object(base, override_value);
    let Some(override_map) = override_value.and_then(Value::as_object) else { return merged; };
    if let Some(adapters) = override_map.get("adapters") {
        let merged_adapters = merged_object(base.and_then(|value| value.get("adapters")), Some(adapters));
        if let Some(object) = merged.as_object_mut() { object.insert("adapters".to_string(), merged_adapters); }
    }
    merged
}

fn effective_profile(global: Option<&Value>, project: Option<&Value>) -> Value {
    let mut merged = global.and_then(Value::as_object).cloned().unwrap_or_default();
    if let Some(project_map) = project.and_then(Value::as_object) {
        merged.extend(project_map.iter().filter(|(key, _)| !["micro", "agents"].contains(&key.as_str()))
            .map(|(key, value)| (key.clone(), value.clone())));
        for key in ["micro", "agents"] {
            if let Some(override_value) = project_map.get(key) {
                let base_value = global.and_then(|value| value.get(key));
                let value = match key {
                    "agents" => merged_agents(base_value, Some(override_value)),
                    _ => merged_object(base_value, Some(override_value)),
                };
                merged.insert(key.to_string(), value);
            }
        }
    }
    Value::Object(merged)
}

fn has_micro_role_config(profile: Option<&Value>) -> bool {
    let Some(profile) = profile else { return false; };
    let micro = profile.get("micro").and_then(Value::as_object);
    micro.map(|config| !config.is_empty()).unwrap_or(false)
        || profile.get("agents").and_then(Value::as_object).map(|value| !value.is_empty()).unwrap_or(false)
}

#[tauri::command]
fn get_micro_roles(project_root: String) -> Result<Value, String> {
    let root = PathBuf::from(project_root).canonicalize().map_err(|e| e.to_string())?;
    let project_file = root.join(".contextos/profile.json");
    let global_home = std::env::var("CONTEXTOS_HOME").ok().filter(|value| !value.trim().is_empty()).map(PathBuf::from)
        .or_else(|| std::env::var("USERPROFILE").ok().or_else(|| std::env::var("HOME").ok()).map(|home| PathBuf::from(home).join(".contextos")));
    let global_file = global_home.map(|home| home.join("profile.json"));
    let global_profile = match global_file.as_deref() { Some(file) => read_optional_profile(file)?, None => None };
    let project_profile = read_optional_profile(&project_file)?;
    let global_has_roles = has_micro_role_config(global_profile.as_ref());
    let project_has_roles = has_micro_role_config(project_profile.as_ref());
    let configuration_source = match (global_has_roles, project_has_roles) {
        (true, true) => "global + project",
        (true, false) => "global",
        (false, true) => "project",
        (false, false) => "none",
    };
    let profile = effective_profile(global_profile.as_ref(), project_profile.as_ref());

    let api = profile.get("micro").and_then(Value::as_object).cloned().unwrap_or_default();

    let endpoint = nonempty_config_string(api.get("baseUrl")).or_else(|| nonempty_config_string(api.get("url")));
    let model = nonempty_config_string(api.get("model"));
    let key_configured = ["apiKey", "key", "keyEnv"].iter().any(|key| nonempty_config_string(api.get(*key)).is_some());
    let endpoint_configured = endpoint.is_some();
    let configured = endpoint_configured || model.is_some() || key_configured;
    let status = if endpoint_configured && model.is_some() { "configured" } else if configured { "partial" } else { "unconfigured" };
    let provider = nonempty_config_string(api.get("provider")).or_else(|| nonempty_config_string(api.get("vendor"))).or_else(|| {
        model.as_deref().filter(|value| value.to_lowercase().starts_with("deepseek-")).map(|_| "deepseek".to_string())
    });
    let requested_transport = nonempty_config_string(api.get("transport")).or_else(|| nonempty_config_string(api.get("protocol")))
        .or_else(|| endpoint.as_deref().filter(|value| value.to_lowercase().ends_with("/responses")).map(|_| "responses".to_string()))
        .or(Some("chat".to_string()));
    let transport = Some(if requested_transport.as_deref().map(|value| matches!(value.to_lowercase().as_str(), "responses" | "response")).unwrap_or(false) { "responses" } else { "chat" }.to_string());
    let requested_thinking = api.get("thinking").or_else(|| api.get("effort")).and_then(|value| {
        value.as_str().map(str::to_string).or_else(|| value.get("effort").or_else(|| value.get("level")).or_else(|| value.get("mode")).and_then(Value::as_str).map(str::to_string))
    });
    let deepseek = provider.as_deref().map(|value| value.eq_ignore_ascii_case("deepseek")).unwrap_or(false)
        || model.as_deref().map(|value| value.to_lowercase().starts_with("deepseek-")).unwrap_or(false);
    let effort_levels: Vec<&str> = if deepseek {
        vec!["off", "none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]
    } else {
        api.get("thinkingMap").and_then(|value| value.get(transport.as_deref().unwrap_or("chat"))).and_then(Value::as_object)
            .map(|mapping| mapping.iter().filter(|(_, value)| !value.is_null() && value.as_bool() != Some(false)).map(|(key, _)| key.as_str()).collect())
            .unwrap_or_default()
    };
    let mapped_thinking = requested_thinking.as_deref().and_then(|effort| {
        if deepseek {
            match effort.to_lowercase().as_str() {
                "off" | "none" => Some("none".to_string()),
                "minimal" | "low" => Some("low".to_string()),
                "medium" | "high" | "xhigh" => Some("high".to_string()),
                "max" | "ultra" => Some("max".to_string()),
                _ => None,
            }
        } else {
            api.get("thinkingMap").and_then(|value| value.get(transport.as_deref().unwrap_or("chat")))
                .and_then(|value| value.get(effort)).and_then(Value::as_str).map(str::to_string)
        }
    });

    let agents = profile.get("agents").and_then(Value::as_object);
    let adapters = agents.and_then(|value| value.get("adapters")).and_then(Value::as_object).cloned().unwrap_or_default();
    let default = agents.and_then(|value| value.get("default")).filter(|value| value.as_str().is_some()).cloned().unwrap_or(Value::Null);
    let adapter_summaries: Map<String, Value> = adapters.iter().map(|(name, value)| (name.clone(), summarize_adapter(value))).collect();
    Ok(json!({
        "micro": {
            "status": status,
            "configurationSource": configuration_source,
            "endpointConfigured": endpoint_configured,
            "credentialConfigured": key_configured,
            "provider": provider,
            "transport": transport,
            "model": model,
            "requestedThinking": requested_thinking,
            "effectiveThinking": mapped_thinking,
            "supportedThinking": effort_levels,
            "authentication": Value::Null,
            "taskReady": { "analyze": Value::Null, "implement": Value::Null }
        },
        "agents": {
            "default": default,
            "adapters": adapter_summaries
        }
    }))
}

#[tauri::command]
fn choose_project() -> Result<Option<String>, String> {
    let folder = rfd::FileDialog::new()
        .set_title("Select ContextOS Project Directory")
        .pick_folder();
    Ok(folder.map(|p| p.to_string_lossy().to_string()))
}

#[tauri::command]
fn load_snapshot(path: Option<String>) -> Result<Value, String> {
    let root = find_repo_root(path.as_deref());
    let graph_path = root.join(".contextos").join("graph.json");
    if !graph_path.exists() {
        return Err(format!("graph.json not found at {:?}", graph_path));
    }
    let data = fs::read_to_string(&graph_path).map_err(|e| e.to_string())?;
    let val: Value = serde_json::from_str(&data).map_err(|e| e.to_string())?;
    Ok(val)
}

#[tauri::command]
fn reveal_source(path: String, project_root: Option<String>) -> Result<(), String> {
    let root = find_repo_root(project_root.as_deref());
    let target = root.join(path);
    if target.exists() {
        open::that(target).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[derive(Serialize, Deserialize)]
struct NodeEnvironmentInfo {
    #[serde(rename = "isQualified")]
    is_qualified: bool,
    version: String,
    #[serde(rename = "executablePath")]
    executable_path: String,
    message: String,
}

#[tauri::command]
fn check_node_environment() -> Result<NodeEnvironmentInfo, String> {
    let output = Command::new("node")
        .arg("--version")
        .output();

    match output {
        Ok(out) if out.status.success() => {
            let ver_raw = String::from_utf8_lossy(&out.stdout).trim().to_string();
            let clean = ver_raw.trim_start_matches('v');
            let major: u32 = clean.split('.').next().and_then(|s| s.parse().ok()).unwrap_or(0);
            let is_qualified = major >= 22;
            let msg = if is_qualified {
                format!("Node {} 合格 (推荐轻量版)", ver_raw)
            } else {
                format!("Node {} 版本过低，需 Node 22+ (建议使用完整版)", ver_raw)
            };
            Ok(NodeEnvironmentInfo {
                is_qualified,
                version: ver_raw,
                executable_path: "node".into(),
                message: msg,
            })
        }
        _ => {
            Ok(NodeEnvironmentInfo {
                is_qualified: false,
                version: "not_found".into(),
                executable_path: "".into(),
                message: "未检测到系统 Node.js 环境，建议使用内置运行时的完整版".into(),
            })
        }
    }
}

fn get_user_home() -> PathBuf {
    #[cfg(target_os = "windows")]
    {
        if let Ok(profile) = std::env::var("USERPROFILE") {
            return PathBuf::from(profile);
        }
    }
    if let Ok(home) = std::env::var("HOME") {
        return PathBuf::from(home);
    }
    PathBuf::from(".")
}

fn get_appdata_dir() -> PathBuf {
    #[cfg(target_os = "windows")]
    {
        if let Ok(appdata) = std::env::var("APPDATA") {
            return PathBuf::from(appdata);
        }
    }
    get_user_home()
}

#[derive(Serialize, Deserialize)]
struct EditorPlatformInfo {
    id: String,
    name: String,
    #[serde(rename = "iconSystemName")]
    icon_system_name: String,
    #[serde(rename = "isAppInstalled")]
    is_app_installed: bool,
    #[serde(rename = "isSynced")]
    is_synced: bool,
    #[serde(rename = "installedVersion")]
    installed_version: Option<String>,
    #[serde(rename = "targetVersion")]
    target_version: String,
    #[serde(rename = "isOutdated")]
    is_outdated: bool,
    #[serde(rename = "configPath")]
    config_path: String,
    #[serde(rename = "appVersion")]
    app_version: String,
    #[serde(rename = "installedBuild")]
    installed_build: Option<String>,
    #[serde(rename = "targetBuild")]
    target_build: String,
}

fn get_platform_paths() -> Vec<(&'static str, &'static str, &'static str, PathBuf, PathBuf)> {
    let home = get_user_home();
    let appdata = get_appdata_dir();

    vec![
        (
            "claude",
            "Claude Desktop",
            "bubble.left.and.text.bubble.right.fill",
            appdata.join("Claude"),
            #[cfg(target_os = "windows")]
            appdata.join("Claude").join("claude_desktop_config.json"),
            #[cfg(not(target_os = "windows"))]
            home.join("Library").join("Application Support").join("Claude").join("claude_desktop_config.json"),
        ),
        (
            "cursor",
            "Cursor",
            "chevron.left.forwardslash.chevron.right",
            home.join(".cursor"),
            home.join(".cursor").join("mcp.json"),
        ),
        (
            "antigravity",
            "Antigravity",
            "sparkles",
            home.join(".gemini"),
            home.join(".gemini").join("config").join("mcp_config.json"),
        ),
        (
            "opencode",
            "OpenCode",
            "curlybraces",
            #[cfg(target_os = "windows")]
            appdata.join("opencode"),
            #[cfg(not(target_os = "windows"))]
            home.join(".config").join("opencode"),
            #[cfg(target_os = "windows")]
            appdata.join("opencode").join("mcp.json"),
            #[cfg(not(target_os = "windows"))]
            home.join(".config").join("opencode").join("mcp.json"),
        ),
        (
            "codex",
            "Codex",
            "command",
            home.join(".codex"),
            home.join(".codex").join("config.toml"),
        ),
    ]
}

#[tauri::command]
fn detect_installed_editors() -> Result<Vec<EditorPlatformInfo>, String> {
    let target_version = env!("CONTEXTOS_VERSION").to_string();
    let target_build = format!("build-{}", env!("CONTEXTOS_VERSION"));
    let mut results = Vec::new();

    for (id, name, icon, app_dir, cfg_file) in get_platform_paths() {
        let is_app_installed = app_dir.exists() || cfg_file.exists();
        let mut is_synced = false;
        let mut is_outdated = false;
        let mut installed_version = None;

        if cfg_file.exists() {
            if let Ok(content) = fs::read_to_string(&cfg_file) {
                if id == "codex" {
                    if content.contains("[mcp_servers.contextos]") || content.contains("[plugins.\"contextos") {
                        let mut found_ver = None;
                        for line in content.lines() {
                            let trimmed = line.trim();
                            if trimmed.starts_with("CONTEXTOS_VERSION") || trimmed.starts_with("version") {
                                if let Some((_, val)) = trimmed.split_once('=') {
                                    let clean = val.trim().trim_matches(|c| c == '"' || c == '\'');
                                    if !clean.is_empty() {
                                        found_ver = Some(clean.to_string());
                                        break;
                                    }
                                }
                            }
                        }
                        if let Some(v) = found_ver {
                            is_outdated = v != target_version;
                            is_synced = !is_outdated;
                            installed_version = Some(v);
                        } else {
                            is_outdated = true;
                            is_synced = false;
                            installed_version = Some("unknown".to_string());
                        }
                    }
                } else {
                    if let Ok(val) = serde_json::from_str::<Value>(&content) {
                        if let Some(mcp) = val.get("mcpServers").and_then(|m| m.get("contextos")) {
                            let ver = mcp.get("_version")
                                .or_else(|| mcp.get("version"))
                                .and_then(|v| v.as_str())
                                .or_else(|| {
                                    mcp.get("env")
                                        .and_then(|e| e.get("CONTEXTOS_VERSION"))
                                        .and_then(|v| v.as_str())
                                });
                            if let Some(v) = ver {
                                is_outdated = v != target_version;
                                is_synced = !is_outdated;
                                installed_version = Some(v.to_string());
                            } else {
                                is_outdated = true;
                                is_synced = false;
                                installed_version = Some("unknown".to_string());
                            }
                        }
                    } else if content.contains("contextos") {
                        is_outdated = true;
                        is_synced = false;
                        installed_version = Some("unknown".to_string());
                    }
                }
            }
        }

        results.push(EditorPlatformInfo {
            id: id.to_string(),
            name: name.to_string(),
            icon_system_name: icon.to_string(),
            is_app_installed,
            is_synced,
            installed_version: installed_version.clone(),
            target_version: target_version.clone(),
            is_outdated,
            config_path: cfg_file.to_string_lossy().to_string(),
            app_version: target_version.clone(),
            installed_build: installed_version.map(|v| format!("build-{}", v)),
            target_build: target_build.clone(),
        });
    }

    Ok(results)
}

#[tauri::command]
fn sync_editor_plugin(platform_id: String, project_root: Option<String>) -> Result<(), String> {
    let root = find_repo_root(project_root.as_deref());
    let dev_server_script = root.join("packages").join("mcp").join("src").join("v3-server.mjs");
    let home = get_user_home();
    let prod_server_script = home.join(".contextos").join("server").join("contextos-mcp.mjs");

    let server_script = if dev_server_script.exists() {
        dev_server_script
    } else if prod_server_script.exists() {
        prod_server_script
    } else {
        prod_server_script
    };

    let script_str = server_script.to_string_lossy().to_string();
    let root_str = root.to_string_lossy().to_string();
    let target_version = env!("CONTEXTOS_VERSION");
    let target_build = format!("build-{}", env!("CONTEXTOS_VERSION"));

    let platforms = get_platform_paths();
    let target = platforms.into_iter().find(|(id, ..)| *id == platform_id)
        .ok_or_else(|| format!("Unknown platform id: {}", platform_id))?;

    let (_, _, _, _app_dir, cfg_file) = target;
    if let Some(parent) = cfg_file.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }

    if platform_id == "codex" {
        // TOML configuration for Codex
        let mut content = fs::read_to_string(&cfg_file).unwrap_or_default();
        if !content.contains("[mcp_servers.contextos]") {
            content.push_str(&format!(
                "\n[mcp_servers.contextos]\ncommand = \"node\"\nargs = [\"{}\", \"--project-root\", \"{}\"]\n\n[mcp_servers.contextos.env]\nCONTEXTOS_VERSION = \"{}\"\nCONTEXTOS_BUILD = \"{}\"\n",
                script_str.replace('\\', "\\\\"),
                root_str.replace('\\', "\\\\"),
                target_version,
                target_build
            ));
            fs::write(&cfg_file, content).map_err(|e| e.to_string())?;
        }
    } else {
        // JSON configuration (claude, cursor, antigravity, opencode)
        let mut json_val: Value = if cfg_file.exists() {
            let s = fs::read_to_string(&cfg_file).unwrap_or_default();
            serde_json::from_str(&s).unwrap_or_else(|_| json!({}))
        } else {
            json!({})
        };

        if !json_val.is_object() {
            json_val = json!({});
        }

        let mcp_key = "mcpServers";

        if json_val.get(mcp_key).is_none() {
            json_val[mcp_key] = json!({});
        }

        json_val[mcp_key]["contextos"] = json!({
            "command": "node",
            "args": [script_str, "--project-root", root_str],
            "_version": target_version,
            "_build": target_build
        });

        let serialized = serde_json::to_string_pretty(&json_val).map_err(|e| e.to_string())?;
        fs::write(&cfg_file, serialized).map_err(|e| e.to_string())?;
    }

    Ok(())
}

#[tauri::command]
fn check_app_update(repo: Option<String>) -> Result<Value, String> {
    let r = repo.unwrap_or_else(|| "yubinbin32-ops/ContextOS".into());
    let clean_repo = r.trim().trim_start_matches("https://github.com/").trim_end_matches('/');
    let url = format!("https://api.github.com/repos/{}/releases/latest", clean_repo);

    let output = Command::new("curl")
        .args(["-s", "-H", "User-Agent: ContextOS-Desktop", "-H", "Accept: application/vnd.github+json", &url])
        .output();

    let stdout = match output {
        Ok(out) if out.status.success() => out.stdout,
        _ => {
            #[cfg(target_os = "windows")]
            {
                let ps_cmd = format!("(Invoke-WebRequest -Uri '{}' -UseBasicParsing -Headers @{{'User-Agent'='ContextOS-Desktop'; 'Accept'='application/vnd.github+json'}}).Content", url);
                let ps_out = Command::new("powershell")
                    .args(["-NoProfile", "-Command", &ps_cmd])
                    .output()
                    .map_err(|e| format!("Failed to query update via powershell: {}", e))?;
                if !ps_out.status.success() {
                    return Err("Failed to query update via curl and powershell".into());
                }
                ps_out.stdout
            }
            #[cfg(not(target_os = "windows"))]
            {
                return Err("Failed to query GitHub releases API via curl".into());
            }
        }
    };

    let body = String::from_utf8_lossy(&stdout);
    let val: Value = serde_json::from_str(&body).map_err(|e| format!("Failed to parse release info: {}", e))?;
    Ok(val)
}

#[tauri::command]
fn download_and_install_update(download_url: String, asset_name: String) -> Result<String, String> {
    if !download_url.starts_with("http") {
        return Err("Invalid update URL".into());
    }

    let filename = if !asset_name.trim().is_empty() {
        Path::new(&asset_name)
            .file_name()
            .and_then(|f| f.to_str())
            .unwrap_or("contextos-update.exe")
    } else {
        "contextos-update.exe"
    };

    let temp_file = std::env::temp_dir().join(filename);
    let temp_str = temp_file.to_string_lossy().to_string();

    let output = Command::new("curl")
        .args(["-fSL", "-H", "User-Agent: ContextOS-Desktop", &download_url, "-o", &temp_str])
        .output();

    let success = match output {
        Ok(out) if out.status.success() && temp_file.exists() && fs::metadata(&temp_file).map(|m| m.len()).unwrap_or(0) > 0 => true,
        _ => {
            #[cfg(target_os = "windows")]
            {
                let ps_cmd = format!("Invoke-WebRequest -Uri '{}' -OutFile '{}' -Headers @{{'User-Agent'='ContextOS-Desktop'}}", download_url, temp_str);
                let ps_out = Command::new("powershell")
                    .args(["-NoProfile", "-Command", &ps_cmd])
                    .output();
                match ps_out {
                    Ok(out) if out.status.success() && temp_file.exists() && fs::metadata(&temp_file).map(|m| m.len()).unwrap_or(0) > 0 => true,
                    _ => false,
                }
            }
            #[cfg(not(target_os = "windows"))]
            {
                false
            }
        }
    };

    if !success {
        return Err("Failed to download update package".into());
    }

    Ok(temp_str)
}

#[tauri::command]
fn execute_staged_installer(installer_path: Option<String>) -> Result<(), String> {
    let path = match installer_path {
        Some(ref p) if !p.trim().is_empty() => PathBuf::from(p.trim()),
        _ => std::env::temp_dir().join("contextos-update.exe"),
    };

    if !path.exists() {
        return Err(format!("Installer file not found at {:?}", path));
    }

    #[cfg(target_os = "windows")]
    {
        Command::new(&path)
            .spawn()
            .map_err(|e| format!("Failed to launch installer: {}", e))?;
    }
    #[cfg(not(target_os = "windows"))]
    {
        Command::new("open")
            .arg(&path)
            .spawn()
            .map_err(|e| format!("Failed to launch installer: {}", e))?;
    }

    Ok(())
}

#[tauri::command]
fn list_processes(project_root: Option<String>) -> Result<Value, String> {
    let root = find_repo_root(project_root.as_deref());
    let proc_path = root.join(".contextos").join("processes.json");
    if proc_path.exists() {
        let content = fs::read_to_string(&proc_path).map_err(|e| e.to_string())?;
        let val: Value = serde_json::from_str(&content).unwrap_or_else(|_| json!([]));
        return Ok(val);
    }
    Ok(json!([]))
}

#[tauri::command]
fn stop_process(id: String, project_root: Option<String>) -> Result<(), String> {
    let root = find_repo_root(project_root.as_deref());
    let proc_path = root.join(".contextos").join("processes.json");
    if proc_path.exists() {
        if let Ok(content) = fs::read_to_string(&proc_path) {
            if let Ok(mut items) = serde_json::from_str::<Vec<Value>>(&content) {
                if let Some(proc) = items.iter().find(|p| p.get("id").and_then(|v| v.as_str()) == Some(&id)) {
                    if let Some(pid_val) = proc.get("pid") {
                        let pid_str = if let Some(n) = pid_val.as_i64() {
                            n.to_string()
                        } else if let Some(n) = pid_val.as_u64() {
                            n.to_string()
                        } else if let Some(s) = pid_val.as_str() {
                            s.to_string()
                        } else {
                            String::new()
                        };

                        if !pid_str.is_empty() {
                            #[cfg(target_os = "windows")]
                            {
                                let _ = Command::new("taskkill").args(["/PID", &pid_str, "/F"]).output();
                            }
                            #[cfg(not(target_os = "windows"))]
                            {
                                let _ = Command::new("kill").args(["-9", &pid_str]).output();
                            }
                        }
                    }
                }
                items.retain(|p| p.get("id").and_then(|v| v.as_str()) != Some(&id));
                let _ = fs::write(&proc_path, serde_json::to_string_pretty(&items).unwrap_or_default());
            }
        }
    }
    Ok(())
}

#[tauri::command]
fn load_knowledge(project_root: Option<String>) -> Result<Vec<Value>, String> {
    let root = find_repo_root(project_root.as_deref());
    let mut docs = Vec::new();
    let candidates = [
        ("readme", "README.md", "README"),
        ("architecture", "ARCHITECTURE.md", "Architecture Guide"),
        ("decision", "DECISION.md", "Architecture Decision Records"),
    ];
    for (kind, filename, title) in candidates {
        let path = root.join(filename);
        if path.exists() {
            if let Ok(body) = fs::read_to_string(&path) {
                docs.push(json!({
                    "id": format!("doc-{}", kind),
                    "kind": kind,
                    "title": title,
                    "path": filename,
                    "body": body,
                    "html": ""
                }));
            }
        }
    }
    Ok(docs)
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            get_project_root,
            get_micro_roles,
            choose_project,
            load_snapshot,
            reveal_source,
            check_node_environment,
            detect_installed_editors,
            sync_editor_plugin,
            check_app_update,
            download_and_install_update,
            execute_staged_installer,
            list_processes,
            stop_process,
            load_knowledge
        ])
        .run(tauri::generate_context!())
        .expect("error while running ContextOS desktop application");
}
