use std::collections::BTreeSet;

use crate::{
    DIGEST_RANGE, DecoderStepKind, FORMAT_VERSION, HEADER_LEN, HashScheme, Header, MAGIC,
    MAX_VOCAB_SIZE, NamedPattern, NormStepKind, PostPosition, PretokStepKind, ReadError,
    SECTION_TABLE_ENTRY_LEN, SectionEntry, SectionId, StructuralClass, compute_digest, decode_u32,
};

#[derive(Debug)]
pub struct ValidatedFile<'a> {
    bytes: &'a [u8],
    header: Header,
    sections: Vec<SectionEntry>,
}

impl<'a> ValidatedFile<'a> {
    pub fn read(bytes: &'a [u8]) -> Result<Self, ReadError> {
        let file = Self::read_bounded(bytes)?;
        file.validate_pretok()?;
        file.validate_norm()?;
        file.validate_decoder()?;
        file.validate_post()?;
        file.validate_unk()?;
        file.validate_base()?;
        file.validate_byte_fallback()?;
        let specials = file.validate_specials()?;
        file.validate_lengths(&specials)?;
        file.validate_priority()?;

        if compute_digest(bytes) != file.header.digest {
            return Err(ReadError::DigestMismatch);
        }
        Ok(file)
    }

    /// Parse only the bounds needed to access resolver-owned immutable bytes safely.
    ///
    /// The caller must establish provenance independently. This path does not verify content,
    /// section semantics, or digests.
    #[cfg(feature = "resolver-provenance")]
    pub fn read_resolver_trusted(bytes: &'a [u8]) -> Result<Self, ReadError> {
        Self::read_bounded(bytes)
    }

    fn read_bounded(bytes: &'a [u8]) -> Result<Self, ReadError> {
        let header = read_header(bytes)?;
        let table_start = header.section_table_offset as usize;
        let table_len = (header.section_count as usize)
            .checked_mul(SECTION_TABLE_ENTRY_LEN)
            .ok_or(ReadError::SectionTableOutOfBounds)?;
        let table_end = table_start
            .checked_add(table_len)
            .ok_or(ReadError::SectionTableOutOfBounds)?;
        if table_start < HEADER_LEN {
            return Err(ReadError::SectionTableOverlapsHeader);
        }
        let table = bytes
            .get(table_start..table_end)
            .ok_or(ReadError::SectionTableOutOfBounds)?;

        let mut sections = Vec::with_capacity(header.section_count as usize);
        for entry in table.chunks_exact(SECTION_TABLE_ENTRY_LEN) {
            let id = u32::from_le_bytes(entry[0..4].try_into().expect("fixed table field"));
            let offset = u32::from_le_bytes(entry[4..8].try_into().expect("fixed table field"));
            let length = u64::from_le_bytes(entry[8..16].try_into().expect("fixed table field"));
            if SectionId::from_known(id).is_none() && id < 1024 {
                return Err(ReadError::UnknownSection(id));
            }
            sections.push(SectionEntry { id, offset, length });
        }

        sections.sort_unstable_by_key(|entry| entry.id);
        for pair in sections.windows(2) {
            if pair[0].id == pair[1].id {
                return Err(ReadError::DuplicateSection(pair[0].id));
            }
        }

        validate_presence(header.structural_class, &sections)?;
        validate_section_ranges(bytes.len(), table_start, table_end, &sections)?;

        Ok(Self {
            bytes,
            header,
            sections,
        })
    }

    pub const fn header(&self) -> &Header {
        &self.header
    }

    pub fn section_entry(&self, id: u32) -> Option<&SectionEntry> {
        self.sections
            .binary_search_by_key(&id, |entry| entry.id)
            .ok()
            .map(|index| &self.sections[index])
    }

