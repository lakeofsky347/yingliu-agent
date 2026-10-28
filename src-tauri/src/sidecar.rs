use std::io::{BufRead, BufReader, Read, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

#[derive(Debug, serde::Deserialize)]
#[serde(tag = "type")]
enum Handshake {
    #[serde(rename = "ready")]
    Ready {
        #[serde(rename = "protocolVersion")]
        protocol_version: u32,
        origin: String,
        #[serde(rename = "profileId")]
        profile_id: String,
    },
    #[serde(rename = "error")]
    Error {
        code: String,
        #[allow(dead_code)]
        message: String,
    },
}
#[derive(Debug)]
pub struct Ready {
    pub origin: String,
    pub profile_id: String,
}

/// Ownership begins at spawn, before any fallible pipe/handshake/UI setup.
/// Dropping a failed setup always kills and reaps this exact child handle.
pub struct SidecarProcess {
    child: Option<Child>,
    stdin: Option<ChildStdin>,
}
impl Drop for SidecarProcess {
    fn drop(&mut self) {
        self.stdin.take();
        if let Some(mut child) = self.child.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}
impl SidecarProcess {
    pub fn spawn(command: &mut Command, timeout: Duration) -> Result<(Self, Ready), String> {
        let child = command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .map_err(|e| format!("无法启动 sidecar: {e}"))?;
        let mut owned = Self {
            child: Some(child),
            stdin: None,
        };
        let child = owned.child.as_mut().unwrap();
        owned.stdin = Some(child.stdin.take().ok_or("sidecar 缺少 stdin")?);
        let stdout = child.stdout.take().ok_or("sidecar 缺少 stdout")?;
        let (sender, receiver) = mpsc::sync_channel::<Result<String, String>>(1);
        std::thread::Builder::new()
            .name("sidecar-handshake".into())
            .spawn(move || {
                let mut reader = BufReader::new(stdout);
                let mut bytes = Vec::new();
                // An unterminated/oversized first line cannot consume unbounded memory.
                let read = reader
                    .by_ref()
                    .take(16 * 1024 + 1)
                    .read_until(b'\n', &mut bytes);
                let line = match read {
                    Ok(0) => Err("sidecar 在握手前关闭 stdout".into()),
                    Ok(_) if bytes.len() > 16 * 1024 || !bytes.ends_with(b"\n") => {
                        Err("sidecar 握手超长或未换行".into())
                    }
                    Ok(_) => String::from_utf8(bytes).map_err(|_| "sidecar 握手不是 UTF-8".into()),
                    Err(_) => Err("sidecar 握手读取失败".into()),
                };
                let _ = sender.send(line);
                let _ = std::io::copy(&mut reader, &mut std::io::sink());
            })
            .map_err(|_| "无法创建 sidecar 握手线程".to_string())?;
        let line: String = receiver
            .recv_timeout(timeout)
            .map_err(|_| "sidecar 握手超时".to_string())??;
        // Never include the raw ready line or error message: it may carry tokens.
        let handshake: Handshake =
            serde_json::from_str(&line).map_err(|_| "sidecar 首行不是有效的 ready/error JSON")?;
        let ready = match handshake {
            Handshake::Error { code, .. } => {
                return Err(format!(
                    "sidecar 启动失败：{}",
                    code.chars()
                        .filter(|c| c.is_ascii_alphanumeric() || *c == '_')
                        .take(64)
                        .collect::<String>()
                ))
            }
            Handshake::Ready {
                protocol_version,
                origin,
                profile_id,
            } => {
                if protocol_version != 1 {
                    return Err("sidecar 协议版本不兼容".into());
                }
                let parsed = url::Url::parse(&origin).map_err(|_| "sidecar origin 无效")?;
                if parsed.scheme() != "http"
                    || parsed.host_str() != Some("127.0.0.1")
                    || parsed.port().unwrap_or(0) == 0
                    || !parsed.username().is_empty()
                    || parsed.password().is_some()
                    || parsed.query().is_some()
                    || parsed.fragment().is_some()
                    || parsed.path() != "/"
                {
                    return Err("sidecar origin 必须是精确本机 HTTP origin".into());
                }
                Ready {
                    origin: parsed.origin().ascii_serialization(),
                    profile_id,
                }
            }
        };
        Ok((owned, ready))
    }
    pub fn shutdown(&mut self, timeout: Duration) {
        if let Some(mut stdin) = self.stdin.take() {
            let _ = stdin.write_all(b"{\"type\":\"shutdown\"}\n");
        }
        let until = Instant::now() + timeout;
        if let Some(child) = self.child.as_mut() {
            while Instant::now() < until {
                if matches!(child.try_wait(), Ok(Some(_))) {
                    self.child.take();
                    return;
                }
                std::thread::sleep(Duration::from_millis(20));
            }
        }
        // Drop performs kill + wait after the graceful deadline.
        if let Some(mut child) = self.child.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    fn fixture(script: &str, timeout: Duration) -> Result<(SidecarProcess, Ready), String> {
        SidecarProcess::spawn(Command::new("sh").args(["-c", script]), timeout)
    }
    #[test]
    fn silent_child_has_bounded_deadline() {
        let start = Instant::now();
        assert!(fixture("exec sleep 60", Duration::from_millis(40)).is_err());
        assert!(start.elapsed() < Duration::from_secs(2));
    }
    #[test]
    fn eof_oversized_utf8_and_unterminated_handshakes_fail_closed() {
        for script in [
            "exit 0",
            "printf '\\377\\n'; exec sleep 60",
            "i=0; while [ $i -lt 17000 ]; do printf x; i=$((i+1)); done; printf '\\n'; exec sleep 60",
            "printf '{\"type\":\"ready\"}'; exec sleep 60",
        ] {
            let start = Instant::now();
            assert!(fixture(script, Duration::from_millis(150)).is_err());
            assert!(start.elapsed() < Duration::from_secs(2));
        }
    }
    #[test]
    fn every_bad_handshake_is_rejected_and_reaped() {
        for line in ["not json", "{\"type\":\"error\",\"code\":\"BUSY\",\"message\":\"secret must not be logged\"}", "{\"type\":\"ready\",\"protocolVersion\":9,\"origin\":\"http://127.0.0.1:19440\",\"profileId\":\"test\"}", "{\"type\":\"ready\",\"protocolVersion\":1,\"origin\":\"https://outside.invalid\",\"profileId\":\"test\"}"] {
            let script = format!("printf '%s\\n' '{}'; exec sleep 60", line); let error = match fixture(&script, Duration::from_secs(1)) { Ok(_) => panic!("bad handshake accepted"), Err(error) => error }; assert!(!error.contains("secret must"));
        }
    }
    #[test]
    fn valid_ready_is_owned_and_drop_reaps_even_after_setup_failure() {
        let (process, ready) = fixture("printf '%s\\n' '{\"type\":\"ready\",\"protocolVersion\":1,\"origin\":\"http://127.0.0.1:19440\",\"profileId\":\"test\"}'; exec sleep 60", Duration::from_secs(1)).unwrap();
        let pid = process.child.as_ref().unwrap().id();
        assert_eq!(ready.origin, "http://127.0.0.1:19440");
        drop(process);
        assert!(!Command::new("kill")
            .args(["-0", &pid.to_string()])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .unwrap()
            .success());
    }
}
