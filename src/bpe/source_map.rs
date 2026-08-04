use std::fmt::{self, Display, Formatter};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct SourceSpan {
    pub start: u32,
    pub end: u32,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct MappedBytes {
    bytes: Vec<u8>,
    spans: Vec<SourceSpan>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum SourceMapError {
    InvalidUtf8,
    OffsetOverflow,
}

impl Display for SourceMapError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidUtf8 => formatter.write_str("mapped text is not valid UTF-8"),
            Self::OffsetOverflow => formatter.write_str("source offset exceeds u32"),
        }
    }
}

impl std::error::Error for SourceMapError {}

impl MappedBytes {
    pub(crate) fn empty() -> Self {
        Self {
            bytes: Vec::new(),
            spans: Vec::new(),
        }
    }

    pub(crate) fn identity(bytes: &[u8], base: usize) -> Result<Self, SourceMapError> {
        let mut spans = Vec::with_capacity(bytes.len());
        for index in 0..bytes.len() {
            let start = base
                .checked_add(index)
                .and_then(|value| u32::try_from(value).ok())
                .ok_or(SourceMapError::OffsetOverflow)?;
            let end = start.checked_add(1).ok_or(SourceMapError::OffsetOverflow)?;
            spans.push(SourceSpan { start, end });
        }
        Ok(Self {
            bytes: bytes.to_vec(),
            spans,
        })
    }

    pub(crate) fn bytes(&self) -> &[u8] {
        &self.bytes
    }

    pub(crate) fn spans(&self) -> &[SourceSpan] {
        &self.spans
    }

    pub(crate) fn append(&mut self, mut other: Self) {
        self.bytes.append(&mut other.bytes);
        self.spans.append(&mut other.spans);
    }

    pub(crate) fn prepend_inserted(
        &mut self,
        bytes: &[u8],
        insertion: usize,
    ) -> Result<(), SourceMapError> {
        if bytes.is_empty() {
            return Ok(());
        }
        let insertion = u32::try_from(insertion).map_err(|_| SourceMapError::OffsetOverflow)?;
        let span = SourceSpan {
            start: insertion,
            end: insertion,
        };
        let mut output = Vec::with_capacity(bytes.len() + self.bytes.len());
        output.extend_from_slice(bytes);
        output.append(&mut self.bytes);
        self.bytes = output;
        let mut spans = vec![span; bytes.len()];
        spans.append(&mut self.spans);
        self.spans = spans;
        Ok(())
    }

    pub(crate) fn replace_literal(&mut self, pattern: &[u8], replacement: &[u8]) {
        if pattern.is_empty() {
            return;
        }
        let mut bytes = Vec::with_capacity(self.bytes.len());
        let mut spans = Vec::with_capacity(self.spans.len());
        let mut cursor = 0;
        while let Some(relative) = memchr::memmem::find(&self.bytes[cursor..], pattern) {
            let start = cursor + relative;
            let end = start + pattern.len();
            bytes.extend_from_slice(&self.bytes[cursor..start]);
            spans.extend_from_slice(&self.spans[cursor..start]);
            let span = union_span(&self.spans[start..end]);
            bytes.extend_from_slice(replacement);
            spans.extend(std::iter::repeat_n(span, replacement.len()));
            cursor = end;
        }
        bytes.extend_from_slice(&self.bytes[cursor..]);
        spans.extend_from_slice(&self.spans[cursor..]);
        self.bytes = bytes;
        self.spans = spans;
    }