    pub fn section(&self, id: u32) -> Option<&'a [u8]> {
        let entry = self.section_entry(id)?;
        let start = entry.offset as usize;
        let end = start + entry.length as usize;
        Some(&self.bytes[start..end])
    }

    pub fn sections(&self) -> impl ExactSizeIterator<Item = &SectionEntry> {
        self.sections.iter()
    }

    pub fn lengths(&self) -> LengthIter<'a> {
        LengthIter {
            remaining: self
                .section(SectionId::Lengths.value())
                .expect("validated file has LENGTHS"),
            remaining_count: self.header.vocab_size,
        }
    }

    pub fn tokens(&self) -> TokenIter<'a> {
        TokenIter {
            arena: self
                .section(SectionId::Arena.value())
                .expect("validated file has ARENA"),
            lengths: self.lengths(),
            offset: 0,
            id: 0,
        }
    }

    fn validate_pretok(&self) -> Result<(), ReadError> {
        let section = self
            .section(SectionId::Pretok.value())
            .expect("presence checked");
        let count = section
            .get(..4)
            .map(read_u32)
            .ok_or(ReadError::SectionLengthMismatch(SectionId::Pretok.value()))?;
        if count as usize > section.len().saturating_sub(4) {
            return Err(ReadError::SectionLengthMismatch(SectionId::Pretok.value()));
        }
        let mut cursor = 4_usize;
        for _ in 0..count {
            let kind = *section
                .get(cursor)
                .ok_or(ReadError::SectionLengthMismatch(SectionId::Pretok.value()))?;
            cursor += 1;
            match kind {
                value if value == PretokStepKind::NamedPattern.value() => {
                    let bytes = section
                        .get(cursor..cursor.saturating_add(4))
                        .ok_or(ReadError::SectionLengthMismatch(SectionId::Pretok.value()))?;
                    NamedPattern::try_from(read_u32(bytes))?;
                    cursor += 4;
                }
                value if value == PretokStepKind::ByteLevel.value() => {
                    let flags = *section
                        .get(cursor)
                        .ok_or(ReadError::SectionLengthMismatch(SectionId::Pretok.value()))?;
                    if flags & !0b111 != 0 {
                        return Err(ReadError::InvalidPretokFlags(flags));
                    }
                    cursor += 1;
                }
                value if value == PretokStepKind::Metaspace.value() => {
                    let bytes = section
                        .get(cursor..cursor.saturating_add(4))
                        .ok_or(ReadError::SectionLengthMismatch(SectionId::Pretok.value()))?;
                    let replacement = read_u32(bytes);
                    if char::from_u32(replacement).is_none() {
                        return Err(ReadError::InvalidMetaspaceReplacement(replacement));
                    }
                    cursor += 4;
                }
                value if value == PretokStepKind::Identity.value() => {}
                value => return Err(ReadError::UnknownPretokStep(value)),
            }
        }
        if cursor != section.len() {
            return Err(ReadError::SectionLengthMismatch(SectionId::Pretok.value()));
        }
        Ok(())
    }

    fn validate_norm(&self) -> Result<(), ReadError> {
        let Some(section) = self.section(SectionId::Norm.value()) else {
            return Ok(());
        };
        let (count, mut cursor) = read_step_count(section, SectionId::Norm)?;
        for _ in 0..count {
            let kind = read_byte(section, &mut cursor, SectionId::Norm)?;
            match kind {
                value if value == NormStepKind::Nfc.value() => {}
                value if value == NormStepKind::Replace.value() => {
                    read_utf8(section, &mut cursor, SectionId::Norm)?;
                    read_utf8(section, &mut cursor, SectionId::Norm)?;
                }
                value if value == NormStepKind::Prepend.value() => {
                    read_utf8(section, &mut cursor, SectionId::Norm)?;
                }
                value if value == NormStepKind::StripWhitespace.value() => {}
                value if value == NormStepKind::CollapseWhitespaceRuns.value() => {}
                value => return Err(ReadError::UnknownNormStep(value)),
            }
        }
        require_end(section, cursor, SectionId::Norm)
    }

    fn validate_decoder(&self) -> Result<(), ReadError> {
        let Some(section) = self.section(SectionId::Decoder.value()) else {
            return Ok(());
        };
        let (count, mut cursor) = read_step_count(section, SectionId::Decoder)?;
        for _ in 0..count {
            let kind = read_byte(section, &mut cursor, SectionId::Decoder)?;
            match kind {
                value if value == DecoderStepKind::Replace.value() => {
                    read_utf8(section, &mut cursor, SectionId::Decoder)?;
                    read_utf8(section, &mut cursor, SectionId::Decoder)?;
                }
                value if value == DecoderStepKind::ByteFallback.value() => {}
                value if value == DecoderStepKind::Fuse.value() => {}
                value if value == DecoderStepKind::Strip.value() => {
                    let scalar = read_u32_cursor(section, &mut cursor, SectionId::Decoder)?;
                    if char::from_u32(scalar).is_none() {
                        return Err(ReadError::InvalidUnicodeScalar {
                            section: SectionId::Decoder.value(),
                            value: scalar,
                        });
                    }
                    read_u32_cursor(section, &mut cursor, SectionId::Decoder)?;
                    read_u32_cursor(section, &mut cursor, SectionId::Decoder)?;
                }
                value => return Err(ReadError::UnknownDecoderStep(value)),
            }
        }
        require_end(section, cursor, SectionId::Decoder)
    }

    fn validate_post(&self) -> Result<(), ReadError> {
        let Some(section) = self.section(SectionId::Post.value()) else {
            return Ok(());
        };
        let count = section
            .get(..4)
            .map(read_u32)
            .ok_or(ReadError::SectionLengthMismatch(SectionId::Post.value()))?;
        let expected = 4_usize
            .checked_add(
                (count as usize)
                    .checked_mul(5)
                    .ok_or(ReadError::SectionLengthMismatch(SectionId::Post.value()))?,
            )
            .ok_or(ReadError::SectionLengthMismatch(SectionId::Post.value()))?;
        if section.len() != expected {
            return Err(ReadError::SectionLengthMismatch(SectionId::Post.value()));
        }
        let mut ids = BTreeSet::new();
        for entry in section[4..].chunks_exact(5) {
            match entry[0] {
                value if value == PostPosition::Prepend.value() => {}
                value if value == PostPosition::Append.value() => {}
                value => return Err(ReadError::UnknownPostPosition(value)),
            }
            let id = read_u32(&entry[1..]);
            validate_id(id, self.header.vocab_size, SectionId::Post)?;
            if !ids.insert(id) {
                return Err(ReadError::DuplicateSectionEntry {
                    section: SectionId::Post.value(),
                    id,
                });
            }
        }
        Ok(())
    }

    fn validate_unk(&self) -> Result<(), ReadError> {
        let Some(section) = self.section(SectionId::Unk.value()) else {
            return Ok(());
        };
        if section.len() != 5 {
            return Err(ReadError::SectionLengthMismatch(SectionId::Unk.value()));
        }
        validate_id(read_u32(section), self.header.vocab_size, SectionId::Unk)?;
        if section[4] > 1 {
            return Err(ReadError::InvalidFlagValue {
                section: SectionId::Unk.value(),
                value: section[4],
            });
        }
        Ok(())
    }

    fn validate_base(&self) -> Result<(), ReadError> {
        let section = self
            .section(SectionId::Base.value())
            .expect("presence checked");
        match self.header.structural_class {
            StructuralClass::ByteBpe => {
                if section.len() != 256 * 4 {
                    return Err(ReadError::SectionLengthMismatch(SectionId::Base.value()));
                }
                validate_unique_ids(
                    section.chunks_exact(4).map(read_u32),
                    self.header.vocab_size,
                    SectionId::Base,
                )
            }
            StructuralClass::SentencePieceBpe => {
                let count = section
                    .get(..4)
                    .map(read_u32)
                    .ok_or(ReadError::SectionLengthMismatch(SectionId::Base.value()))?
                    as usize;
                let expected = 4_usize
                    .checked_add(
                        count
                            .checked_mul(8)
                            .ok_or(ReadError::SectionLengthMismatch(SectionId::Base.value()))?,
                    )
                    .ok_or(ReadError::SectionLengthMismatch(SectionId::Base.value()))?;
                if section.len() != expected {
                    return Err(ReadError::SectionLengthMismatch(SectionId::Base.value()));
                }

                let mut previous = None;
                let mut ids = BTreeSet::new();
                for entry in section[4..].chunks_exact(8) {
                    let codepoint = read_u32(&entry[..4]);
                    if previous.is_some_and(|value| codepoint <= value) {
                        return Err(ReadError::UnsortedBase);
                    }
                    previous = Some(codepoint);
                    let id = read_u32(&entry[4..]);
                    validate_id(id, self.header.vocab_size, SectionId::Base)?;
                    if !ids.insert(id) {
                        return Err(ReadError::DuplicateSectionEntry {
                            section: SectionId::Base.value(),
                            id,
                        });
                    }
                }
                Ok(())
            }
        }
    }

    fn validate_byte_fallback(&self) -> Result<(), ReadError> {
        let Some(section) = self.section(SectionId::ByteFall.value()) else {
            return Ok(());
        };
        if section.len() != 256 * 4 {
            return Err(ReadError::SectionLengthMismatch(
                SectionId::ByteFall.value(),
            ));
        }
        validate_unique_ids(
            section.chunks_exact(4).map(read_u32),
            self.header.vocab_size,
            SectionId::ByteFall,
        )
    }

    fn validate_specials(&self) -> Result<Vec<Special<'a>>, ReadError> {
        let section = self
            .section(SectionId::Specials.value())
            .expect("presence checked");
        let count = section
            .get(..4)
            .map(read_u32)
            .ok_or(ReadError::SectionLengthMismatch(
                SectionId::Specials.value(),
            ))?;
        let maximum_count = section.len().saturating_sub(4) / 16;
        if count as usize > maximum_count {
            return Err(ReadError::SectionLengthMismatch(
                SectionId::Specials.value(),
            ));
        }
        let mut cursor = 4_usize;
        let mut ids = BTreeSet::new();
        let mut specials = Vec::with_capacity(count as usize);

        for _ in 0..count {
            let fixed = section.get(cursor..cursor.saturating_add(8)).ok_or(
                ReadError::SectionLengthMismatch(SectionId::Specials.value()),
            )?;
            let id = read_u32(&fixed[..4]);
            let byte_len = read_u32(&fixed[4..]) as usize;
            validate_id(id, self.header.vocab_size, SectionId::Specials)?;
            if !ids.insert(id) {
                return Err(ReadError::DuplicateSectionEntry {
                    section: SectionId::Specials.value(),
                    id,
                });
            }
            cursor += 8;
            let token = section.get(cursor..cursor.saturating_add(byte_len)).ok_or(
                ReadError::SectionLengthMismatch(SectionId::Specials.value()),
            )?;
            cursor += byte_len;
            section.get(cursor..cursor.saturating_add(4)).ok_or(
                ReadError::SectionLengthMismatch(SectionId::Specials.value()),
            )?;
            cursor += 4;
            specials.push(Special { id, token });
        }

        let precedence_len =
            (count as usize)
                .checked_mul(4)
                .ok_or(ReadError::SectionLengthMismatch(
                    SectionId::Specials.value(),
                ))?;
        if cursor.checked_add(precedence_len) != Some(section.len()) {
            return Err(ReadError::SectionLengthMismatch(
                SectionId::Specials.value(),
            ));
        }
        let mut precedence = BTreeSet::new();
        for id_bytes in section[cursor..].chunks_exact(4) {
            let id = read_u32(id_bytes);
            if !ids.contains(&id) {
                return Err(ReadError::IdOutOfRange {
                    section: SectionId::Specials.value(),
                    id,
                });
            }
            if !precedence.insert(id) {
                return Err(ReadError::DuplicateSectionEntry {
                    section: SectionId::Specials.value(),
                    id,
                });
            }
        }
        specials.sort_unstable_by_key(|special| special.id);
        Ok(specials)
    }

    fn validate_lengths(&self, specials: &[Special<'a>]) -> Result<(), ReadError> {
        let section = self
            .section(SectionId::Lengths.value())
            .expect("presence checked");
        let arena = self
            .section(SectionId::Arena.value())
            .expect("presence checked");
        let mut remaining = section;
        let mut sum = 0_u64;
        let mut omega = 0_u32;
        let mut special_index = 0_usize;

        for id in 0..self.header.vocab_size {
            let (length, consumed) = decode_u32(remaining).map_err(|error| ReadError::Varint {
                section: SectionId::Lengths.value(),
                index: id,
                error,
            })?;
            remaining = &remaining[consumed..];
            let start = sum;
            sum = sum
                .checked_add(u64::from(length))
                .ok_or(ReadError::ArenaOffsetOverflow)?;
            if sum > u64::from(u32::MAX) {
                return Err(ReadError::ArenaOffsetOverflow);
            }
            if sum > arena.len() as u64 {
                return Err(ReadError::ArenaIndexOutOfBounds {
                    id,
                    offset: start,
                    length,
                    arena_length: arena.len() as u64,
                });
            }
            omega = omega.max(length);

            while specials
                .get(special_index)
                .is_some_and(|special| special.id == id)
            {
                let special = &specials[special_index];
                if special.token.len() != length as usize
                    || arena.get(start as usize..sum as usize) != Some(special.token)
                {
                    return Err(ReadError::SpecialBytesMismatch(id));
                }
                special_index += 1;
            }
        }

        if !remaining.is_empty() {
            return Err(ReadError::SectionLengthMismatch(SectionId::Lengths.value()));
        }
        if sum != arena.len() as u64 {
            return Err(ReadError::LengthSumMismatch {
                expected: arena.len() as u64,
                actual: sum,
            });
        }
        if omega != self.header.omega {
            return Err(ReadError::OmegaMismatch {
                expected: omega,
                actual: self.header.omega,
            });
        }
        Ok(())
    }

    fn validate_priority(&self) -> Result<(), ReadError> {
        let Some(mut remaining) = self.section(SectionId::Priority.value()) else {
            return Ok(());
        };
        for index in 0..self.header.vocab_size {
            let (_, consumed) = decode_u32(remaining).map_err(|error| ReadError::Varint {
                section: SectionId::Priority.value(),
                index,
                error,
            })?;
            remaining = &remaining[consumed..];
        }
        if !remaining.is_empty() {
            return Err(ReadError::SectionLengthMismatch(
                SectionId::Priority.value(),
            ));
        }
        Ok(())
    }
}

