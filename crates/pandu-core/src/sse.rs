use serde::{Deserialize, Serialize};

/// A single Server-Sent Event parsed from the byte stream.
///
/// The parser only observes a copy of the response. The bytes forwarded to the
/// client are never reconstructed from these events.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SseEvent {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub event: Option<String>,
    pub data: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retry: Option<u64>,
    pub raw: String,
}

const MAX_BUFFER_CHARS: usize = 10_000_000;

/// Incremental SSE parser with the same field rules as the 0.1.0 daemon.
#[derive(Debug, Default)]
pub struct SseParser {
    buffer: String,
    pending: Vec<u8>,
    overflowed: bool,
}

impl SseParser {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn feed(&mut self, chunk: &[u8]) -> Vec<SseEvent> {
        if self.overflowed {
            return Vec::new();
        }
        self.pending.extend_from_slice(chunk);
        self.decode_pending();
        self.drain(false)
    }

    pub fn end(&mut self) -> Vec<SseEvent> {
        if self.overflowed {
            return Vec::new();
        }
        if !self.pending.is_empty() {
            let text = String::from_utf8_lossy(&self.pending);
            self.buffer.push_str(&text);
            self.pending.clear();
        }

        let mut events = self.drain(true);
        if !self.buffer.trim().is_empty() {
            if let Some(event) = parse_block(&self.buffer) {
                events.push(event);
            }
            self.buffer.clear();
        }
        events
    }

    pub fn overflowed(&self) -> bool {
        self.overflowed
    }

    fn decode_pending(&mut self) {
        loop {
            match std::str::from_utf8(&self.pending) {
                Ok(text) => {
                    self.buffer.push_str(text);
                    self.pending.clear();
                    break;
                }
                Err(error) => {
                    let valid_up_to = error.valid_up_to();
                    if valid_up_to > 0 {
                        let valid = std::str::from_utf8(&self.pending[..valid_up_to])
                            .expect("valid UTF-8 prefix");
                        self.buffer.push_str(valid);
                    }
                    match error.error_len() {
                        Some(length) => {
                            // Invalid bytes cannot be represented in the event
                            // text. Replace them and keep parsing the rest.
                            self.buffer.push('\u{FFFD}');
                            self.pending.drain(..valid_up_to + length);
                        }
                        None => {
                            // An incomplete multi-byte character: keep it for
                            // the next chunk.
                            self.pending.drain(..valid_up_to);
                            break;
                        }
                    }
                }
            }
        }
    }

    fn drain(&mut self, final_chunk: bool) -> Vec<SseEvent> {
        let mut events = Vec::new();

        while let Some((index, length)) = find_boundary(&self.buffer) {
            let raw = self.buffer[..index].to_string();
            self.buffer.drain(..index + length);
            if let Some(event) = parse_block(&raw) {
                events.push(event);
            }
        }

        if !final_chunk && self.buffer.len() > MAX_BUFFER_CHARS {
            self.overflowed = true;
            self.buffer.clear();
        }

        events
    }
}

fn find_boundary(buffer: &str) -> Option<(usize, usize)> {
    let mut best: Option<(usize, usize)> = None;
    for pattern in ["\r\n\r\n", "\n\n", "\r\r"] {
        if let Some(index) = buffer.find(pattern) {
            match best {
                Some((best_index, best_length))
                    if best_index < index
                        || (best_index == index && best_length >= pattern.len()) => {}
                _ => best = Some((index, pattern.len())),
            }
        }
    }
    best
}

fn parse_block(raw: &str) -> Option<SseEvent> {
    if raw.is_empty() {
        return None;
    }

    let mut event = SseEvent {
        id: None,
        event: None,
        data: String::new(),
        retry: None,
        raw: raw.to_string(),
    };
    let mut data_lines = Vec::new();

    for line in raw.split(['\r', '\n']) {
        if line.is_empty() || line.starts_with(':') {
            continue;
        }

        let (field, value) = match line.find(':') {
            Some(index) => (&line[..index], &line[index + 1..]),
            None => (line, ""),
        };
        let value = value.strip_prefix(' ').unwrap_or(value);

        match field {
            "data" => data_lines.push(value),
            "event" if !value.is_empty() => event.event = Some(value.to_string()),
            "id" if !value.contains('\0') => event.id = Some(value.to_string()),
            "retry" => {
                if let Some(retry) = parse_retry(value) {
                    event.retry = Some(retry);
                }
            }
            _ => {}
        }
    }

    event.data = data_lines.join("\n");
    Some(event)
}

fn parse_retry(value: &str) -> Option<u64> {
    let digits: String = value
        .trim()
        .chars()
        .take_while(char::is_ascii_digit)
        .collect();
    if digits.is_empty() {
        return None;
    }
    digits.parse().ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_all_boundary_styles() {
        for input in ["data: one\n\n", "data: one\r\n\r\n", "data: one\r\r"] {
            let mut parser = SseParser::new();
            let events = parser.feed(input.as_bytes());
            assert_eq!(events.len(), 1, "input {input:?}");
            assert_eq!(events[0].data, "one");
        }
    }

    #[test]
    fn joins_multiline_data_and_ignores_comments() {
        let mut parser = SseParser::new();
        let events =
            parser.feed(b": keepalive\nevent: message\nid: 7\ndata: first\ndata: second\n\n");
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].data, "first\nsecond");
        assert_eq!(events[0].event.as_deref(), Some("message"));
        assert_eq!(events[0].id.as_deref(), Some("7"));
    }

    #[test]
    fn handles_crlf_split_across_chunks() {
        let mut parser = SseParser::new();
        assert!(parser.feed(b"data: hel").is_empty());
        assert!(parser.feed(b"lo\r").is_empty());
        let events = parser.feed(b"\n\r\n");
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].data, "hello");
    }

    #[test]
    fn handles_split_utf8() {
        let text = "data: é\n\n";
        let bytes = text.as_bytes();
        let split = bytes.iter().position(|byte| *byte == 0xC3).unwrap() + 1;
        let mut parser = SseParser::new();
        assert!(parser.feed(&bytes[..split]).is_empty());
        let events = parser.feed(&bytes[split..]);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].data, "é");
    }

    #[test]
    fn parses_retry_prefix_and_rejects_negative() {
        let mut parser = SseParser::new();
        let events = parser.feed(b"retry: 1500ms\nretry: -3\n\n");
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].retry, Some(1500));
    }

    #[test]
    fn emits_unterminated_event_on_end() {
        let mut parser = SseParser::new();
        assert!(parser.feed(b"data: tail").is_empty());
        let events = parser.end();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].data, "tail");
    }

    #[test]
    fn ignores_id_with_nul() {
        let mut parser = SseParser::new();
        let events = parser.feed(b"id: a\0b\ndata: x\n\n");
        assert_eq!(events[0].id, None);
    }
}