    pub(crate) fn collapse_ascii_space_runs(&mut self, replacement: &[u8]) {
        let mut bytes = Vec::with_capacity(self.bytes.len());
        let mut spans = Vec::with_capacity(self.spans.len());
        let mut cursor = 0;
        while cursor < self.bytes.len() {
            if self.bytes[cursor] != b' ' {
                bytes.push(self.bytes[cursor]);
                spans.push(self.spans[cursor]);
                cursor += 1;
                continue;
            }
            let start = cursor;
            while cursor < self.bytes.len() && self.bytes[cursor] == b' ' {
                cursor += 1;
            }
            if cursor - start < 2 {
                bytes.push(b' ');
                spans.push(self.spans[start]);
                continue;
            }
            let span = union_span(&self.spans[start..cursor]);
            bytes.extend_from_slice(replacement);
            spans.extend(std::iter::repeat_n(span, replacement.len()));
        }
        self.bytes = bytes;
        self.spans = spans;
    }

    pub(crate) fn strip_unicode_whitespace(
        &mut self,
        left: bool,
        right: bool,
    ) -> Result<(), SourceMapError> {
        let text = std::str::from_utf8(&self.bytes).map_err(|_| SourceMapError::InvalidUtf8)?;
        let start = if left {
            text.len() - text.trim_start().len()
        } else {
            0
        };
        let end = if right {
            text.trim_end().len()
        } else {
            text.len()
        };
        if start == 0 && end == self.bytes.len() {
            return Ok(());
        }
        self.bytes = self.bytes[start..end].to_vec();
        self.spans = self.spans[start..end].to_vec();
        Ok(())
    }

    pub(crate) fn normalize_nfc(&mut self) -> Result<(), SourceMapError> {
        let text = std::str::from_utf8(&self.bytes).map_err(|_| SourceMapError::InvalidUtf8)?;
        if crate::bpe::nfc::is_normalized(text) {
            return Ok(());
        }
        let (normalized, spans) = crate::bpe::nfc::normalize_with_spans(text, &self.spans);
        self.bytes = normalized.into_bytes();
        self.spans = spans;
        Ok(())
    }
}

fn union_span(spans: &[SourceSpan]) -> SourceSpan {
    debug_assert!(!spans.is_empty());
    SourceSpan {
        start: spans.iter().map(|span| span.start).min().unwrap_or(0),
        end: spans.iter().map(|span| span.end).max().unwrap_or(0),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn local_operations_preserve_original_spans() {
        let mut mapped = MappedBytes::identity(b"  a  b  ", 4).unwrap();
        mapped.strip_unicode_whitespace(true, true).unwrap();
        mapped.collapse_ascii_space_runs(b"_");
        assert_eq!(mapped.bytes(), b"a_b");
        assert_eq!(
            mapped.spans(),
            [
                SourceSpan { start: 6, end: 7 },
                SourceSpan { start: 7, end: 9 },
                SourceSpan { start: 9, end: 10 },
            ]
        );

        mapped.replace_literal(b"_", b"XYZ");
        assert_eq!(mapped.bytes(), b"aXYZb");
        assert_eq!(mapped.spans()[1..4], [SourceSpan { start: 7, end: 9 }; 3]);
        mapped.prepend_inserted(b"++", 4).unwrap();
        assert_eq!(mapped.bytes(), b"++aXYZb");
        assert_eq!(mapped.spans()[..2], [SourceSpan { start: 4, end: 4 }; 2]);
    }

    #[test]
    fn nfc_changed_cluster_rounds_to_original_cluster_start() {
        let input = "A\u{30a} and e\u{301}";
        let mut mapped = MappedBytes::identity(input.as_bytes(), 3).unwrap();
        mapped.normalize_nfc().unwrap();
        assert_eq!(std::str::from_utf8(mapped.bytes()).unwrap(), "Å and é");
        assert_eq!(mapped.spans()[0], SourceSpan { start: 3, end: 6 });
        assert_eq!(mapped.spans()[1], SourceSpan { start: 3, end: 6 });
        let e = mapped
            .bytes()
            .iter()
            .rposition(|byte| *byte == 0xc3)
            .unwrap();
        assert_eq!(mapped.spans()[e], SourceSpan { start: 11, end: 14 });
        assert_eq!(mapped.spans()[e + 1], SourceSpan { start: 11, end: 14 });
    }
}
