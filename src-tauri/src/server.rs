use std::{io::Write, path::Path, time::Duration};
use url::Url;

pub fn server_url(value: &str, allow_http: bool) -> Result<Url, String> {
    let url = Url::parse(value.trim()).map_err(|_| {
        "Enter a full server address, such as https://bakery.example.ts.net.".to_string()
    })?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
        return Err("Use an HTTP or HTTPS server address.".into());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("Do not include credentials in the server address.".into());
    }
    if url.path() != "/" || url.query().is_some() || url.fragment().is_some() {
        return Err("Enter only the server origin, without a path, query, or fragment.".into());
    }
    if url.host_str() == Some("tauri.localhost") {
        return Err("This hostname is reserved for the desktop connection screen.".into());
    }
    let loopback = matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"));
    if url.scheme() == "http" && !loopback && !allow_http {
        return Err("Use HTTPS, or explicitly allow HTTP on a trusted private network.".into());
    }
    Ok(url)
}

pub fn same_origin(server: &Url, target: &Url) -> bool {
    matches!(target.scheme(), "http" | "https") && target.origin() == server.origin()
}

pub fn connection_page(url: &Url) -> bool {
    matches!(
        url.as_str(),
        "tauri://localhost"
            | "tauri://localhost/"
            | "tauri://localhost/index.html"
            | "http://tauri.localhost/"
            | "http://tauri.localhost/index.html"
            | "https://tauri.localhost/"
            | "https://tauri.localhost/index.html"
    )
}

pub fn browser_url(url: &Url) -> bool {
    matches!(url.scheme(), "http" | "https")
        && url.username().is_empty()
        && url.password().is_none()
}