#[derive(Clone, Copy, Debug)]
struct Special<'a> {
    id: u32,
    token: &'a [u8],
}

pub struct LengthIter<'a> {
    remaining: &'a [u8],
    remaining_count: u32,
}

impl Iterator for LengthIter<'_> {
    type Item = u32;

    fn next(&mut self) -> Option<Self::Item> {
        if self.remaining_count == 0 {
            return None;
        }
        let (value, consumed) =
            decode_u32(self.remaining).expect("validated LENGTHS remains valid");
        self.remaining = &self.remaining[consumed..];
        self.remaining_count -= 1;
        Some(value)
    }

    fn size_hint(&self) -> (usize, Option<usize>) {
        let size = self.remaining_count as usize;
        (size, Some(size))
    }
}

impl ExactSizeIterator for LengthIter<'_> {}

pub struct TokenIter<'a> {
    arena: &'a [u8],
    lengths: LengthIter<'a>,
    offset: usize,
    id: u32,
}

impl<'a> Iterator for TokenIter<'a> {
    type Item = (u32, &'a [u8]);

    fn next(&mut self) -> Option<Self::Item> {
        let length = self.lengths.next()? as usize;
        let id = self.id;
        let start = self.offset;
        self.offset += length;
        self.id += 1;
        Some((id, &self.arena[start..self.offset]))
    }

    fn size_hint(&self) -> (usize, Option<usize>) {
        self.lengths.size_hint()
    }
}

impl ExactSizeIterator for TokenIter<'_> {}

fn read_step_count(section: &[u8], id: SectionId) -> Result<(u32, usize), ReadError> {
    let count = section
        .get(..4)
        .map(read_u32)
        .ok_or(ReadError::SectionLengthMismatch(id.value()))?;
    if count as usize > section.len().saturating_sub(4) {
        return Err(ReadError::SectionLengthMismatch(id.value()));
    }
    Ok((count, 4))
}

fn read_byte(section: &[u8], cursor: &mut usize, id: SectionId) -> Result<u8, ReadError> {
    let value = *section
        .get(*cursor)
        .ok_or(ReadError::SectionLengthMismatch(id.value()))?;
    *cursor += 1;
    Ok(value)
}

fn read_u32_cursor(section: &[u8], cursor: &mut usize, id: SectionId) -> Result<u32, ReadError> {
    let bytes = section
        .get(*cursor..cursor.saturating_add(4))
        .ok_or(ReadError::SectionLengthMismatch(id.value()))?;
    *cursor += 4;
    Ok(read_u32(bytes))
}

fn read_utf8<'a>(
    section: &'a [u8],
    cursor: &mut usize,
    id: SectionId,
) -> Result<&'a str, ReadError> {
    let length = read_u32_cursor(section, cursor, id)? as usize;
    let bytes = section
        .get(*cursor..cursor.saturating_add(length))
        .ok_or(ReadError::SectionLengthMismatch(id.value()))?;
    *cursor += length;
    std::str::from_utf8(bytes).map_err(|_| ReadError::InvalidUtf8Section(id.value()))
}

