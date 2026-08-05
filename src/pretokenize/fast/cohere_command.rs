//! Fast pretokenizer for Cohere Command A+.
//!
//! The source applies `\d{1,3}(?=(?:\d{3})*\b)` first and the o200k
//! pattern second. The first split right-groups a terminal run of Unicode
//! decimal digits. Its word boundary uses letters, marks, all numbers and
//! connector punctuation as word characters.

use super::FastO200kPretokenizer;
use crate::pretokenize::fast::decode_cp;
use crate::pretokenize::unicode::{CommandCharClass, command_class_of};
use crate::pretokenize::{Pretoken, PretokenSpans, SpanBatch};

#[derive(Clone, Copy)]
struct DigitRun {
    start: usize,
    end: usize,
    first_group_chars: usize,
}

pub struct FastCohereCommandPretokenizer<'a> {
    bytes: &'a [u8],
    o200k: Option<FastO200kPretokenizer<'a>>,
    run: Option<DigitRun>,
    run_cursor: usize,
    next_group_chars: usize,
}

impl<'a> FastCohereCommandPretokenizer<'a> {
    #[inline]
    pub fn new(bytes: &'a [u8]) -> Self {
        let mut value = Self {
            bytes,
            o200k: None,
            run: None,
            run_cursor: 0,
            next_group_chars: 0,
        };
        value.reset_at(0);
        value
    }

    fn reset_at(&mut self, pos: usize) {
        self.run = find_next_digit_run(self.bytes, pos);
        let ordinary_end = self.run.map_or(self.bytes.len(), |run| run.start);
        self.o200k = (pos < ordinary_end)
            .then(|| FastO200kPretokenizer::new(&self.bytes[pos..ordinary_end]));
        self.run_cursor = ordinary_end;
        self.next_group_chars = self.run.map_or(0, |run| run.first_group_chars);
    }
}

impl<'a> Iterator for FastCohereCommandPretokenizer<'a> {
    type Item = Pretoken<'a>;

    fn next(&mut self) -> Option<Self::Item> {
        if let Some(o200k) = &mut self.o200k {
            if let Some(token) = o200k.next() {
                return Some(token);
            }
            self.o200k = None;
        }

        let run = self.run?;
        let start = self.run_cursor;
        let end = advance_decimal_chars(self.bytes, start, self.next_group_chars);
        debug_assert!(end <= run.end);
        self.run_cursor = end;
        self.next_group_chars = 3;
        if end == run.end {
            self.reset_at(end);
        }
        Some(Pretoken(&self.bytes[start..end]))
    }
}

// SAFETY: `Iterator::next` returns only nonempty subslices of `self.bytes`,
// and the shared fill helper derives every entry from those live subslices.
unsafe impl<'a> PretokenSpans<'a> for FastCohereCommandPretokenizer<'a> {
    #[inline]
    fn fill_spans_keyed(&mut self, batch: &mut SpanBatch<'a>, prefetch: &impl Fn(u64)) -> usize {
        crate::pretokenize::fill_spans_keyed_with(
            || self.next().map(|token| token.0),
            batch,
            prefetch,
        )
    }
}

#[inline(always)]
fn scalar_class(bytes: &[u8], pos: usize) -> (CommandCharClass, usize) {
    let byte = bytes[pos];
    if byte < 0x80 {
        let class = if byte.is_ascii_digit() {
            CommandCharClass::Decimal
        } else if byte.is_ascii_alphabetic() || byte == b'_' {
            CommandCharClass::Word
        } else {
            CommandCharClass::Other
        };
        return (class, 1);
    }
    // SAFETY: `pos` is in bounds. `decode_cp` bounds every multi-byte read
    // and maps malformed input to an in-range unassigned code point.
    let (cp, len) = unsafe { decode_cp(bytes, pos) };
    (command_class_of(cp), len)
}

fn find_next_digit_run(bytes: &[u8], mut pos: usize) -> Option<DigitRun> {
    while pos < bytes.len() {
        let (class, len) = scalar_class(bytes, pos);
        if class != CommandCharClass::Decimal {
            pos += len;
            continue;
        }

        let start = pos;
        let mut chars = 0;
        while pos < bytes.len() {
            let (class, len) = scalar_class(bytes, pos);
            if class != CommandCharClass::Decimal {
                break;
            }
            pos += len;
            chars += 1;
        }
        let ends_at_word_boundary =
            pos == bytes.len() || scalar_class(bytes, pos).0 == CommandCharClass::Other;
        if ends_at_word_boundary {
            let remainder = chars % 3;
            return Some(DigitRun {
                start,
                end: pos,
                first_group_chars: if remainder == 0 { 3 } else { remainder },
            });
        }
    }
    None
}