pub fn load(path: &Path) -> Result<String, String> {
    match std::fs::read_to_string(path) {
        Ok(value) => server_url(&value, true).map(|url| url.to_string()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(error) => Err(format!("Cannot read the saved server address: {error}")),
    }
}

pub fn save(path: &Path, url: &Url) -> Result<(), String> {
    let parent = path.parent().ok_or("No settings directory is available.")?;
    std::fs::create_dir_all(parent)
        .map_err(|error| format!("Cannot create the settings directory: {error}"))?;
    let mut file = tempfile::NamedTempFile::new_in(parent).map_err(|error| error.to_string())?;
    file.write_all(url.as_str().as_bytes())
        .map_err(|error| error.to_string())?;
    file.as_file()
        .sync_all()
        .map_err(|error| error.to_string())?;
    file.persist(path)
        .map_err(|error| format!("Cannot save the server address: {error}"))?;
    Ok(())
}

#[derive(serde::Deserialize)]
struct Status {
    #[serde(rename = "draining")]
    _draining: bool,
    #[serde(rename = "activeRuns")]
    _active_runs: u64,
}

pub async fn probe(url: &Url) -> Result<(), String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|error| error.to_string())?;
    let status = client.get(url.join("api/status").map_err(|error| error.to_string())?)
        .send().await.map_err(|error| format!("Cannot reach Bakery. Check the address, TLS certificate, and Tailnet connection. {error}"))?;
    if status.status() == reqwest::StatusCode::FORBIDDEN {
        return Err(
            "Bakery rejected this hostname. Add it to BAKERY_ALLOWED_HOSTS on the server.".into(),
        );
    }
    if !status.status().is_success() {
        return Err(format!("Bakery returned HTTP {}. Use a direct private server address; login redirects are not supported.", status.status()));
    }
    status
        .json::<Status>()
        .await
        .map_err(|_| "This address did not return Bakery's status API.".to_string())?;
    let page = client
        .get(url.clone())
        .send()
        .await
        .map_err(|error| format!("Cannot load the Bakery UI: {error}"))?;
    let html = page
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| {
            value
                .split(';')
                .next()
                .is_some_and(|mime| mime.trim().eq_ignore_ascii_case("text/html"))
        });
    if !page.status().is_success() || !html {
        return Err("The server is reachable but is not serving the Bakery UI. Build it and set BAKERY_SERVE_UI=1 on the server.".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{io::Read, net::TcpListener, thread};

    #[test]
    fn validates_and_normalizes_server_origins() {
        assert_eq!(
            server_url(" https://BAKERY.example:443 ", false)
                .unwrap()
                .as_str(),
            "https://bakery.example/"
        );
        assert!(server_url("http://127.0.0.1:4317", false).is_ok());
        assert!(server_url("http://bakery.example:4317", true).is_ok());
        for value in [
            "http://bakery.example",
            "file:///tmp/a",
            "javascript:alert(1)",
            "https://user:secret@bakery.example",
            "https://bakery.example/board/1",
            "https://bakery.example/?key=secret",
            "https://bakery.example/#board",
            "https://tauri.localhost",
            "bakery.example",
        ] {
            assert!(server_url(value, false).is_err(), "accepted {value}");
        }
    }

    #[test]
    fn remote_navigation_stays_on_the_exact_origin() {
        let origin = server_url("https://bakery.example:8443", false).unwrap();
        assert!(same_origin(
            &origin,
            &Url::parse("https://bakery.example:8443/board/1").unwrap()
        ));
        for target in [
            "http://bakery.example:8443/",
            "https://bakery.example/",
            "https://bakery.example.evil:8443/",
            "https://other.example:8443/",
            "file:///tmp/a",
            "tauri://localhost/",
        ] {
            assert!(
                !same_origin(&origin, &Url::parse(target).unwrap()),
                "allowed {target}"
            );
        }
        for target in [
            "file:///tmp/a",
            "javascript:alert(1)",
            "data:text/html,hello",
            "mailto:a@example.org",
            "https://user:secret@example.org/",
        ] {
            assert!(
                !browser_url(&Url::parse(target).unwrap()),
                "opened {target}"
            );
        }
        assert!(browser_url(
            &Url::parse("https://github.com/example/repo").unwrap()
        ));
    }

    #[test]
    fn connection_window_loads_bundled_pages_but_cannot_leave_them() {
        for address in [
            "tauri://localhost",
            "tauri://localhost/",
            "tauri://localhost/index.html",
            "http://tauri.localhost/",
            "https://tauri.localhost/index.html",
        ] {
            assert!(
                connection_page(&Url::parse(address).unwrap()),
                "blocked {address}"
            );
        }
        for address in [
            "https://example.org/",
            "https://tauri.localhost.evil/",
            "http://tauri.localhost:4317/",
            "tauri://localhost/remote.html",
            "file:///tmp/a",
        ] {
            assert!(
                !connection_page(&Url::parse(address).unwrap()),
                "allowed {address}"
            );
        }
    }

    #[test]
    fn settings_survive_restart_and_replacement_and_reject_corruption() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nested/server-url");
        assert_eq!(load(&path).unwrap(), "");
        save(&path, &server_url("https://first.example", false).unwrap()).unwrap();
        assert_eq!(load(&path).unwrap(), "https://first.example/");
        save(&path, &server_url("https://second.example", false).unwrap()).unwrap();
        assert_eq!(load(&path).unwrap(), "https://second.example/");
        std::fs::write(path, "file:///etc/passwd").unwrap();
        assert!(load(&dir.path().join("nested/server-url")).is_err());
    }

    // Exercise the real HTTP boundary; no request client or response parser is mocked.
    async fn check(
        responses: Vec<(&'static str, &'static str, &'static str)>,
    ) -> Result<(), String> {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = Url::parse(&format!("http://{}/", listener.local_addr().unwrap())).unwrap();
        let handle = thread::spawn(move || {
            for (index, (status, content_type, body)) in responses.into_iter().enumerate() {
                let (mut stream, _) = listener.accept().unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                let mut request = [0; 4096];
                let length = stream.read(&mut request).unwrap();
                let request = std::str::from_utf8(&request[..length]).unwrap();
                assert!(request.starts_with(if index == 0 {
                    "GET /api/status "
                } else {
                    "GET / "
                }));
                write!(stream, "HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
            }
        });
        let result = probe(&url).await;
        handle.join().unwrap();
        result
    }

    #[tokio::test]
    async fn probes_both_the_bakery_api_and_hosted_ui() {
        assert!(check(vec![
            (
                "200 OK",
                "application/json",
                r#"{"draining":false,"activeRuns":2}"#
            ),
            ("200 OK", "text/html; charset=utf-8", "<!doctype html>")
        ])
        .await
        .is_ok());
        assert!(check(vec![("403 Forbidden", "application/json", "{}")])
            .await
            .unwrap_err()
            .contains("BAKERY_ALLOWED_HOSTS"));
        assert!(check(vec![("302 Found", "text/html", "login")])
            .await
            .unwrap_err()
            .contains("login redirects"));
        assert!(check(vec![("200 OK", "application/json", "{}")])
            .await
            .unwrap_err()
            .contains("status API"));
        assert!(check(vec![
            (
                "200 OK",
                "application/json",
                r#"{"draining":false,"activeRuns":0}"#
            ),
            ("404 Not Found", "application/json", "{}")
        ])
        .await
        .unwrap_err()
        .contains("BAKERY_SERVE_UI"));
    }
}
