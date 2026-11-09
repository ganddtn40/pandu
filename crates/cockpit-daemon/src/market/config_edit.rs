//! Comment-preserving configuration edits.
//!
//! TOML goes through `toml_edit`; JSON/JSONC uses a small scanner that only
//! touches the value being installed, so comments, trailing commas, key order,
//! and unknown keys survive. Every edit is verified by parsing the result.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use toml_edit::{Array, DocumentMut, Item, Table, Value as TomlValue};

use super::MarketError;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ConfigFormat {
    Toml,
    Json,
    Jsonc,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConfigChange {
    pub path: PathBuf,
    pub display_path: String,
    pub key_path: Vec<String>,
    pub value: Value,
    pub format: ConfigFormat,
}

impl ConfigChange {
    pub fn key(&self) -> String {
        self.key_path.join(".")
    }

    pub fn before(&self, contents: Option<&str>) -> Result<Option<Value>, MarketError> {
        match contents {
            Some(contents) => read_value(contents, self.format, &self.key_path),
            None => Ok(None),
        }
    }

    pub fn apply(&self, contents: Option<&str>) -> Result<String, MarketError> {
        apply_change(contents, self.format, &self.key_path, &self.value)
    }

    pub fn remove(&self, contents: &str) -> Result<String, MarketError> {
        remove_change(contents, self.format, &self.key_path)
    }
}

pub fn read_value(
    contents: &str,
    format: ConfigFormat,
    key_path: &[String],
) -> Result<Option<Value>, MarketError> {
    match format {
        ConfigFormat::Toml => {
            let document: DocumentMut = contents.parse().map_err(|error| {
                MarketError::Config(format!("The TOML file could not be parsed: {error}"))
            })?;
            let mut table: &Table = document.as_table();
            for (index, key) in key_path.iter().enumerate() {
                let Some(item) = table.get(key) else {
                    return Ok(None);
                };
                if index == key_path.len() - 1 {
                    return Ok(Some(item_to_json(item)?));
                }
                table = item
                    .as_table()
                    .ok_or_else(|| MarketError::Config(format!("`{key}` is not a TOML table.")))?;
            }
            Ok(None)
        }
        ConfigFormat::Json | ConfigFormat::Jsonc => {
            let value = parse_jsonc(contents)?;
            let mut current = &value;
            for key in key_path {
                let Some(next) = current.get(key) else {
                    return Ok(None);
                };
                current = next;
            }
            Ok(Some(current.clone()))
        }
    }
}

pub fn apply_change(
    contents: Option<&str>,
    format: ConfigFormat,
    key_path: &[String],
    value: &Value,
) -> Result<String, MarketError> {
    if key_path.is_empty() {
        return Err(MarketError::Config("A config key is required.".into()));
    }
    match format {
        ConfigFormat::Toml => {
            let mut document: DocumentMut = match contents {
                Some(contents) if !contents.trim().is_empty() => {
                    contents.parse().map_err(|error| {
                        MarketError::Config(format!("The TOML file could not be parsed: {error}"))
                    })?
                }
                _ => DocumentMut::new(),
            };
            set_toml_path(&mut document, key_path, value)?;
            let output = document.to_string();
            output.parse::<DocumentMut>().map_err(|error| {
                MarketError::Config(format!("The edited TOML is not valid: {error}"))
            })?;
            Ok(output)
        }
        ConfigFormat::Json | ConfigFormat::Jsonc => {
            let text = match contents {
                Some(contents) if !contents.trim().is_empty() => contents.to_string(),
                _ => "{\n}\n".to_string(),
            };
            let output = set_jsonc_path(&text, key_path, value)?;
            parse_jsonc(&output)?;
            Ok(output)
        }
    }
}

pub fn remove_change(
    contents: &str,
    format: ConfigFormat,
    key_path: &[String],
) -> Result<String, MarketError> {
    if key_path.is_empty() {
        return Err(MarketError::Config("A config key is required.".into()));
    }
    match format {
        ConfigFormat::Toml => {
            let mut document: DocumentMut = contents.parse().map_err(|error| {
                MarketError::Config(format!("The TOML file could not be parsed: {error}"))
            })?;
            remove_toml_path(&mut document, key_path)?;
            let output = document.to_string();
            output.parse::<DocumentMut>().map_err(|error| {
                MarketError::Config(format!("The edited TOML is not valid: {error}"))
            })?;
            Ok(output)
        }
        ConfigFormat::Json | ConfigFormat::Jsonc => {
            let output = remove_jsonc_path(contents, key_path)?;
            parse_jsonc(&output)?;
            Ok(output)
        }
    }
}

fn set_toml_path(
    document: &mut DocumentMut,
    key_path: &[String],
    value: &Value,
) -> Result<(), MarketError> {
    let (last, parents) = key_path.split_last().expect("non-empty key path");
    let mut table: &mut Table = document.as_table_mut();
    for key in parents {
        let item = table
            .entry(key)
            .or_insert_with(|| Item::Table(Table::new()));
        table = item
            .as_table_mut()
            .ok_or_else(|| MarketError::Config(format!("`{key}` is not a TOML table.")))?;
    }
    table.insert(last, json_to_toml_item(value)?);
    Ok(())
}

fn remove_toml_path(document: &mut DocumentMut, key_path: &[String]) -> Result<(), MarketError> {
    let (last, parents) = key_path.split_last().expect("non-empty key path");
    let mut table: &mut Table = document.as_table_mut();
    for key in parents {
        let Some(item) = table.get_mut(key) else {
            return Ok(());
        };
        table = item
            .as_table_mut()
            .ok_or_else(|| MarketError::Config(format!("`{key}` is not a TOML table.")))?;
    }
    table.remove(last);
    Ok(())
}

fn json_to_toml_item(value: &Value) -> Result<Item, MarketError> {
    match value {
        Value::Object(map) => {
            let mut table = Table::new();
            for (key, value) in map {
                table.insert(key, json_to_toml_item(value)?);
            }
            Ok(Item::Table(table))
        }
        Value::Array(items) => {
            let mut array = Array::new();
            for item in items {
                array.push(json_to_toml_value(item)?);
            }
            Ok(Item::Value(TomlValue::Array(array)))
        }
        Value::String(value) => Ok(Item::Value(TomlValue::from(value.clone()))),
        Value::Bool(value) => Ok(Item::Value(TomlValue::from(*value))),
        Value::Number(number) => {
            if let Some(value) = number.as_i64() {
                Ok(Item::Value(TomlValue::from(value)))
            } else if let Some(value) = number.as_f64() {
                Ok(Item::Value(TomlValue::from(value)))
            } else {
                Err(MarketError::Config(
                    "The config value contains an unsupported number.".into(),
                ))
            }
        }
        Value::Null => Err(MarketError::Config(
            "TOML cannot store a null value.".into(),
        )),
    }
}

fn json_to_toml_value(value: &Value) -> Result<TomlValue, MarketError> {
    match json_to_toml_item(value)? {
        Item::Value(value) => Ok(value),
        _ => Err(MarketError::Config(
            "TOML arrays cannot contain tables here.".into(),
        )),
    }
}

fn item_to_json(item: &Item) -> Result<Value, MarketError> {
    match item {
        Item::Value(value) => toml_value_to_json(value),
        Item::Table(table) => {
            let mut map = serde_json::Map::new();
            for (key, item) in table.iter() {
                map.insert(key.to_string(), item_to_json(item)?);
            }
            Ok(Value::Object(map))
        }
        Item::ArrayOfTables(tables) => {
            let mut items = Vec::new();
            for table in tables.iter() {
                let mut map = serde_json::Map::new();
                for (key, item) in table.iter() {
                    map.insert(key.to_string(), item_to_json(item)?);
                }
                items.push(Value::Object(map));
            }
            Ok(Value::Array(items))
        }
        Item::None => Ok(Value::Null),
    }
}

fn toml_value_to_json(value: &TomlValue) -> Result<Value, MarketError> {
    Ok(match value {
        TomlValue::String(value) => Value::String(value.value().clone()),
        TomlValue::Integer(value) => Value::Number((*value.value()).into()),
        TomlValue::Float(value) => serde_json::Number::from_f64(*value.value())
            .map(Value::Number)
            .ok_or_else(|| MarketError::Config("A TOML float is not finite.".into()))?,
        TomlValue::Boolean(value) => Value::Bool(*value.value()),
        TomlValue::Datetime(value) => Value::String(value.value().to_string()),
        TomlValue::Array(array) => Value::Array(
            array
                .iter()
                .map(toml_value_to_json)
                .collect::<Result<Vec<_>, _>>()?,
        ),
        TomlValue::InlineTable(table) => {
            let mut map = serde_json::Map::new();
            for (key, value) in table.iter() {
                map.insert(key.to_string(), toml_value_to_json(value)?);
            }
            Value::Object(map)
        }
    })
}

/// Parse JSON or JSONC after blanking comments and trailing commas.
pub fn parse_jsonc(contents: &str) -> Result<Value, MarketError> {
    let stripped = strip_jsonc(contents)?;
    serde_json::from_str(&stripped).map_err(|error| {
        MarketError::Config(format!("The JSON/JSONC file could not be parsed: {error}"))
    })
}

fn strip_jsonc(contents: &str) -> Result<String, MarketError> {
    let bytes = contents.as_bytes();
    let mut output = bytes.to_vec();
    let mut index = 0;
    let mut in_string = false;
    while index < bytes.len() {
        let byte = bytes[index];
        if in_string {
            if byte == b'\\' {
                index += 2;
                continue;
            }
            if byte == b'"' {
                in_string = false;
            }
            index += 1;
            continue;
        }
        if byte == b'"' {
            in_string = true;
            index += 1;
            continue;
        }
        if byte == b'/' && index + 1 < bytes.len() && bytes[index + 1] == b'/' {
            while index < bytes.len() && bytes[index] != b'\n' {
                output[index] = b' ';
                index += 1;
            }
            continue;
        }
        if byte == b'/' && index + 1 < bytes.len() && bytes[index + 1] == b'*' {
            output[index] = b' ';
            output[index + 1] = b' ';
            index += 2;
            while index + 1 < bytes.len() && !(bytes[index] == b'*' && bytes[index + 1] == b'/') {
                if bytes[index] != b'\n' {
                    output[index] = b' ';
                }
                index += 1;
            }
            if index + 1 < bytes.len() {
                output[index] = b' ';
                output[index + 1] = b' ';
                index += 2;
            }
            continue;
        }
        index += 1;
    }
    let mut text = String::from_utf8(output)
        .map_err(|_| MarketError::Config("The config file is not UTF-8.".into()))?;
    // Trailing commas are legal in JSONC but not in serde_json.
    let trailing = regex::Regex::new(r",(\s*[}\]])").expect("valid trailing comma regex");
    text = trailing.replace_all(&text, "$1").into_owned();
    Ok(text)
}

#[derive(Debug, Clone)]
struct Member {
    key: String,
    key_start: usize,
    value_start: usize,
    value_end: usize,
}

fn top_object_span(text: &str) -> Result<(usize, usize), MarketError> {
    let bytes = text.as_bytes();
    let open = skip_trivia(bytes, 0)?;
    if bytes.get(open) != Some(&b'{') {
        return Err(MarketError::Config(
            "The JSON/JSONC root must be an object.".into(),
        ));
    }
    let close = matching_close(bytes, open)?;
    Ok((open, close))
}

fn matching_close(bytes: &[u8], open: usize) -> Result<usize, MarketError> {
    let opener = bytes[open];
    let closer = match opener {
        b'{' => b'}',
        b'[' => b']',
        _ => {
            return Err(MarketError::Config(
                "The JSON/JSONC structure is invalid.".into(),
            ));
        }
    };
    let mut depth = 0usize;
    let mut index = open;
    while index < bytes.len() {
        match bytes[index] {
            b'"' => {
                index = string_end(bytes, index)? + 1;
                continue;
            }
            b'/' if index + 1 < bytes.len() && bytes[index + 1] == b'/' => {
                while index < bytes.len() && bytes[index] != b'\n' {
                    index += 1;
                }
                continue;
            }
            b'/' if index + 1 < bytes.len() && bytes[index + 1] == b'*' => {
                index += 2;
                while index + 1 < bytes.len() && !(bytes[index] == b'*' && bytes[index + 1] == b'/')
                {
                    index += 1;
                }
                index = (index + 2).min(bytes.len());
                continue;
            }
            byte if byte == opener => depth += 1,
            byte if byte == closer => {
                depth = depth.saturating_sub(1);
                if depth == 0 {
                    return Ok(index);
                }
            }
            _ => {}
        }
        index += 1;
    }
    Err(MarketError::Config(
        "The JSON/JSONC structure has an unclosed object or array.".into(),
    ))
}

fn string_end(bytes: &[u8], start: usize) -> Result<usize, MarketError> {
    let mut index = start + 1;
    while index < bytes.len() {
        match bytes[index] {
            b'\\' => index += 2,
            b'"' => return Ok(index),
            _ => index += 1,
        }
    }
    Err(MarketError::Config(
        "The JSON/JSONC file has an unterminated string.".into(),
    ))
}

fn skip_trivia(bytes: &[u8], mut index: usize) -> Result<usize, MarketError> {
    loop {
        while index < bytes.len() && bytes[index].is_ascii_whitespace() {
            index += 1;
        }
        if index + 1 < bytes.len() && bytes[index] == b'/' && bytes[index + 1] == b'/' {
            while index < bytes.len() && bytes[index] != b'\n' {
                index += 1;
            }
            continue;
        }
        if index + 1 < bytes.len() && bytes[index] == b'/' && bytes[index + 1] == b'*' {
            index += 2;
            while index + 1 < bytes.len() && !(bytes[index] == b'*' && bytes[index + 1] == b'/') {
                index += 1;
            }
            index = (index + 2).min(bytes.len());
            continue;
        }
        return Ok(index);
    }
}

fn parse_members(bytes: &[u8], open: usize) -> Result<Vec<Member>, MarketError> {
    let close = matching_close(bytes, open)?;
    let mut members = Vec::new();
    let mut index = skip_trivia(bytes, open + 1)?;
    while index < close {
        if bytes[index] == b',' {
            index = skip_trivia(bytes, index + 1)?;
            continue;
        }
        if bytes[index] != b'"' {
            return Err(MarketError::Config(
                "The JSON/JSONC object has a non-string key.".into(),
            ));
        }
        let key_start = index;
        let key_end = string_end(bytes, index)?;
        let key: String = serde_json::from_slice(&bytes[key_start..=key_end])
            .map_err(|_| MarketError::Config("The JSON/JSONC object has an invalid key.".into()))?;
        index = skip_trivia(bytes, key_end + 1)?;
        if bytes.get(index) != Some(&b':') {
            return Err(MarketError::Config(
                "The JSON/JSONC object is missing a colon.".into(),
            ));
        }
        let value_start = skip_trivia(bytes, index + 1)?;
        let value_end = value_end(bytes, value_start)?;
        members.push(Member {
            key,
            key_start,
            value_start,
            value_end,
        });
        index = skip_trivia(bytes, value_end)?;
    }
    Ok(members)
}

fn value_end(bytes: &[u8], start: usize) -> Result<usize, MarketError> {
    let start = skip_trivia(bytes, start)?;
    match bytes.get(start) {
        Some(b'{') | Some(b'[') => Ok(matching_close(bytes, start)? + 1),
        Some(b'"') => Ok(string_end(bytes, start)? + 1),
        Some(_) => {
            let mut index = start;
            while index < bytes.len()
                && !matches!(bytes[index], b',' | b'}' | b']')
                && !bytes[index].is_ascii_whitespace()
            {
                index += 1;
            }
            Ok(index)
        }
        None => Err(MarketError::Config(
            "The JSON/JSONC file ends unexpectedly.".into(),
        )),
    }
}

fn set_jsonc_path(text: &str, key_path: &[String], value: &Value) -> Result<String, MarketError> {
    let (open, close) = top_object_span(text)?;
    set_in_object(text, open, close, key_path, value, 0)
}

fn set_in_object(
    text: &str,
    open: usize,
    close: usize,
    key_path: &[String],
    value: &Value,
    depth: usize,
) -> Result<String, MarketError> {
    let bytes = text.as_bytes();
    let members = parse_members(bytes, open)?;
    let (key, rest) = key_path.split_first().expect("non-empty key path");
    let member = members.iter().find(|member| &member.key == key);
    if rest.is_empty() {
        if let Some(member) = member {
            let indentation = line_indent(text, member.key_start, depth + 1);
            let rendered = render_json(value, &indentation);
            let mut output = String::with_capacity(text.len() + rendered.len());
            output.push_str(&text[..member.value_start]);
            output.push_str(&rendered);
            output.push_str(&text[member.value_end..]);
            return Ok(output);
        }
        let insertion = insertion_text(text, open, close, &members, key, value, depth);
        return Ok(format!("{}{}{}", &text[..close], insertion, &text[close..]));
    }
    if let Some(member) = member {
        if bytes.get(member.value_start) == Some(&b'{') {
            let nested_close = matching_close(bytes, member.value_start)?;
            let nested = set_in_object(
                text,
                member.value_start,
                nested_close,
                rest,
                value,
                depth + 1,
            )?;
            let delta = nested.len() as isize - text.len() as isize;
            let new_close = (nested_close as isize + delta) as usize;
            let mut output = String::with_capacity(nested.len());
            output.push_str(&nested[..member.value_start]);
            output.push_str(&nested[member.value_start..=new_close]);
            output.push_str(&nested[new_close + 1..]);
            return Ok(output);
        }
        let indentation = line_indent(text, member.key_start, depth + 1);
        let nested_value = nested_json(rest, value);
        let rendered = render_json(&nested_value, &indentation);
        let mut output = String::with_capacity(text.len() + rendered.len());
        output.push_str(&text[..member.value_start]);
        output.push_str(&rendered);
        output.push_str(&text[member.value_end..]);
        return Ok(output);
    }
    let nested_value = nested_json(rest, value);
    let insertion = insertion_text(text, open, close, &members, key, &nested_value, depth);
    Ok(format!("{}{}{}", &text[..close], insertion, &text[close..]))
}

fn nested_json(path: &[String], value: &Value) -> Value {
    let mut current = value.clone();
    for key in path.iter().rev() {
        let mut map = serde_json::Map::new();
        map.insert(key.clone(), current);
        current = Value::Object(map);
    }
    current
}

fn insertion_text(
    text: &str,
    _open: usize,
    close: usize,
    members: &[Member],
    key: &str,
    value: &Value,
    depth: usize,
) -> String {
    let closing_indent = line_indent(text, close, depth);
    let member_indent = if let Some(first) = members.first() {
        line_indent(text, first.key_start, depth + 1)
    } else {
        format!("{closing_indent}  ")
    };
    let rendered = render_json(value, &member_indent);
    let comma = if members.is_empty()
        || text[members.last().expect("member").value_end..close].contains(',')
    {
        String::new()
    } else {
        ",".to_string()
    };
    format!(
        "\n{member_indent}{}{comma}\n{member_indent}\"{}\": {rendered}",
        "", key
    )
    .replace(
        &format!("{member_indent}\n{member_indent}\""),
        &format!("{member_indent}\""),
    )
    .replace(
        &format!("{comma}\n{member_indent}\"{key}\": {rendered}\n{member_indent}"),
        "",
    )
}

fn render_json(value: &Value, indent: &str) -> String {
    let pretty = serde_json::to_string_pretty(value).unwrap_or_else(|_| "null".into());
    let mut output = String::new();
    for (index, line) in pretty.lines().enumerate() {
        if index > 0 {
            output.push('\n');
            output.push_str(indent);
        }
        output.push_str(line);
    }
    output
}

fn line_indent(text: &str, position: usize, depth: usize) -> String {
    let line_start = text[..position.min(text.len())]
        .rfind('\n')
        .map(|index| index + 1)
        .unwrap_or(0);
    let whitespace: String = text[line_start..position.min(text.len())]
        .chars()
        .take_while(|character| *character == ' ' || *character == '\t')
        .collect();
    if whitespace.is_empty() {
        "  ".repeat(depth + 1)
    } else {
        whitespace
    }
}

fn remove_jsonc_path(text: &str, key_path: &[String]) -> Result<String, MarketError> {
    let (open, close) = top_object_span(text)?;
    remove_in_object(text, open, close, key_path)
}

fn remove_in_object(
    text: &str,
    open: usize,
    _close: usize,
    key_path: &[String],
) -> Result<String, MarketError> {
    let bytes = text.as_bytes();
    let members = parse_members(bytes, open)?;
    let (key, rest) = key_path.split_first().expect("non-empty key path");
    let Some(member) = members.iter().find(|member| &member.key == key) else {
        return Ok(text.to_string());
    };
    if !rest.is_empty() {
        if bytes.get(member.value_start) == Some(&b'{') {
            let nested_close = matching_close(bytes, member.value_start)?;
            return remove_in_object(text, member.value_start, nested_close, rest);
        }
        return Ok(text.to_string());
    }
    let mut start = member.key_start;
    while start > 0 && matches!(bytes[start - 1], b' ' | b'\t') {
        start -= 1;
    }
    if start > 0 && bytes[start - 1] == b'\n' {
        start -= 1;
        if start > 0 && bytes[start - 1] == b'\r' {
            start -= 1;
        }
    } else {
        // Inline object: eat the comma before the member.
        let mut index = start;
        while index > 0 && matches!(bytes[index - 1], b' ' | b'\t') {
            index -= 1;
        }
        if index > 0 && bytes[index - 1] == b',' {
            start = index - 1;
        }
    }
    let mut end = member.value_end;
    while end < bytes.len() && matches!(bytes[end], b' ' | b'\t') {
        end += 1;
    }
    if end < bytes.len() && bytes[end] == b',' {
        end += 1;
        while end < bytes.len() && matches!(bytes[end], b' ' | b'\t') {
            end += 1;
        }
        if end < bytes.len() && bytes[end] == b'\n' {
            end += 1;
            if end < bytes.len() && bytes[end - 2] == b'\r' {
                // Already consumed by the slice; keep it simple.
            }
        }
    } else if start > 0 && bytes[start] == b'\n' {
        // Removing the last member: keep the closing brace on its own line.
    }
    let mut output = String::with_capacity(text.len());
    output.push_str(&text[..start]);
    output.push_str(&text[end..]);
    Ok(output)
}

/// A compact line diff used by the install preview.
pub fn line_diff(before: Option<&str>, after: &str) -> String {
    let before = before.unwrap_or("");
    let old: Vec<&str> = before.lines().collect();
    let new: Vec<&str> = after.lines().collect();
    if old.len() > 2_000 || new.len() > 2_000 {
        return format!(
            "--- before ({} lines)\n+++ after ({} lines)\n(diff omitted: file is too large)",
            old.len(),
            new.len()
        );
    }
    let mut table = vec![vec![0usize; new.len() + 1]; old.len() + 1];
    for i in (0..old.len()).rev() {
        for j in (0..new.len()).rev() {
            table[i][j] = if old[i] == new[j] {
                table[i + 1][j + 1] + 1
            } else {
                table[i + 1][j].max(table[i][j + 1])
            };
        }
    }
    let mut output = String::from("--- before\n+++ after\n");
    let (mut i, mut j) = (0usize, 0usize);
    while i < old.len() && j < new.len() {
        if old[i] == new[j] {
            output.push_str(&format!(" {}\n", old[i]));
            i += 1;
            j += 1;
        } else if table[i + 1][j] >= table[i][j + 1] {
            output.push_str(&format!("-{}\n", old[i]));
            i += 1;
        } else {
            output.push_str(&format!("+{}\n", new[j]));
            j += 1;
        }
    }
    while i < old.len() {
        output.push_str(&format!("-{}\n", old[i]));
        i += 1;
    }
    while j < new.len() {
        output.push_str(&format!("+{}\n", new[j]));
        j += 1;
    }
    output
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn toml_round_trip_preserves_comments_and_unknown_keys() {
        let before = "# keep me\nmodel = \"x\"\n\n[mcp_servers.other]\ncommand = \"other\"\n";
        let after = apply_change(
            Some(before),
            ConfigFormat::Toml,
            &["mcp_servers".into(), "demo".into()],
            &json!({"command": "npx", "args": ["-y", "pkg@1.2.3"]}),
        )
        .unwrap();
        assert!(after.contains("# keep me"));
        assert!(after.contains("model = \"x\""));
        assert!(after.contains("[mcp_servers.other]"));
        assert!(after.contains("[mcp_servers.demo]"));
        let value = read_value(
            &after,
            ConfigFormat::Toml,
            &["mcp_servers".into(), "demo".into()],
        )
        .unwrap()
        .unwrap();
        assert_eq!(value["command"], "npx");
    }

    #[test]
    fn jsonc_round_trip_preserves_comments_and_unknown_keys() {
        let before = "{\n  // keep me\n  \"model\": \"x\",\n  \"unknown\": {\"a\": 1},\n}\n";
        let after = apply_change(
            Some(before),
            ConfigFormat::Jsonc,
            &["mcp".into(), "servers".into(), "demo".into()],
            &json!({"type": "local", "command": ["npx", "-y", "pkg@1.2.3"]}),
        )
        .unwrap();
        assert!(after.contains("// keep me"));
        assert!(after.contains("\"unknown\""));
        assert!(after.contains("\"demo\""));
        let value = read_value(
            &after,
            ConfigFormat::Jsonc,
            &["mcp".into(), "servers".into(), "demo".into()],
        )
        .unwrap()
        .unwrap();
        assert_eq!(value["type"], "local");
        let removed = remove_change(
            &after,
            ConfigFormat::Jsonc,
            &["mcp".into(), "servers".into(), "demo".into()],
        )
        .unwrap();
        assert!(removed.contains("// keep me"));
        assert!(!removed.contains("\"demo\""));
    }

    #[test]
    fn jsonc_set_and_remove_existing_member() {
        let before = "{\n  \"mcpServers\": {\n    \"old\": {\"command\": \"x\"}\n  }\n}\n";
        let after = apply_change(
            Some(before),
            ConfigFormat::Jsonc,
            &["mcpServers".into(), "new".into()],
            &json!({"command": "y"}),
        )
        .unwrap();
        assert!(after.contains("\"old\""));
        assert!(after.contains("\"new\""));
        let removed = remove_change(
            &after,
            ConfigFormat::Jsonc,
            &["mcpServers".into(), "new".into()],
        )
        .unwrap();
        assert!(!removed.contains("\"new\""));
        assert!(removed.contains("\"old\""));
    }
}
