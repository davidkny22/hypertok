use crate::load_tokenizer::htk::{HtkTokenizer, LoadedHtk, load_htk_slice};
use wasm_bindgen::prelude::*;

fn js_error(error: impl std::fmt::Display) -> JsError {
    JsError::new(&error.to_string())
}

fn input_text(input: &[u8]) -> Result<&str, JsError> {
    std::str::from_utf8(input)
        .map_err(|error| JsError::new(&format!("input is not valid UTF-8: {error}")))
}

#[wasm_bindgen]
pub struct WasmSentencePieceTokenizer {
    loaded: LoadedHtk,
}

#[wasm_bindgen]
impl WasmSentencePieceTokenizer {
    #[wasm_bindgen(js_name = fromHtk)]
    pub fn from_htk(data: &[u8]) -> Result<WasmSentencePieceTokenizer, JsError> {
        let loaded = load_htk_slice(data).map_err(js_error)?;
        if !matches!(&loaded.tokenizer, HtkTokenizer::SentencePiece(_)) {
            return Err(JsError::new(
                "WasmSentencePieceTokenizer requires a sentencepiece .htk file",
            ));
        }
        Ok(Self { loaded })
    }

    pub fn encode(&mut self, input: &[u8]) -> Result<Vec<u32>, JsError> {
        Ok(self.loaded.tokenizer.encode(input_text(input)?))
    }

    pub fn decode(&self, ids: &[u32]) -> Result<String, JsError> {
        self.loaded.decode_text(ids).map_err(js_error)
    }

    #[wasm_bindgen(js_name = tokenBytes)]
    pub fn token_bytes(&self, id: u32) -> Result<Vec<u8>, JsError> {
        self.loaded
            .lookup_index
            .token(id)
            .filter(|bytes| !bytes.is_empty())
            .map(<[u8]>::to_vec)
            .ok_or_else(|| JsError::new(&format!("unknown token id {id}")))
    }

    #[wasm_bindgen(js_name = tokenStarts)]
    pub fn token_starts(&self, input: &[u8], ids: &[u32]) -> Result<Vec<u32>, JsError> {
        input_text(input)?;
        let mut raw = Vec::new();
        let mut boundaries = Vec::with_capacity(ids.len());
        for &id in ids {
            boundaries.push(raw.len());
            let token = self
                .loaded
                .lookup_index
                .token(id)
                .filter(|bytes| !bytes.is_empty())
                .ok_or_else(|| JsError::new(&format!("unknown token id {id}")))?;
            raw.extend_from_slice(token);
        }
        let raw_text = std::str::from_utf8(&raw)
            .map_err(|_| JsError::new("sentencepiece token bytes are not valid UTF-8"))?;
        let decoded = raw_text.replace('\u{2581}', " ");
        let strip = if decoded.as_bytes() == input {
            0
        } else if decoded.as_bytes().get(1..) == Some(input)
            && decoded.as_bytes().first() == Some(&b' ')
        {
            1
        } else {
            return Err(JsError::new(
                "encoded token sequence does not decode to the original input",
            ));
        };
        let mut chars = raw_text.char_indices().peekable();
        let mut decoded_offset = 0usize;
        let mut starts = Vec::with_capacity(boundaries.len());
        for boundary in boundaries {
            while let Some(&(raw_offset, character)) = chars.peek() {
                if raw_offset + character.len_utf8() > boundary {
                    break;
                }
                decoded_offset += if character == '\u{2581}' {
                    1
                } else {
                    character.len_utf8()
                };
                chars.next();
            }
            starts.push(
                u32::try_from(decoded_offset.saturating_sub(strip))
                    .map_err(|_| JsError::new("input byte length exceeds u32"))?,
            );
        }
        Ok(starts)
    }

    #[wasm_bindgen(js_name = encodeReserved)]
    pub fn encode_reserved(
        &mut self,
        input: &[u8],
        match_all: bool,
        match_names_json: &str,
        refuse_all: bool,
        refuse_names_json: &str,
    ) -> Result<WasmSentencePieceEncoding, JsError> {
        let text = input_text(input)?;
        let match_names: Vec<String> = serde_json::from_str(match_names_json).map_err(js_error)?;
        let refuse_names: Vec<String> =
            serde_json::from_str(refuse_names_json).map_err(js_error)?;
        let encoded = self
            .loaded
            .encode_reserved(text, match_all, &match_names, refuse_all, &refuse_names)
            .map_err(js_error)?;
        let starts = self.token_starts(input, &encoded.ids)?;
        Ok(WasmSentencePieceEncoding {
            ids: encoded.ids,
            starts,
            found_json: serde_json::to_string(&encoded.found).map_err(js_error)?,
        })
    }

    #[wasm_bindgen(js_name = reservedNamesJson)]
    pub fn reserved_names_json(&self) -> Result<String, JsError> {
        serde_json::to_string(&self.loaded.reserved_catalog.names()).map_err(js_error)
    }

    #[wasm_bindgen(js_name = reservedFoundJson)]
    pub fn reserved_found_json(&self, input: &[u8]) -> Result<String, JsError> {
        input_text(input)?;
        serde_json::to_string(&self.loaded.reserved_catalog.found_names(input)).map_err(js_error)
    }

    #[wasm_bindgen(js_name = vocabSize)]
    pub fn vocab_size(&self) -> usize {
        self.loaded.tokenizer.vocab_size()
    }
}

#[wasm_bindgen]
pub struct WasmSentencePieceEncoding {
    ids: Vec<u32>,
    starts: Vec<u32>,
    found_json: String,
}

#[wasm_bindgen]
impl WasmSentencePieceEncoding {
    pub fn ids(&self) -> Vec<u32> {
        self.ids.clone()
    }

    pub fn starts(&self) -> Vec<u32> {
        self.starts.clone()
    }

    #[wasm_bindgen(js_name = foundJson)]
    pub fn found_json(&self) -> String {
        self.found_json.clone()
    }
}