fn advance_decimal_chars(bytes: &[u8], mut pos: usize, count: usize) -> usize {
    for _ in 0..count {
        let (class, len) = scalar_class(bytes, pos);
        debug_assert_eq!(class, CommandCharClass::Decimal);
        pos += len;
    }
    pos
}

#[cfg(test)]
mod tests {
    use super::*;
    use icu::properties::props::{EnumeratedProperty, GeneralCategory, GeneralCategoryGroup};

    const O200K: &str = r"[^\r\n\p{L}\p{N}]?[\p{Lu}\p{Lt}\p{Lm}\p{Lo}\p{M}]*[\p{Ll}\p{Lm}\p{Lo}\p{M}]+(?i:'s|'t|'re|'ve|'m|'ll|'d)?|[^\r\n\p{L}\p{N}]?[\p{Lu}\p{Lt}\p{Lm}\p{Lo}\p{M}]+[\p{Ll}\p{Lm}\p{Lo}\p{M}]*(?i:'s|'t|'re|'ve|'m|'ll|'d)?|\p{N}{1,3}| ?[^\s\p{L}\p{N}]+[\r\n/]*|\s*[\r\n]+|\s+(?!\S)|\s+";

    fn reference_tokens(text: &str) -> Vec<String> {
        let second = fancy_regex::Regex::new(O200K).unwrap();
        let mut segments = Vec::<&str>::new();
        let mut cursor = 0;
        let mut scan = 0;
        while scan < text.len() {
            let ch = text[scan..].chars().next().unwrap();
            if GeneralCategory::for_char(ch) != GeneralCategory::DecimalNumber {
                scan += ch.len_utf8();
                continue;
            }
            let run_start = scan;
            let mut boundaries = Vec::new();
            while scan < text.len() {
                let ch = text[scan..].chars().next().unwrap();
                if GeneralCategory::for_char(ch) != GeneralCategory::DecimalNumber {
                    break;
                }
                scan += ch.len_utf8();
                boundaries.push(scan);
            }
            let boundary = text[scan..].chars().next().is_none_or(|next| {
                let category = GeneralCategory::for_char(next);
                !(GeneralCategoryGroup::Letter.contains(category)
                    || GeneralCategoryGroup::Mark.contains(category)
                    || GeneralCategoryGroup::Number.contains(category)
                    || category == GeneralCategory::ConnectorPunctuation)
            });
            if !boundary {
                continue;
            }
            if cursor < run_start {
                segments.push(&text[cursor..run_start]);
            }
            let first = match boundaries.len() % 3 {
                0 => 3,
                value => value,
            };
            let mut group_start = run_start;
            let mut count = first;
            while count <= boundaries.len() {
                let group_end = boundaries[count - 1];
                segments.push(&text[group_start..group_end]);
                group_start = group_end;
                count += 3;
            }
            cursor = scan;
        }
        if cursor < text.len() {
            segments.push(&text[cursor..]);
        }
        segments
            .into_iter()
            .flat_map(|segment| {
                second
                    .find_iter(segment)
                    .map(|matched| matched.unwrap().as_str().to_owned())
                    .collect::<Vec<_>>()
            })
            .collect()
    }

    fn actual_tokens(text: &str) -> Vec<String> {
        FastCohereCommandPretokenizer::new(text.as_bytes())
            .map(|token| String::from_utf8(token.0.to_vec()).unwrap())
            .collect()
    }

    #[test]
    fn matches_source_regex_on_digit_boundaries() {
        let cases = [
            "1234",
            "1234567",
            "a1234 5678-90",
            "1234a 1234_ 1234\u{0301}",
            "1234\u{200c} 1234\u{200d}",
            "١٢٣٤ १२३४ １２３４",
            "1234² 1234Ⅻ ²³⁴⁵",
            "Hello 1234567/世界\n009876",
            "emoji🙂1234-code",
        ];
        for text in cases {
            assert_eq!(actual_tokens(text), reference_tokens(text), "{text:?}");
        }
    }

    #[test]
    fn batch_fill_matches_iterator() {
        let text = "a1234567 世界 ١٢٣٤🙂 1234_ end".repeat(80);
        let expected = actual_tokens(&text);
        let mut scanner = FastCohereCommandPretokenizer::new(text.as_bytes());
        let mut batch = SpanBatch::new();
        let mut actual = Vec::new();
        loop {
            let count = scanner.fill_spans_keyed(&mut batch, &|_| {});
            if count == 0 {
                break;
            }
            for index in 0..count {
                // SAFETY: `index` is below the count returned by this fill.
                let span = unsafe { batch.span(index) };
                actual.push(String::from_utf8(span.to_vec()).unwrap());
            }
        }
        assert_eq!(actual, expected);
    }
}
