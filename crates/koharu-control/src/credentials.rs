//! Where the translation agent's website credentials live.
//!
//! Here rather than in `koharu-app` so the control surface and the Tauri
//! command agree on the key names by construction: a supervisor that pins a
//! token over HTTP and a panel that reads one over IPC must address the same
//! entry, and two copies of this naming would eventually drift.

use anyhow::Result;
use koharu_secrets::{ExposeSecret as _, SecretString};

/// Distinguishes the credentials of two instances sharing one machine account.
///
/// The farm runs the agent under its own registration while a person may be
/// signed in to the same site in an interactive instance; one token must not
/// overwrite the other.
pub const INSTANCE_VARIABLE: &str = "KOHARU_INSTANCE_ID";

/// Matches the 0.59.2 agent's fallback, so an existing website-side
/// registration keeps working after the port.
const DEFAULT_AGENT_ID: &str = "koharu-default";

const TOKEN_KEY: &str = "agent-token";
const AGENT_ID_KEY: &str = "agent-id";

/// The instance name the supervisor set, if any.
#[must_use]
pub fn instance() -> Option<String> {
    std::env::var(INSTANCE_VARIABLE)
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
}

fn namespaced(key: &str) -> String {
    match instance() {
        Some(instance) => format!("{key}.{instance}"),
        None => key.to_owned(),
    }
}

/// What the agent presents to the website: a token it authenticates with and
/// an id the website attributes the claim to.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Credentials {
    pub token: Option<String>,
    pub agent_id: String,
}

pub fn read() -> Result<Credentials> {
    let token = koharu_secrets::get(&namespaced(TOKEN_KEY))?
        .map(|secret| secret.expose_secret().to_owned())
        .filter(|value| !value.is_empty());
    // The stored value wins, then the instance name the supervisor already
    // sets, so a second farm machine identifies itself without extra setup.
    let agent_id = koharu_secrets::get(&namespaced(AGENT_ID_KEY))?
        .map(|secret| secret.expose_secret().to_owned())
        .filter(|value| !value.is_empty())
        .or_else(instance)
        .unwrap_or_else(|| DEFAULT_AGENT_ID.to_owned());
    Ok(Credentials { token, agent_id })
}

/// Store what is given. `None` leaves a field alone; an empty string clears
/// it, so a caller can change the id without restating the token.
pub fn write(token: Option<&str>, agent_id: Option<&str>) -> Result<Credentials> {
    for (key, value) in [(TOKEN_KEY, token), (AGENT_ID_KEY, agent_id)] {
        let Some(value) = value else { continue };
        let value = value.trim();
        if value.is_empty() {
            koharu_secrets::delete(&namespaced(key))?;
        } else {
            koharu_secrets::set(&namespaced(key), &SecretString::from(value))?;
        }
    }
    read()
}

pub fn clear() -> Result<()> {
    koharu_secrets::delete(&namespaced(TOKEN_KEY))?;
    koharu_secrets::delete(&namespaced(AGENT_ID_KEY))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Two instances on one machine must not share a credential, and a second
    /// farm machine should take its id from the instance name the supervisor
    /// already sets rather than needing one typed in.
    ///
    /// One test, not two: the instance name is a process-wide environment
    /// variable, so parallel tests would overwrite each other's setup.
    #[test]
    fn the_instance_name_namespaces_credentials_and_names_the_agent() {
        // SAFETY: the variable is only read elsewhere, never held across this.
        unsafe { std::env::set_var(INSTANCE_VARIABLE, "server") };
        assert_eq!(namespaced(TOKEN_KEY), "agent-token.server");
        assert_eq!(namespaced(AGENT_ID_KEY), "agent-id.server");
        assert_eq!(instance().as_deref(), Some("server"));

        unsafe { std::env::set_var(INSTANCE_VARIABLE, "  ") };
        assert_eq!(namespaced(TOKEN_KEY), "agent-token");
        assert_eq!(instance(), None);

        unsafe { std::env::remove_var(INSTANCE_VARIABLE) };
        assert_eq!(namespaced(TOKEN_KEY), "agent-token");
        assert_eq!(instance(), None);
    }
}