fn require_end(section: &[u8], cursor: usize, id: SectionId) -> Result<(), ReadError> {
    if cursor != section.len() {
        return Err(ReadError::SectionLengthMismatch(id.value()));
    }
    Ok(())
}

fn read_header(bytes: &[u8]) -> Result<Header, ReadError> {
    let header = bytes.get(..HEADER_LEN).ok_or(ReadError::FileTooShort {
        actual: bytes.len(),
    })?;
    if header[..8] != MAGIC {
        return Err(ReadError::MagicMismatch);
    }
    let version = u16::from_le_bytes(header[8..10].try_into().expect("fixed header field"));
    if version != FORMAT_VERSION {
        return Err(ReadError::UnsupportedVersion(version));
    }
    let structural_class = StructuralClass::try_from(header[10])?;
    if header[11] != 0 {
        return Err(ReadError::UnknownLayout(header[11]));
    }
    let hash_scheme = HashScheme::try_from(header[12])?;
    let reserved = u16::from_le_bytes(header[14..16].try_into().expect("fixed header field"));
    if reserved != 0 {
        return Err(ReadError::ReservedHeader(reserved));
    }
    let vocab_size = read_u32(&header[16..20]);
    if vocab_size > MAX_VOCAB_SIZE {
        return Err(ReadError::VocabTooLarge(vocab_size));
    }
    let mut digest = [0_u8; 32];
    digest.copy_from_slice(&header[DIGEST_RANGE]);
    Ok(Header {
        structural_class,
        hash_scheme,
        flags: header[13],
        vocab_size,
        omega: read_u32(&header[20..24]),
        section_count: read_u32(&header[24..28]),
        section_table_offset: read_u32(&header[28..32]),
        digest,
    })
}

