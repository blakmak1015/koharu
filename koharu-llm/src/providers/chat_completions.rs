use std::sync::Arc;

use reqwest_middleware::ClientWithMiddleware;
use serde::Serialize;

use super::ensure_provider_success;

pub enum ChatCompletionsAuth {
    None,
    Bearer(String),
}

pub struct ChatCompletionsRequest {
    pub provider: &'static str,
    pub endpoint: String,
    pub auth: ChatCompletionsAuth,
    pub model: String,
    pub system_prompt: String,
    pub user_prompt: String,
    pub temperature: Option<f64>,
    pub max_tokens: Option<u32>,
    /// Extra Jinja chat-template arguments forwarded verbatim to the server
    /// (e.g. `{"enable_thinking": false}`). Only meaningful for local
    /// OpenAI-compatible servers like llama.cpp/vLLM; left `None` for the
    /// hosted OpenAI/DeepSeek APIs, which reject unknown fields.
    pub chat_template_kwargs: Option<serde_json::Value>,
}

#[derive(Serialize)]
struct ChatMessage {
    role: &'static str,
    content: String,
}

#[derive(Serialize)]
struct ChatRequest<'a> {
    model: &'a str,
    messages: Vec<ChatMessage>,
    #[serde(skip_serializing_if = "Option::is_none")]
    temperature: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    max_tokens: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    chat_template_kwargs: Option<serde_json::Value>,
}

pub async fn send_chat_completion(
    http_client: Arc<ClientWithMiddleware>,
    request: ChatCompletionsRequest,
) -> anyhow::Result<String> {
    let body = ChatRequest {
        model: &request.model,
        messages: vec![
            ChatMessage {
                role: "system",
                content: request.system_prompt,
            },
            ChatMessage {
                role: "user",
                content: request.user_prompt,
            },
        ],
        temperature: request.temperature,
        max_tokens: request.max_tokens,
        chat_template_kwargs: request.chat_template_kwargs,
    };

    let mut http_request = http_client.post(&request.endpoint);
    if let ChatCompletionsAuth::Bearer(api_key) = request.auth {
        http_request = http_request.bearer_auth(api_key);
    }

    let response = http_request
        .header("content-type", "application/json")
        .body(serde_json::to_vec(&body)?)
        .send()
        .await?;

    let resp: serde_json::Value = ensure_provider_success(request.provider, response)
        .await?
        .json()
        .await?;

    resp["choices"][0]["message"]["content"]
        .as_str()
        .map(ToOwned::to_owned)
        .ok_or_else(|| anyhow::anyhow!("{} returned no content", request.provider))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn serialize(chat_template_kwargs: Option<serde_json::Value>) -> serde_json::Value {
        let body = ChatRequest {
            model: "m",
            messages: vec![ChatMessage {
                role: "user",
                content: "hi".to_string(),
            }],
            temperature: None,
            max_tokens: None,
            chat_template_kwargs,
        };
        serde_json::to_value(&body).unwrap()
    }

    #[test]
    fn chat_template_kwargs_is_serialized_when_present() {
        let value = serialize(Some(serde_json::json!({ "enable_thinking": false })));
        assert_eq!(value["chat_template_kwargs"]["enable_thinking"], false);
    }

    #[test]
    fn chat_template_kwargs_is_omitted_when_none() {
        let value = serialize(None);
        assert!(value.get("chat_template_kwargs").is_none());
    }
}