fn validate_presence(class: StructuralClass, sections: &[SectionEntry]) -> Result<(), ReadError> {
    for required in SectionId::UNIVERSAL_REQUIRED {
        if sections
            .binary_search_by_key(&required.value(), |entry| entry.id)
            .is_err()
        {
            return Err(ReadError::MissingSection(required));
        }
    }
    let byte_fallback_present = sections
        .binary_search_by_key(&SectionId::ByteFall.value(), |entry| entry.id)
        .is_ok();
    match (class, byte_fallback_present) {
        (StructuralClass::ByteBpe, true) => Err(ReadError::ForbiddenSection {
            section: SectionId::ByteFall,
            class: class as u8,
        }),
        (StructuralClass::SentencePieceBpe, false) => {
            Err(ReadError::MissingSection(SectionId::ByteFall))
        }
        _ => Ok(()),
    }
}

fn validate_section_ranges(
    file_len: usize,
    table_start: usize,
    table_end: usize,
    sections: &[SectionEntry],
) -> Result<(), ReadError> {
    let mut by_offset = sections.to_vec();
    by_offset.sort_unstable_by_key(|entry| (entry.offset, entry.length));

    for entry in &by_offset {
        let start = u64::from(entry.offset);
        let end = start
            .checked_add(entry.length)
            .ok_or(ReadError::SectionOutOfBounds(entry.id))?;
        if end > file_len as u64 {
            return Err(ReadError::SectionOutOfBounds(entry.id));
        }
        if entry.length != 0
            && (ranges_overlap(start, end, 0, HEADER_LEN as u64)
                || ranges_overlap(start, end, table_start as u64, table_end as u64))
        {
            return Err(ReadError::SectionOverlapsMetadata(entry.id));
        }
        if SectionId::from_known(entry.id).is_some_and(SectionId::requires_alignment)
            && entry.offset % 8 != 0
        {
            return Err(ReadError::MisalignedSection(entry.id));
        }
    }

    let nonempty: Vec<_> = by_offset.iter().filter(|entry| entry.length != 0).collect();
    for pair in nonempty.windows(2) {
        let first_end = u64::from(pair[0].offset) + pair[0].length;
        if first_end > u64::from(pair[1].offset) {
            return Err(ReadError::SectionsOverlap {
                first: pair[0].id,
                second: pair[1].id,
            });
        }
    }
    Ok(())
}

fn ranges_overlap(first_start: u64, first_end: u64, second_start: u64, second_end: u64) -> bool {
    first_start < second_end && second_start < first_end
}

fn validate_unique_ids(
    ids: impl Iterator<Item = u32>,
    vocab_size: u32,
    section: SectionId,
) -> Result<(), ReadError> {
    let mut seen = BTreeSet::new();
    for id in ids {
        validate_id(id, vocab_size, section)?;
        if !seen.insert(id) {
            return Err(ReadError::DuplicateSectionEntry {
                section: section.value(),
                id,
            });
        }
    }
    Ok(())
}

fn validate_id(id: u32, vocab_size: u32, section: SectionId) -> Result<(), ReadError> {
    if id >= vocab_size {
        return Err(ReadError::IdOutOfRange {
            section: section.value(),
            id,
        });
    }
    Ok(())
}

fn read_u32(bytes: &[u8]) -> u32 {
    u32::from_le_bytes(bytes[..4].try_into().expect("four-byte integer"))
}
